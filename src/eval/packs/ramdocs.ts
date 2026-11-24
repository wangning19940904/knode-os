import fs from 'node:fs';
import { normalizeAnswer } from '../metrics/text.js';
import { foldSpace, stratified } from '../pack.js';
import type { Task } from '../types.js';
import { datasetFile } from './fetch.js';
import { registerRecipe, RecipeContext } from './index.js';
import { finishRealPack, opaquePath, questionCount, shortHash } from './real-docs.js';
import { PackWriter } from './writer.js';

/**
 * public-ramdocs: RAMDocs (Wang, Prasad, Stengel-Eskin & Bansal, 2025, arXiv
 * 2504.13079; MIT; built on AmbigDocs) — 500 questions about a name that
 * several things share, each with its own 5.5 passages on average: passages
 * that answer it for one of the things (`correct`), passages in which the
 * answer was replaced by a wrong one (`misinfo`), and passages that do not
 * answer it (`noise`). A question has one to three valid answers (2.2 on
 * average) and 0.86 wrong ones. No model is used: questions, answers and the
 * role of every passage are the dataset's.
 *
 * **One pooled corpus, shown not to change the gold.** The dataset hands each
 * question its own passages, and a question's gold is what those passages
 * support: a passage of another question about one more thing of the same
 * name would add a valid answer the gold does not hold. So the sampled
 * questions share one corpus (retrieval is part of what is measured) only
 * under a check made at build time, without a model: a question is taken only
 * if no passage of another taken question names its subject — the name its
 * `disambig_entity` entries share, as the question writes it — and none of its
 * own passages names the subject of another. A passage that never names the
 * subject says nothing about anything called that, so it can add neither a
 * valid answer nor a wrong one, nor support either. Questions that fail are
 * left out and counted in the build log; each task records its subject as a
 * closed-world term, so `pack validate` holds padding to the same rule. What
 * the check does not see is a passage that speaks of the subject under
 * another name.
 *
 * **Task types.** Two or three valid answers: `ambiguous` (`meta.readings`).
 * One valid answer beside misinformation: `conflict`; one and none:
 * `single-hop`. `contradiction` is not used: that type asks for every side of
 * a disagreement with its documents and credits naming the wrong side, which
 * is what this dataset counts as an error (and it needs evidence in five
 * documents, more than most questions have).
 *
 * **Scoring** is the dataset's strict exact match, without a judge: the
 * answer lists the valid answers, one item each, and is right only when every
 * one is there and no item names a wrong answer (`list.primary` complete,
 * the wrong answers in `meta.distractors`; `distractor_rate` reports them).
 * The paper reads the whole reply for the answer strings; here the reply's
 * item list is read, each string as a whole term.
 *
 * **Comparable numbers.** The paper's RAMDocs column (its Table 2, exact
 * match over all 500): with every passage of the question in the prompt,
 * Llama3.3-70B 32.6, Qwen2.5-72B 20.6, GPT-4o-mini 25.0; MADAM-RAG 34.4, 26.4
 * and 28.0; no documents 5.8, 4.2 and 2.5. Those systems are handed exactly
 * the question's passages. Here a system has to find them among every
 * sampled question's, on a sample (100 by default) that leaves out the
 * questions failing the check above: the metric is the same, the setting is
 * not, and a number here is not a number on their table.
 */

export interface RamdocsRow {
  question: string;
  documents: { text: string; type: string; answer: string }[];
  disambig_entity: string[];
  gold_answers: string[];
  wrong_answers: string[];
}

const REVISION = '9c041bfd158c603b615883d9a931b00cbc141494';
const URL = `https://huggingface.co/datasets/HanNight/RAMDocs/resolve/${REVISION}/RAMDocs_test.jsonl`;
const LICENSE = 'MIT (RAMDocs); passages from Wikipedia via AmbigDocs';
const INSTRUCTION = 'If the name refers to more than one thing, give the answer for each as its own item, and leave out an answer you judge a source to have wrong.';

const STOP = new Set('a an the of in on at to for from by with and or is are was were be been do does did what which who whom whose when where why how many much that this it its as'.split(' '));
const words = (s: string) => normalizeAnswer(s).split(' ').filter(Boolean);
/** A text as the isolation check reads it: words between single spaces, with one at each end. */
export const spaced = (s: string) => ` ${normalizeAnswer(s)} `;

