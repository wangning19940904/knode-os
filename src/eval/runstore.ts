import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { JudgeAuditRecord } from './judge.js';
import type { AgentSample } from './allocation.js';
import { AnswerRecord, BuildRecord, ScoreRecord } from './types.js';

/**
 * A run's records on disk (`~/knode-eval/runs/<stamp>/`): append-only JSONL,
 * one line per build, answer and score, each under a key made from what it
 * depends on. A resumed run reads the files back and skips every key it
 * already has — an interrupted pilot picks up at the next unanswered task,
 * not at the start.
 */

/**
 * A file's lines, read a block at a time: a JSONL cache can outgrow the longest
 * string V8 can make (about 512 MB), and a run's embedding cache did.
 */
export function* fileLines(file: string, blockBytes = 16 << 20): Generator<string> {
  const fd = fs.openSync(file, 'r');
  try {
    const block = Buffer.allocUnsafe(blockBytes);
    let rest = Buffer.alloc(0);
    for (let n; (n = fs.readSync(fd, block, 0, blockBytes, null)) > 0; ) {
      const data = rest.length ? Buffer.concat([rest, block.subarray(0, n)]) : block.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(10); nl >= 0; nl = data.indexOf(10, start)) {
        yield data.toString('utf8', start, nl);
        start = nl + 1;
      }
      // a copy: the block is read into again
      rest = Buffer.from(data.subarray(start));
    }
    if (rest.length) yield rest.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function recordKey(...parts: (string | number | undefined | null)[]): string {
  return crypto.createHash('sha1').update(parts.map((p) => String(p ?? '')).join('␟')).digest('hex').slice(0, 20);
}

export interface RunMeta {
  id: string;
  createdAt: string;
  gitSha: string | null;
  knodeVersion: string;
  packs: string[];
  systems: string[];
  suites: string[];
  model: { connection: string; label: string; buildEffort: string; answerEffort: string; agents?: string };
  judge: { connection: string; label: string };
  embedding: string;
  fraction: number;
  seed: string | number;
  limit: number | null;
  versions: Record<string, string>;
  /** What each pack staged: documents (padding among them, for a fraction above 1) and characters. */
  staged?: Record<string, { documents: number; padded: number; chars: number; tasks: number }>;
  /** Task types the run was limited to (`--types`). */
  types?: string[];
  notes?: string;
  /** `--repeat`: answers per task, the systems repeated, and the tasks per pack repeats after the first ask (`--repeat-sample`; absent: all). */
  repeat?: { n: number; systems: string[]; sample?: number };
  /** `--remote`: the serve it offered work through, and whether its calls and its judge could leave. */
  remote?: { serve: string; calls: boolean; judge: boolean };
  /**
   * Where the run's work was published and who could take it (docs/design/32),
   * as the latest start of the run set it: `serve`'s broker or the run's own,
   * the run's own slots by CLI (null: none), the pool every piece required,
   * the wait limit in minutes (0: none), and whether an old command line
   * (no `--remote`, no `--local`) sized the slots from `--slots`.
   */
  work?: { broker: 'serve' | 'own'; serve?: string; local: Partial<Record<'codex' | 'claude', number>> | null; pool: string | null; waitMinutes: number; legacy: boolean };
  /** Pieces the latest start of the run left stuck: three different workers could not serve them (docs/design/32 §3). */
  stuck?: { kind: string; label: string; family: string; model: string; eligible: string; pool: string | null; system: string | null; task: string | null; workers: string[]; lastError: string; at: string }[];
  /** Where knode's indexes lived (docs/design/31 D1): `pglite`, or `postgres` with its server and database (never credentials). Absent: a run from before, on PGlite. */
  database?: { kind: string; at: string; poolSize?: number };
  /**
   * Where the run keeps its knode builds (docs/design/35): `root`, one
   * workspace per pack in the evaluation root `evalRoot`, each pointed at by
   * `work/<pack>/<group>/workspace.json`. Absent: a run made before, its builds
   * in `work/<pack>/<group>/ws`.
   */
  workspaces?: 'root';
  evalRoot?: string;
  /** What knode-ask was asked beyond its defaults (KNODE_EVAL_ASK_COMPUTED / KNODE_EVAL_ASK_NOW, docs/design/34): `{}` when neither was set. Absent: no knode-ask in the run. */
  askOptions?: { computed?: boolean; now?: string };
  /** The agent sample (`--agent-limit` and its allocation over task types): what it was, and what each pack took. Absent: a run from before, round-robin. */
  agentSample?: AgentSample;
}

export class RunStore {
  readonly dir: string;
  private builds = new Map<string, BuildRecord>();
  private answers = new Map<string, AnswerRecord>();
  private scores = new Map<string, ScoreRecord>();
  private audits = new Map<string, JudgeAuditRecord>();

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
    for (const r of this.readAll<BuildRecord>('builds.jsonl')) this.builds.set(r.key, r);
    for (const r of this.readAll<AnswerRecord>('answers.jsonl')) this.answers.set(r.key, r);
    for (const r of this.readAll<ScoreRecord>('scores.jsonl')) this.scores.set(r.key, r);
    for (const r of this.readAll<JudgeAuditRecord>('judge-audit.jsonl')) this.audits.set(r.key, r);
  }

  private readAll<T>(name: string): T[] {
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) return [];
    const out: T[] = [];
    for (const line of fileLines(file)) {
      if (!line.trim()) continue;
      // a line cut by a crash mid-write is the only record that can be lost
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  private append(name: string, rec: unknown): void {
    fs.appendFileSync(path.join(this.dir, name), JSON.stringify(rec) + '\n');
  }

  writeMeta(meta: RunMeta): void {
    fs.writeFileSync(path.join(this.dir, 'run.json'), JSON.stringify(meta, null, 2) + '\n');
  }

  meta(): RunMeta | null {
    const file = path.join(this.dir, 'run.json');
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as RunMeta) : null;
  }

  build(key: string): BuildRecord | undefined {
    return this.builds.get(key);
  }

  putBuild(rec: BuildRecord): void {
    this.builds.set(rec.key, rec);
    this.append('builds.jsonl', rec);
  }

  answer(key: string): AnswerRecord | undefined {
    return this.answers.get(key);
  }

  putAnswer(rec: AnswerRecord): void {
    this.answers.set(rec.key, rec);
    this.append('answers.jsonl', rec);
  }

  score(key: string): ScoreRecord | undefined {
    return this.scores.get(key);
  }

  putScore(rec: ScoreRecord): void {
    this.scores.set(rec.key, rec);
    this.append('scores.jsonl', rec);
  }

  /** A verdict judged a second time (`--judge-audit`): written again only when it changed. */
  putJudgeAudit(rec: JudgeAuditRecord): void {
    const had = this.audits.get(rec.key);
    if (had && JSON.stringify({ ...had, at: '' }) === JSON.stringify({ ...rec, at: '' })) return;
    this.audits.set(rec.key, rec);
    this.append('judge-audit.jsonl', rec);
  }

  allJudgeAudits(): JudgeAuditRecord[] {
    return [...this.audits.values()];
  }

  allBuilds(): BuildRecord[] {
    return [...this.builds.values()];
  }

  allAnswers(): AnswerRecord[] {
    return [...this.answers.values()];
  }

  allScores(): ScoreRecord[] {
    return [...this.scores.values()];
  }

  /** A line of the run's own log, for what happened between records (pauses, skips, failures). */
  log(event: string, detail: Record<string, unknown> = {}): void {
    this.append('events.jsonl', { at: new Date().toISOString(), event, ...detail });
  }

  /** A per-system working directory under the run (a knode workspace, a wiki, a venv's index). */
  workDir(...parts: string[]): string {
    const dir = path.join(this.dir, 'work', ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  cacheDir(): string {
    const dir = path.join(this.dir, 'cache');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
