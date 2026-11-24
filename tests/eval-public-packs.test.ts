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
import { domainsOf, pageTitle, readReferences, urlKey, wgbPackId } from '../src/eval/packs/wildgraphbench.js';
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
  await build('wgb', 'real-wildgraphbench', { from: path.join(FIXTURE, 'wildgraphbench'), domains: ['nature', 'mathematics'] });
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
    // handed to its question a passage needs no name; in a shared corpus an answer must stand in one that names the subject
    expect(logs.ramdocs.join('\n')).toMatch(/1 questions left out — a valid answer given only by passages that do not name the subject/);
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
      '7\t"Who, of ""the two"", was older?"\tA\thttps://en.wikipedia.org/wiki/Lincoln,_Nebraska (NOT REQUIRED, BUT HELPFUL) \thttps://en.wikipedia.org/wiki/B, https://en.wikipedia.org/wiki/C, \tNumerical reasoning | Temporal reasoning\t[\'https://en.wikipedia.org/wiki/Lincoln,_Nebraska\', "https://en.wikipedia.org/wiki/Rock_\'n\'_Roll", \'https://en.wikipedia.org/wiki/D\']'].join('\n');
    expect(readFramesRows(tsv)).toEqual([{
      index: '7', Prompt: 'Who, of "the two", was older?', Answer: 'A', reasoning_types: 'Numerical reasoning | Temporal reasoning',
      // a comma inside a link is the link's; a note after a link and a comma after the last are not
      links: ['https://en.wikipedia.org/wiki/Lincoln,_Nebraska', 'https://en.wikipedia.org/wiki/B', 'https://en.wikipedia.org/wiki/C', "https://en.wikipedia.org/wiki/Rock_'n'_Roll", 'https://en.wikipedia.org/wiki/D'],
    }]);
  });

  it('takes an article\'s title from its link', () => {
    expect(titleOf('https://en.wikipedia.org/wiki/James_A._Garfield')).toBe('James A. Garfield');
    expect(titleOf('https://en.wikipedia.org/wiki/Beyonc%C3%A9#Early_life')).toBe('Beyoncé');
    expect(titleOf('https://en.m.wikipedia.org/wiki/AC/DC')).toBe('AC/DC');
    expect(titleOf('https://en.wikipedia.org/wiki/Lincoln,_Nebraska')).toBe('Lincoln, Nebraska');
    expect(titleOf('https://en.wikipedia.org/w/index.php?title=Bronco&redirect=no')).toBe('Bronco');
    expect(titleOf('https://en.wikipedia.org/w/index.php?search=Bronco&title=Special:Search')).toBeNull();
    expect(titleOf('https://fr.wikipedia.org/wiki/Paris')).toBeNull();
    expect(titleOf('https://example.org/wiki/Paris')).toBeNull();
  });
});

