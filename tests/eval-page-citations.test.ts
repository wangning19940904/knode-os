import { describe, expect, it } from 'vitest';
import type { Judge } from '../src/eval/judge.js';
import { citationScores } from '../src/eval/metrics/retrieval.js';
import { citedDocuments, scoreUsage } from '../src/eval/score/usage.js';
import { catalogFile, catalogText } from '../src/eval/systems/agents.js';
import { pageCitationDocuments, pageCitationsIn } from '../src/eval/systems/knode.js';
import { emptyUsage, type AnswerRecord, type Task } from '../src/eval/types.js';

/*
 * Citations of generated pages (docs/design/38 §7, E6): an answer that cites
 * the summary page of the right document has cited that document. Before,
 * citation precision and recall counted corpus paths alone, and an arm told
 * it may answer from the pages lost on them by construction.
 */

describe('the documents a page citation stands for', () => {
  it('is what a page declares it was made from, else what its lines cite; a navigation page stands for none', () => {
    // a summary page: its `source:` (and knode.inputs.documents), not what its body happens to mention
    expect(pageCitationDocuments('wiki/sources/a.md', ['raw/docs/a.md', 'raw/docs/a.md'], ['raw/docs/b.md'])).toEqual(['a.md']);
    // an entity page declares the entity: each of its lines names the document its claim came from
    expect(pageCitationDocuments('wiki/entities/林晓.md', [], ['raw/docs/email/1.md', 'raw/docs/chat/2.md', 'raw/docs/email/1.md'])).toEqual(['email/1.md', 'chat/2.md']);
    // a source: that is not a corpus document (a dataset page's) declares nothing of the corpus
    expect(pageCitationDocuments('wiki/datasets/x.md', ['crm'], ['raw/docs/c.md'])).toEqual(['c.md']);
    for (const nav of ['wiki/index.md', 'wiki/sources/index.md', 'wiki/log.md', 'wiki/overview.md']) {
      expect(pageCitationDocuments(nav, [], ['raw/docs/a.md']), nav).toEqual([]);
    }
  });

  it('reads the pages an answer cites, in brackets or bare, and maps each', () => {
    const pages = new Map([
      ['wiki/sources/a.md', ['a.md']],
      ['wiki/entities/林晓.md', ['email/1.md', 'gone.md']],
      ['wiki/index.md', []],
    ]);
    const known = new Set(['a.md', 'email/1.md', 'wiki/b.md']);
    const text = [
      '林晓在澜舟 [doc: wiki/sources/a.md, wiki/entities/林晓.md]。',
      '见 wiki/index.md，以及 raw/docs/wiki/b.md（一份名为 wiki/ 的文档目录，不是页面）和 wiki/sources/a.md.',
      '还有 wiki/sources/none.md。',
    ].join('\n');
    expect(pageCitationsIn(text, pages, known)).toEqual([
      { page: 'wiki/sources/a.md', docs: ['a.md'] },
      // kept to the corpus's documents
      { page: 'wiki/entities/林晓.md', docs: ['email/1.md'] },
      { page: 'wiki/index.md', docs: [] },
      // a page the build does not have
      { page: 'wiki/sources/none.md', docs: [] },
    ]);
    expect(pageCitationsIn('[doc: email/1.md]', pages, known)).toEqual([]);
  });
});

const answer = (taskId: string, extra: Partial<AnswerRecord> = {}): AnswerRecord => ({
  key: `${taskId}-${extra.system ?? 'arm'}`, pack: 'p', system: 'arm', taskId, text: 'Final answer: x', finalAnswer: 'x', citations: [], retrieved: [], toolCalls: 0,
  usage: emptyUsage(), ms: 10, at: '2026-11-24T00:00:00.000Z', ...extra,
});
const noJudge = { gradeAnswers: async () => new Map() } as unknown as Judge;
const task: Task = { id: 'q', suite: 'usage', type: 'factoid', question: '?', answer: 'x', scoring: 'value', evidence: [{ doc: 'a.md' }, { doc: 'b.md' }] } as Task;

