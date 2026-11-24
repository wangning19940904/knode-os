import type { Command } from 'commander';
import { loadPack } from '../pack.js';
import { writeLearningReport } from './metrics.js';
import { buildLearningStream, Paraphraser, STUB_PARAPHRASER, writeLearningPack } from './stream.js';

/**
 * `knode-os eval learning …` (docs/design/38 §4.3): build a learning pack from
 * a pack, say how many pairs a pack can offer, and report a learning run.
 * Building and counting call no model; a run of the pack is `eval run
 * --suites learning --systems learning [--learning-order <seed>]`.
 */

function paraphraserOf(name: string | undefined): Paraphraser | null {
  if (!name || name === 'none') return null;
  if (name === 'stub') return STUB_PARAPHRASER;
  throw new Error(`--paraphrase ${name}: only "none" and "stub" are built in (a model-backed paraphraser plugs in through Paraphraser, src/eval/learning/stream.ts)`);
}

export function registerLearningCommands(evalCmd: Command, resolvePack: (p: string) => string): void {
  const learning = evalCmd.command('learning').description('the learning suite: a fixed-order question stream with write-back (docs/design/38 §4.3)');

  learning
    .command('pairs')
    .description('how many cold questions and warm pairs (same, paraphrase, near, far, update) each pack can offer — no model')
    .argument('<packs...>', 'pack ids or directories')
    .option('--cold <n>', 'cold questions to draw', '30')
    .option('--seed <s>', 'seed', '0')
    .action((packs: string[], opts: { cold: string; seed: string }) => {
      for (const p of packs) {
        const pack = loadPack(resolvePack(p));
        const s = buildLearningStream(pack, { cold: Number(opts.cold), seed: opts.seed });
        console.log(`${pack.manifest.id}`);
        console.log(`  available: ${Object.entries(s.available).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        console.log(`  drawn (cold ≤ ${opts.cold}): ${Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      }
    });

  learning
    .command('pack')
    .description('write a learning pack: the pack\'s corpus, gold and updates, its tasks replaced by the stream — no model')
    .argument('<pack>', 'pack id or directory')
    .requiredOption('--out <dir>', 'where to write it (must be empty or absent)')
    .option('--cold <n>', 'cold questions', '30')
    .option('--far <n>', 'far controls (default half the cold set)')
    .option('--seed <s>', 'seed the questions are drawn by', '0')
    .option('--paraphrase <kind>', 'paraphrases for cold questions the pack has none for: none (default) or stub (a template, for tests)', 'none')
    .action((p: string, opts: { out: string; cold: string; far?: string; seed: string; paraphrase: string }) => {
      const s = writeLearningPack(loadPack(resolvePack(p)), opts.out, {
        cold: Number(opts.cold), far: opts.far ? Number(opts.far) : undefined, seed: opts.seed, paraphraser: paraphraserOf(opts.paraphrase),
      });
      console.log(`wrote ${opts.out}: ${Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    });

  learning
    .command('report')
    .description('the learning numbers of a run: warm/cold token ratio and correctness by class, contamination, staleness, write-back cost')
    .argument('<runDir>')
    .option('--pack <list>', 'comma-separated pack directories, when the run\'s learning packs are not under the packs directory')
    .action((runDir: string, opts: { pack?: string }) => {
      const r = writeLearningReport(runDir, opts.pack?.split(',').map((p) => resolvePack(p.trim())));
      console.log(`wrote ${r.md} and ${r.json}`);
    });
}