describe('real-wildgraphbench', () => {
  it('puts the cited pages of the chosen domains in one corpus, never the Wikipedia article', () => {
    const p = packs.wgb;
    // the benchmark's order of domains, and the domains in the id when they are not the default three
    expect(p.manifest.id).toBe('real-wildgraphbench-mathematics-nature');
    expect(p.manifest.builder.options).toEqual({ domains: ['mathematics', 'nature'] });
    expect(p.docs).toHaveLength(6);
    for (const d of p.docs) expect(d.path).toMatch(/^pages\/(mathematics|nature)\/[0-9a-f]{12}\.md$/);
    expect(p.docs.map((d) => d.title)).not.toContain('Lattice path');
    expect(p.docs.map((d) => d.title)).toContain('Šafář’s bound on lattice walks');
    // a page that does not open with its title gets its file's name as one
    const survey = p.docs.find((d) => d.title?.startsWith('A survey of enumeration'))!;
    expect(docText(p, survey.path).startsWith('# A survey of enumeration methods for restricted lattice paths in the plane and in\n\nSurvey text')).toBe(true);
    // every file read is a source with its hash: two question files, two reference lists, six pages
    expect(p.manifest.sources).toHaveLength(10);
    for (const s of p.manifest.sources) {
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.license).toContain('Apache-2.0');
    }
    expect(validatePack(p).errors).toEqual([]);
    expect(lintPack(p).findings).toEqual([]);
  });

  it('ties a question\'s URLs to pages by the reference\'s title', () => {
    const p = packs.wgb;
    const titleOf = (t: Task) => t.evidence.map((e) => p.docs.find((d) => d.path === e.doc)!.title);
    // by the archived copy's URL; asked with its topic, which it does not name
    const walks = task(p, (t) => t.id === 'wgb-mathematics-000');
    expect(walks).toMatchObject({
      type: 'single-hop', scoring: 'judge', answer: 'Veld counted 132 such walks.', primary: true,
      question: 'How many six-step walks above the diagonal did Veld count? (Topic: Lattice path.)',
      meta: { source: 'wildgraphbench', domain: 'mathematics', topic: 'Lattice path', datasetType: 'single-fact', family: 'controls', hops: 1, stratum: 'mathematics-single-fact', originalQuestion: 'How many six-step walks above the diagonal did Veld count?' },
    });
    expect(titleOf(walks)).toEqual(['Counting walks on a grid']);
    // a title the file name lost the letters of, a URL written with www. and a slash; the topic is in the question
    const bound = task(p, (t) => t.id === 'wgb-mathematics-001');
    expect(titleOf(bound)).toEqual(['Šafář’s bound on lattice walks']);
    expect(bound.question).toBe('What bound on a lattice path of n steps did Šafář prove?');
    expect(bound.meta?.originalQuestion).toBeUndefined();
    // a title in another script, of which the file name keeps the digits
    expect(titleOf(task(p, (t) => t.id === 'wgb-nature-000'))).toEqual(['颱風「海燕」登陸 氣象台發出12號警報']);
    // a file name cut short, a page without a heading: by the start of the title
    const multi = task(p, (t) => t.id === 'wgb-mathematics-002');
    expect(multi).toMatchObject({ type: 'multi-hop', scoring: 'judge', meta: { datasetType: 'multi-fact', family: 'hops', hops: 2 } });
    expect(titleOf(multi)).toEqual(['Counting walks on a grid', 'A survey of enumeration methods for restricted lattice paths in the plane and in']);
  });

  it('leaves out a question whose page cannot be told, and asks a summary short of one outside the headline', () => {
    const p = packs.wgb;
    // two references titled "Archived" and one saved page; a reference the dataset saved nothing for
    expect(p.tasks.map((t) => t.id)).toEqual(['wgb-mathematics-000', 'wgb-mathematics-001', 'wgb-mathematics-002', 'wgb-mathematics-003', 'wgb-nature-000', 'wgb-nature-001']);
    expect(logs.wgb.join('\n')).toMatch(/2 questions left out — mathematics: no reference page in the corpus/);
    expect(logs.wgb.join('\n')).toMatch(/mathematics \(Lattice path\): 4 pages, 3 tied to one reference of 6; 4 of 6 questions/);
    const methods = task(p, (t) => t.id === 'wgb-mathematics-003');
    expect(methods).toMatchObject({ type: 'global', scoring: 'set', primary: false, meta: { datasetType: 'summary', missingReferences: 1, references: 2, hops: 1 } });
  });

  it('scores a summary as a list of facts against the gold statements', () => {
    const season = task(packs.wgb, (t) => t.id === 'wgb-nature-001');
    expect(season).toMatchObject({ type: 'global', scoring: 'set', primary: true, list: { match: 'judge', ordered: false, maxItems: 20, primary: 'f1' }, meta: { family: 'aggregates', hops: 2 } });
    expect(season.items!.map((i) => i.label)).toEqual(['Nine storms were named in the 2031 season.', 'Haiyen was the costliest storm of the season.', 'Haiyen made landfall on 3 July.']);
    expect(season.question).toBe('Give an overview of the storm season of 2031.');
    expect(taskPrompt(season)).toContain('one item per distinct fact of the answer');
  });

  it('reads the domains option and names the pack by it', () => {
    expect(domainsOf(undefined)).toEqual(['history', 'mathematics', 'nature']);
    expect(wgbPackId(domainsOf(undefined))).toBe('real-wildgraphbench');
    expect(domainsOf('people, human_activities')).toEqual(['human_activities', 'people']);
    expect(wgbPackId(['human_activities', 'people'])).toBe('real-wildgraphbench-human-activities-people');
    expect(domainsOf('all')).toHaveLength(12);
    expect(wgbPackId(domainsOf('all'))).toBe('real-wildgraphbench-all');
    expect(() => domainsOf(['maths'])).toThrow(/domains: one or more of culture/);
    expect(() => domainsOf([])).toThrow();
  });

  it('compares URLs and titles as two references to one page write them', () => {
    expect(urlKey('https://WWW.Example.org/a/B/#top')).toBe('example.org/a/B');
    expect(urlKey('http://example.org/a/B')).toBe('example.org/a/B');
    expect(urlKey('https://example.org/a?x=1')).not.toBe(urlKey('https://example.org/a?x=2'));
    expect(pageTitle('# A title \nbody')).toBe('A title');
    expect(pageTitle('no heading\n# later')).toBeNull();
    const pages = [{ rel: 'r/Report.txt', title: 'Report' }, { rel: 'r/2024.txt', title: '二〇二四年报告 2024' }, { rel: 'r/Other.txt', title: null }];
    const refs = readReferences([
      { title: 'Report', url: 'https://a.example/1', archive_url: 'https://web.archive.org/web/1/https://a.example/1' },
      { title: '二〇二四年报告 2024', url: 'https://b.example/2', archive_url: '' },
      { title: 'Other', url: 'https://c.example/3' },
      { title: 'Other!', url: 'https://d.example/4' },
      { title: 'No page', url: 'https://e.example/5' },
      { title: 'No URL' },
    ].map((r) => JSON.stringify(r)).join('\n'), pages);
    expect(refs.map((r) => r.page)).toEqual(['r/Report.txt', 'r/2024.txt', undefined, undefined, undefined]);
    expect(refs[0].urls).toHaveLength(2);
  });
});
