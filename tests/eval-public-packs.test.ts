import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintPack } from '../src/eval/lint.js';
import { docText, type LoadedPack, loadPack, validatePack } from '../src/eval/pack.js';
import { parseTsv, readFramesRows, titleOf } from '../src/eval/packs/frames.js';
import { recipe } from '../src/eval/packs/index.js';
import { chooseIsolated, type RamdocsRow, spaced, subjectOf } from '../src/eval/packs/ramdocs.js';
import '../src/eval/packs/recipes.js';
import { taskPrompt } from '../src/eval/prompts.js';
import type { Task } from '../src/eval/types.js';

/**
 * The published-benchmark recipes that fetch their own sources (RAMDocs,
 * FRAMES in a shared pool, WildGraphBench), built offline from small
 * committed fixtures in each dataset's own layout: invented text, never the
 * downloads themselves. `from` points a recipe at a local copy.
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'public-packs');
const REAL = path.join(__dirname, 'fixtures', 'real-docs');
let tmp: string;
const packs: Record<string, LoadedPack> = {};
const logs: Record<string, string[]> = {};
const task = (p: LoadedPack, pred: (t: Task) => boolean) => {
  const t = p.tasks.find(pred);
  expect(t).toBeDefined();
  return t!;
};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-public-'));
  // the fetcher keeps Wikipedia revisions gzipped; the fixture keeps them readable
  const wiki = path.join(tmp, 'wikipedia-revisions');
  fs.cpSync(path.join(REAL, 'wikipedia-revisions'), wiki, { recursive: true });
  for (const f of fs.readdirSync(path.join(wiki, 'pages'))) {
    fs.writeFileSync(path.join(wiki, 'pages', `${f}.gz`), zlib.gzipSync(fs.readFileSync(path.join(wiki, 'pages', f))));
    fs.rmSync(path.join(wiki, 'pages', f));
  }
  const build = async (name: string, id: string, options: Record<string, unknown>) => {
    const out = path.join(tmp, 'packs', name);
    logs[name] = [];
    const issues = await recipe(id).build(out, { seed: 0, log: (m) => logs[name].push(m), options });
    expect(issues.errors).toEqual([]);
    packs[name] = loadPack(out);
  };
  await build('ramdocs', 'public-ramdocs', { from: path.join(FIXTURE, 'ramdocs') });
  await build('frames', 'public-frames', { from: path.join(REAL, 'frames'), wikipedia: wiki });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('public-ramdocs', () => {
  const rows = () => fs.readFileSync(path.join(FIXTURE, 'ramdocs', 'RAMDocs_test.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RamdocsRow);

  it('reads the name a question\'s entities share from the question', () => {
    expect(subjectOf({ question: 'In which year was Orla Venn born?', disambig_entity: ['Orla Venn (cellist)', 'Orla Venn (cartographer)'] })).toBe('orla venn');
    expect(subjectOf({ question: 'What is the population of Springfield?', disambig_entity: ['Springfield, Illinois', 'Springfield, Massachusetts'] })).toBe('springfield');
    // the longest shared run, not a word of it
    expect(subjectOf({ question: 'When was Tarnwick Bridge opened?', disambig_entity: ['Tarnwick Bridge (Ohio)', 'Tarnwick Bridge (Kent)'] })).toBe('tarnwick bridge');
    expect(subjectOf({ question: 'Where is it located?', disambig_entity: ['Marrow Hill'] })).toBeNull();
  });

  it('pools only questions whose subjects no other question\'s passages name', () => {
    const p = packs.ramdocs;
    // Orla Venn is asked about twice and Tarnwick is named in the passages about its bridge: one of each pair is taken
    const taken = p.tasks.map((t) => Number(t.meta?.datasetIndex));
    expect(taken).toHaveLength(3);
    expect(taken).toContain(2);
    expect(taken.filter((i) => i === 0 || i === 4)).toHaveLength(1);
    expect(taken.filter((i) => i === 1 || i === 3)).toHaveLength(1);
    // the rule itself, read back from the pack: a task's subject stands in none of the passages that are not its own
    const own = new Map(p.tasks.map((t) => [t.id, new Set(rows()[Number(t.meta?.datasetIndex)].documents.map((d) => `${d.text.trim()}\n`))]));
    for (const t of p.tasks) {
      expect(t.closedWorld?.terms).toEqual([t.meta?.subject]);
      for (const d of p.docs) {
        const text = docText(p, d.path);
        if (!own.get(t.id)!.has(text)) expect(spaced(text)).not.toContain(` ${String(t.meta?.subject)} `);
      }
    }
    // a valid answer no passage is marked as giving, and a question that names none of its entities, are left out
    expect(logs.ramdocs.join('\n')).toMatch(/1 questions left out — a valid answer none of its passages is marked as giving/);
    expect(logs.ramdocs.join('\n')).toMatch(/1 questions left out — a question that does not name what its entities share/);
    expect(logs.ramdocs.join('\n')).toMatch(/2 questions left out — a subject another taken question's passages name/);
  });

  it('takes each side of a pair when it comes first, never both', () => {
    const all = rows();
    for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const taken = chooseIsolated(all, Infinity, seed).taken.map((c) => c.index);
      expect(taken.filter((i) => i === 0 || i === 4)).toHaveLength(1);
      expect(taken.filter((i) => i === 1 || i === 3)).toHaveLength(1);
    }
    expect(chooseIsolated(all, 1, 0).taken).toHaveLength(1);
  });

  it('scores by the dataset\'s strict match and types by what the passages hold', () => {
    const p = packs.ramdocs;
    const film = task(p, (t) => t.meta?.datasetIndex === 2);
    expect(film).toMatchObject({
      type: 'single-hop', scoring: 'set', primary: true, list: { match: 'alias', primary: 'complete' },
      meta: { source: 'ramdocs', subject: 'glass harbor', readings: 1, distractors: [], documents: { correct: 1, misinfo: 0, noise: 1 }, stratum: '1-valid', originalQuestion: 'Who directed Glass Harbor?' },
    });
    expect(film.items!.map((i) => i.label)).toEqual(['Ines Okoro']);
    expect(film.evidence).toEqual([{ doc: film.items![0].docs![0], quote: 'Ines Okoro' }]);
    expect(taskPrompt(film)).toContain('give the answer for each as its own item');
    for (const t of p.tasks) {
      const i = Number(t.meta?.datasetIndex);
      if (i === 0) {
        // two readings, each with the passages that give it; the misinformation's answer is the distractor
        expect(t).toMatchObject({ type: 'ambiguous', meta: { readings: 2, distractors: ['1950'], stratum: '2-valid-misinfo' } });
        expect(t.items!.map((it) => [it.label, it.docs!.length])).toEqual([['1923', 2], ['1977', 1]]);
        expect(t.evidence).toHaveLength(3);
      }
      if (i === 1) expect(t).toMatchObject({ type: 'conflict', meta: { distractors: ['9,900'], stratum: '1-valid-misinfo' } });
      if (i === 3) expect(t).toMatchObject({ type: 'ambiguous', meta: { readings: 2, stratum: '2-valid' } });
    }
  });

  it('keeps a passage\'s role out of the corpus and passes validate and lint', () => {
    const p = packs.ramdocs;
    for (const d of p.docs) {
      expect(d.path).toMatch(/^passages\/[0-9a-f]{12}\.md$/);
      expect(d).toEqual({ path: d.path, lang: 'en', source: 'ramdocs', kind: 'passage' });
    }
    expect(p.manifest.sources).toHaveLength(1);
    expect(p.manifest.sources[0]).toMatchObject({ license: expect.stringContaining('MIT') });
    expect(p.manifest.sources[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validatePack(p).errors).toEqual([]);
    expect(lintPack(p).findings).toEqual([]);
  });
});

describe('public-frames', () => {
  it('pools the sampled questions\' articles and no others', () => {
    const p = packs.frames;
    // the second question links an article that cannot be had: passed over
    expect(p.tasks).toHaveLength(1);
    expect(logs.frames.join('\n')).toMatch(/1 questions passed over — a linked article that was not fetched/);
    const t = p.tasks[0];
    expect(t).toMatchObject({
      id: 'frames-000', suite: 'usage', type: 'multi-hop', scoring: 'judge', answer: 'Jane Ballou', primary: true,
      meta: { source: 'frames', hops: 2, datasetType: 'Multiple constraints', reasoningTypes: ['Multiple constraints'] },
    });
    // real-wiki-hops keeps every fetched article; the pool holds only what a sampled question links
    expect(p.docs.map((d) => d.title).sort()).toEqual(['Harriet Lane', 'James A. Garfield']);
    expect(new Set(t.evidence.map((e) => e.doc))).toEqual(new Set(p.docs.map((d) => d.path)));
    const lane = p.docs.find((d) => d.title === 'Harriet Lane')!;
    expect(lane).toMatchObject({ date: '2023-11-01', kind: 'article', source: 'wikipedia' });
    expect(lane.path).toMatch(/^wiki\/[0-9a-f]{12}\.md$/);
    expect(docText(p, lane.path)).toContain('# Harriet Lane\n\nWikipedia, revision 104 of 2023-11-01');
    expect(p.manifest.sources[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validatePack(p).errors).toEqual([]);
    expect(lintPack(p).findings).toEqual([]);
  });

  it('reads quoted cells and every link a row names', () => {
    expect(parseTsv('a\tb\n"x ""y""\nz"\t1\n\n2\t"q\tr"\n')).toEqual([['a', 'b'], ['x "y"\nz', '1'], ['2', 'q\tr']]);
    // a quote inside a cell that does not open with one is text
    expect(parseTsv('the "long" way\tb')).toEqual([['the "long" way', 'b']]);
    const tsv = ['\tPrompt\tAnswer\twikipedia_link_1\twikipedia_link_11+\treasoning_types\twiki_links',
      '7\t"Who, of ""the two"", was older?"\tA\thttps://en.wikipedia.org/wiki/A\thttps://en.wikipedia.org/wiki/B, https://en.wikipedia.org/wiki/C\tNumerical reasoning | Temporal reasoning\t[\'https://en.wikipedia.org/wiki/A\', \'https://en.wikipedia.org/wiki/D\']'].join('\n');
    expect(readFramesRows(tsv)).toEqual([{
      index: '7', Prompt: 'Who, of "the two", was older?', Answer: 'A', reasoning_types: 'Numerical reasoning | Temporal reasoning',
      links: ['https://en.wikipedia.org/wiki/A', 'https://en.wikipedia.org/wiki/B', 'https://en.wikipedia.org/wiki/C', 'https://en.wikipedia.org/wiki/D'],
    }]);
  });

  it('takes an article\'s title from its link', () => {
    expect(titleOf('https://en.wikipedia.org/wiki/James_A._Garfield')).toBe('James A. Garfield');
    expect(titleOf('https://en.wikipedia.org/wiki/Beyonc%C3%A9#Early_life')).toBe('Beyoncé');
    expect(titleOf('https://en.m.wikipedia.org/wiki/AC/DC')).toBe('AC/DC');
    expect(titleOf('https://fr.wikipedia.org/wiki/Paris')).toBeNull();
    expect(titleOf('https://example.org/wiki/Paris')).toBeNull();
  });
});
