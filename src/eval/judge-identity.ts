import type { RunMeta } from './runstore.js';

/**
 * One judge a run (docs/design/38 §7, E3). A run's scores are only
 * comparable when one judge gave them; the 31-pack run of 2026-11 had its
 * judge model change four times along the way. So:
 *
 * - On a resume (`eval run --run-dir`, `eval score`), the judge's connection
 *   and label must be the ones `run.json` records; otherwise the run refuses
 *   to go on unless `--allow-judge-change` is given.
 * - While it scores, the model that actually answered each judge call — where
 *   the reply names it (Claude Code's `modelUsage`, carried as
 *   `CallUsage.model`, also through a remote worker that sends it) — must be
 *   the one the run's judge answered with before (`judge.served` in
 *   `run.json`, set by its first reply). A routing layer that swaps the model
 *   underneath the CLI shows up here; a reply that names no model cannot be
 *   checked, and the run counts those (`judge.unnamed`).
 *
 * An allowed change is written to `run.json` (`judgeChanges`) and listed in
 * the report; a refused one stops scoring before the reply is cached, so a
 * resume asks that call again.
 */

export interface JudgeIdentity {
  connection: string;
  label: string;
}

export interface JudgeChange {
  at: string;
  /** `configured`: the judge the command line names differs from the recorded one; `served`: the model answering differs. */
  kind: 'configured' | 'served';
  from: string;
  to: string;
  /** The command that went on with it. */
  by: 'run' | 'score';
}

export class JudgeChangedError extends Error {
  /** Not a reply that failed to parse: the judge's batch does not ask it again in halves. */
  readonly final = true;
  constructor(message: string) {
    super(message);
    this.name = 'JudgeChangedError';
  }
}

const describe = (j: JudgeIdentity) => `${j.connection} (${j.label})`;

/** A model's name as replies give it, with a context-window suffix (`[1m]`) and case left out. */
export function servedName(model: string): string {
  return model.trim().replace(/\[[^\]]*\]$/, '').toLowerCase();
}

/**
 * The resume check: null when the recorded judge is the one given (or the run
 * is new); the change to record when it differs and `allow` is set; a
 * `JudgeChangedError` otherwise.
 */
export function judgeChangeOf(meta: Pick<RunMeta, 'id' | 'judge'> | null, now: JudgeIdentity, allow: boolean, by: JudgeChange['by']): JudgeChange | null {
  if (!meta?.judge) return null;
  const was = { connection: meta.judge.connection, label: meta.judge.label };
  if (was.connection === now.connection && was.label === now.label) return null;
  if (!allow) {
    throw new JudgeChangedError(`run ${meta.id} was judged by ${describe(was)}; this ${by === 'run' ? 'resume' : 'scoring'} would judge with ${describe(now)} — scores from two judges are not comparable: give the recorded judge, or --allow-judge-change to go on and record the change`);
  }
  return { at: new Date().toISOString(), kind: 'configured', from: describe(was), to: describe(now), by };
}

/** Apply an allowed configured change to the run's metadata: the new judge, the change recorded, the served model to be read afresh. */
export function recordJudgeChange(meta: RunMeta, now: JudgeIdentity, change: JudgeChange | null): void {
  if (!change) return;
  meta.judgeChanges = [...(meta.judgeChanges ?? []), change];
  meta.judge = { connection: now.connection, label: now.label };
}

/**
 * Watches the model that answers each judge call (`Judge`'s `served`
 * option): the first named model is recorded; a different one later throws a
 * `JudgeChangedError`, or with `allow` is recorded as a change and becomes the
 * one expected. `save` writes the metadata back (run.json).
 */
export class ServedJudgeGuard {
  constructor(
    private readonly meta: RunMeta,
    private readonly allow: boolean,
    private readonly by: JudgeChange['by'],
    private readonly save: () => void,
    private readonly log: (m: string) => void = () => {},
  ) {}

  /** A reply's model (null: the reply named none). */
  served(model: string | null | undefined): void {
    const j = this.meta.judge;
    if (!model?.trim()) {
      j.unnamed = (j.unnamed ?? 0) + 1;
      return;
    }
    const name = servedName(model);
    if (!j.served) {
      j.served = name;
      this.save();
      return;
    }
    if (j.served === name) return;
    if (!this.allow) {
      throw new JudgeChangedError(`run ${this.meta.id}: the judge's calls were answered by ${j.served}, and this one by ${name} (a routing layer changed the model?) — scoring stops before this verdict is kept; resume with the same model, or with --allow-judge-change to go on and record the change`);
    }
    this.meta.judgeChanges = [...(this.meta.judgeChanges ?? []), { at: new Date().toISOString(), kind: 'served', from: j.served, to: name, by: this.by }];
    this.log(`judge: the model answering changed from ${j.served} to ${name} (allowed, recorded in run.json)`);
    j.served = name;
    this.save();
  }
}