describe('citation scores with page citations', () => {
  it('count the documents a cited page stands for beside the documents cited', async () => {
    const viaPage = answer('q', { key: 'page', citations: [{ doc: 'c.md' }], pageCitations: [{ page: 'wiki/sources/a.md', docs: ['a.md'] }, { page: 'wiki/index.md', docs: [] }] });
    expect(citedDocuments(viaPage)).toEqual(['c.md', 'a.md']);
    const rs = await scoreUsage({ answers: [viaPage], tasks: new Map([['p|q', task]]), citing: new Set(['arm']) }, noJudge);
    const of = (m: string) => rs.find((r) => r.metric === m);
    expect(of('citation_precision')!.value).toBe(0.5);
    expect(of('citation_recall')!.value).toBe(0.5);
    expect(of('cited_page')!.value).toBe(1);
    expect(of('cited_page')!.detail).toEqual({ pages: ['wiki/sources/a.md', 'wiki/index.md'] });
    // the index stands for no document: as before, it counts for nothing, and it is counted
    expect(of('unmapped_page_citations')!.value).toBe(1);
    expect(of('unmapped_page_citations')!.detail).toEqual({ pages: ['wiki/index.md'] });
  });

  it('record whether an answer cited a page only where the arm records page citations', async () => {
    const none = answer('q', { key: 'none', citations: [{ doc: 'a.md' }], pageCitations: [] });
    const old = answer('q', { key: 'old', citations: [{ doc: 'a.md' }] });
    const notCiting = answer('q', { key: 'other', system: 'grep', pageCitations: [] });
    const rs = await scoreUsage({ answers: [none, old, notCiting], tasks: new Map([['p|q', task]]), citing: new Set(['arm']) }, noJudge);
    // the answer that records none cited no page; the record from before, and a system that cites nothing, get no such score
    expect(rs.filter((r) => r.metric === 'cited_page').map((r) => [r.system, r.value])).toEqual([['arm', 0]]);
    expect(rs.filter((r) => r.metric === 'unmapped_page_citations').map((r) => [r.system, r.value])).toEqual([['arm', 0]]);
  });

  it('leave an answer without page citations scored exactly as before', async () => {
    const cases: Pick<AnswerRecord, 'citations'>[] = [
      { citations: [] },
      { citations: [{ doc: 'a.md' }] },
      { citations: [{ doc: 'a.md' }, { doc: 'a.md' }, { doc: 'z.md' }] },
      { citations: [{ doc: 'b.md' }, { doc: 'a.md' }] },
    ];
    for (const c of cases) {
      const a = answer('q', c);
      const rs = await scoreUsage({ answers: [a], tasks: new Map([['p|q', task]]), citing: new Set(['arm']) }, noJudge);
      const before = citationScores(a.citations.map((x) => x.doc), task.evidence.map((e) => e.doc));
      expect(rs.find((r) => r.metric === 'citation_precision')!.value).toBe(before.precision);
      expect(rs.find((r) => r.metric === 'citation_recall')!.value).toBe(before.recall);
      expect(rs.some((r) => r.metric === 'cited_page' || r.metric === 'unmapped_page_citations')).toBe(false);
    }
  });
});

describe('the catalog beside agent-grep-catalog\'s sources', () => {
  it('lists every document by path, with its title and date from the corpus metadata', () => {
    const text = catalogText([
      { path: 'reports/en/88ee6102cbb1.md', title: 'AAPL annual report, fiscal 2023', date: '2023' },
      { path: 'reports/zh/0a1b.md', title: '600519 2022年年度报告' },
      { path: 'a|b.md', title: 'pipe | in\na title', date: '2024-01-02' },
    ]);
    expect(text).toBe([
      '# Catalog of the source documents',
      '',
      '| path | title | date |',
      '| --- | --- | --- |',
      '| a\\|b.md | pipe \\| in a title | 2024-01-02 |',
      '| reports/en/88ee6102cbb1.md | AAPL annual report, fiscal 2023 | 2023 |',
      '| reports/zh/0a1b.md | 600519 2022年年度报告 |  |',
      '',
    ].join('\n'));
  });

  it('is CATALOG.md unless the corpus has a document of that name', () => {
    expect(catalogFile([{ path: 'a.md' }, { path: 'x/CATALOG.md' }])).toBe('CATALOG.md');
    expect(catalogFile([{ path: 'CATALOG.md' }, { path: 'CATALOG-2.md' }])).toBe('CATALOG-3.md');
  });
});