/**
 * The name a question's entities share, as the question writes it: the
 * longest run of the question's words that stands in every `disambig_entity`
 * entry (in most of them, when none stands in all). Null when the question
 * names none of them: such a question cannot be shown to be isolated.
 */
export function subjectOf(row: Pick<RamdocsRow, 'question' | 'disambig_entity'>): string | null {
  const q = words(row.question);
  const entities = row.disambig_entity.map(spaced).filter((e) => e.trim());
  if (!entities.length) return null;
  let best: { run: string; hits: number } | null = null;
  for (let i = 0; i < q.length; i++) {
    if (STOP.has(q[i])) continue;
    for (let j = Math.min(q.length, i + 8); j > i; j--) {
      if (STOP.has(q[j - 1])) continue;
      const run = q.slice(i, j).join(' ');
      // a name, not a stray short word
      if (run.replace(/ /g, '').length < 3) continue;
      const hits = entities.filter((e) => e.includes(` ${run} `)).length;
      if (!hits) continue;
      if (!best || hits > best.hits || (hits === best.hits && run.length > best.run.length)) best = { run, hits };
    }
  }
  return best && best.hits * 2 >= entities.length ? best.run : null;
}

interface Candidate {
  row: RamdocsRow;
  index: number;
  subject: string;
  /** Its passages as the check reads them. */
  texts: string[];
}

export interface RamdocsChoice {
  taken: Candidate[];
  left: Record<string, number>;
}

/** What makes a row unusable whatever the others are, or null. */
function unusable(row: RamdocsRow): string | null {
  const gold = row.gold_answers.map(normalizeAnswer);
  if (!gold.length || gold.some((g) => !g)) return 'no valid answer';
  if (row.wrong_answers.some((w) => gold.includes(normalizeAnswer(w)))) return 'a wrong answer that is also a valid one';
  const supported = new Set(row.documents.filter((d) => d.type === 'correct').map((d) => normalizeAnswer(d.answer)));
  if (gold.some((g) => !supported.has(g))) return 'a valid answer none of its passages is marked as giving';
  return null;
}

/**
 * The questions that share one corpus: in seeded order across strata (how
 * many valid answers, with or without misinformation), each taken only when
 * its subject is named in no passage of those already taken and theirs in
 * none of its own.
 */
export function chooseIsolated(rows: RamdocsRow[], want: number, seed: string | number, maxDocs = Infinity): RamdocsChoice {
  const left: Record<string, number> = {};
  const leave = (why: string) => (left[why] = (left[why] ?? 0) + 1);
  const taken: Candidate[] = [];
  const texts = new Set<string>();
  const order = stratified(rows.map((row, index) => ({ row, index })), ({ row }) => stratumOf(row), ({ index }) => String(index), seed);
  for (const { row, index } of order) {
    if (taken.length >= want) break;
    const bad = unusable(row);
    if (bad) {
      leave(bad);
      continue;
    }
    const subject = subjectOf(row);
    if (!subject) {
      leave('a question that does not name what its entities share');
      continue;
    }
    const mine = row.documents.map((d) => spaced(d.text));
    const term = ` ${subject} `;
    if (taken.some((t) => t.subject === subject || t.texts.some((x) => x.includes(term)) || mine.some((x) => x.includes(` ${t.subject} `)))) {
      leave('a subject another taken question\'s passages name (or the other way round)');
      continue;
    }
    const fresh = new Set(mine.filter((x) => !texts.has(x))).size;
    if (texts.size + fresh > maxDocs) continue;
    mine.forEach((x) => texts.add(x));
    taken.push({ row, index, subject, texts: mine });
  }
  // the dataset's order in the pack; the sample is only a choice
  return { taken: taken.sort((a, b) => a.index - b.index), left };
}

const stratumOf = (row: RamdocsRow) => `${row.gold_answers.length}-valid${row.documents.some((d) => d.type === 'misinfo') ? '-misinfo' : ''}`;

export function ramdocsTask(c: Candidate, pathOf: (text: string) => string): Task {
  const { row } = c;
  const correct = row.documents.filter((d) => d.type === 'correct');
  const count = (type: string) => row.documents.filter((d) => d.type === type).length;
  const items = row.gold_answers.map((answer) => ({
    label: answer.trim(), aliases: [], weight: 1,
    docs: [...new Set(correct.filter((d) => normalizeAnswer(d.answer) === normalizeAnswer(answer)).map((d) => pathOf(d.text)))],
  }));
  // the passage's own words for its answer, where it writes the answer as the dataset does
  const evidence = [...new Map(correct.map((d) => [pathOf(d.text), { doc: pathOf(d.text), ...(d.answer.trim() && foldSpace(d.text).includes(foldSpace(d.answer)) ? { quote: foldSpace(d.answer) } : {}) }])).values()];
  const readings = row.gold_answers.length;
  const misinfo = count('misinfo');
  return {
    id: `ramdocs-${String(c.index).padStart(3, '0')}-${shortHash(row.question).slice(0, 4)}`, suite: 'usage',
    type: readings > 1 ? 'ambiguous' : misinfo ? 'conflict' : 'single-hop', lang: 'en',
    question: `${row.question.trim()} ${INSTRUCTION}`, scoring: 'set', items,
    list: { match: 'alias', ordered: false, maxItems: 10, requireDocs: false, primary: 'complete' },
    evidence, primary: true, closedWorld: { terms: [c.subject], prefixes: [] },
    meta: {
      source: 'ramdocs', datasetIndex: c.index, originalQuestion: row.question.trim(), subject: c.subject, entities: row.disambig_entity,
      readings, distractors: row.wrong_answers.map((w) => w.trim()).filter(Boolean), documents: { correct: correct.length, misinfo, noise: count('noise') },
      stratum: stratumOf(row),
    },
  };
}

async function buildRamdocs(dir: string, ctx: RecipeContext) {
  const want = questionCount({ ...ctx, options: { questions: ctx.options.questions ?? 100 } }) ?? Infinity;
  const seed = ctx.seed ?? 0;
  const src = await datasetFile({ url: URL, from: ctx.options.from ? String(ctx.options.from) : undefined, rel: 'RAMDocs_test.jsonl', license: LICENSE, name: `HanNight__RAMDocs/${REVISION.slice(0, 8)}/RAMDocs_test.jsonl` });
  const rows = fs.readFileSync(src.file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as RamdocsRow);
  const { taken, left } = chooseIsolated(rows, want, seed, ctx.limit);
  for (const [why, n] of Object.entries(left)) ctx.log(`RAMDocs: ${n} questions left out — ${why}`);
  if (Number.isFinite(want) && taken.length < want) ctx.log(`RAMDocs: ${taken.length} of the ${want} questions asked for can share one corpus`);

  const pathOf = (text: string) => opaquePath('passages', text);
  const writer = new PackWriter(dir, {
    id: 'public-ramdocs',
    version: 1,
    title: 'RAMDocs: questions about a shared name over passages that conflict, mislead and distract',
    domain: 'public',
    languages: ['en'],
    description: `${taken.length} of RAMDocs's ${rows.length} questions with every passage each comes with (correct, misinformation and noise), as one corpus. A question is taken only if no other taken question's passage names its subject, nor its own passages another's, so sharing the corpus cannot add an answer to any gold. Scored by the dataset's strict exact match: every valid answer listed and no wrong one.`,
    builder: { recipe: 'public-ramdocs', options: { questions: Number.isFinite(want) ? want : 'all' } },
  });
  writer.addSource({ ...src.record, note: [src.record.note, 'RAMDocs test set (Wang et al., 2025), 500 questions'].filter(Boolean).join('; ') });
  const written = new Set<string>();
  for (const c of taken) for (const d of c.row.documents) {
    const p = pathOf(d.text);
    if (written.has(p)) continue;
    written.add(p);
    // nothing of the passage's role (correct, misinformation, noise) goes into the corpus or its listing
    writer.addDoc({ path: p, lang: 'en', source: 'ramdocs', kind: 'passage' }, `${d.text.trim()}\n`);
  }
  const tasks = taken.map((c) => ramdocsTask(c, pathOf));
  const by = (type: string) => tasks.filter((t) => t.type === type).length;
  ctx.log(`RAMDocs: ${tasks.length} questions (${by('ambiguous')} ambiguous, ${by('conflict')} conflict, ${by('single-hop')} single-hop) over ${written.size} passages`);
  return finishRealPack(writer, tasks, ctx);
}

export function registerRamdocsRecipe(): void {
  registerRecipe({ id: 'public-ramdocs', title: 'RAMDocs: ambiguity, misinformation and noise; strict exact match (all valid answers, no wrong one)', domain: 'public', network: true, needsAuthor: false, build: buildRamdocs });
}
