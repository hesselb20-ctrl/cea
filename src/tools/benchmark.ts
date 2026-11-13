import fs from 'node:fs';
import os from 'node:os';
import { z } from 'zod';
import { compileTo, DEFAULT_RUN, FlagsSchema, materialize, RunSpecSchema, runProgram, SourceSchema } from '../core/build.js';
import { defineTool } from '../core/context.js';
import { CeaError } from '../core/errors.js';
import type { CompilerInfo } from '../core/toolbox.js';
import { median, normalizeNewlines, preview, quantile, round, sha256 } from '../core/util.js';

export interface Stats {
  runs: number;
  median_ms: number;
  min_ms: number;
  max_ms: number;
  mean_ms: number;
  stddev_ms: number;
  mad_ms: number;
  iqr_ms: number;
  cv_percent: number;
}

export function computeStats(samples: number[]): Stats {
  const n = samples.length;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const med = median(samples);
  return {
    runs: n,
    median_ms: round(med),
    min_ms: round(Math.min(...samples)),
    max_ms: round(Math.max(...samples)),
    mean_ms: round(mean),
    stddev_ms: round(Math.sqrt(variance)),
    mad_ms: round(median(samples.map((x) => Math.abs(x - med)))),
    iqr_ms: round(quantile(samples, 0.75) - quantile(samples, 0.25)),
    cv_percent: round(mean > 0 ? (Math.sqrt(variance) / mean) * 100 : 0, 2),
  };
}

function governor(): string {
  try {
    return fs.readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor', 'utf8').trim();
  } catch {
    return 'unknown (not readable on this OS)';
  }
}

export const benchmark = defineTool({
  name: 'benchmark',
  family: 'performance',
  title: 'Benchmark',
  description:
    'Build one or more variants of a program, check that they all print the same output, and time repeated runs with warm-up: median, spread and machine details. ' +
    'A speed claim is only reported as distinguishable when the run-time ranges do not overlap. Wrong output disqualifies a variant: semantics before speed.',
  input: z.strictObject({
    source: SourceSchema,
    variants: z.array(z.strictObject({
      name: z.string().min(1).max(40).regex(/^[A-Za-z0-9._+-]+$/),
      compiler: z.string().min(1).default('clang'),
      flags: FlagsSchema.default(['-O2']),
      source: SourceSchema.optional().describe('Different source for this variant (e.g. the version with restrict). Default: the top-level source.'),
    })).min(1).max(8).describe('First variant is the baseline.'),
    runs: z.number().int().min(5).max(200).default(10).describe('Timed runs per variant. Fewer than 5 is refused: no spread, no claim.'),
    warmup: z.number().int().min(0).max(20).default(2),
    run: RunSpecSchema.default({ ...DEFAULT_RUN, timeout_s: 60 }),
    expected_stdout: z.string().max(1_000_000).optional().describe('If given, every variant must print exactly this. Otherwise all variants must agree with the baseline.'),
  }),
  async run(input, ev) {
    const top = materialize(ev, input.source);
    const built: { name: string; exe: string; compiler: CompilerInfo; flags: string[] }[] = [];
    const rows: Record<string, Record<string, unknown>> = {};
    for (const [i, v] of input.variants.entries()) {
      const compiler = await ev.compiler(v.compiler);
      const src = v.source ? materialize(ev, v.source, `input-${v.name}`) : top;
      const b = await compileTo(ev, { compiler, source: src, flags: v.flags, kind: 'exe', outBase: `bench-${i}-${v.name}`, purpose: `build ${v.name}` });
      rows[v.name] = { compiler: compiler.version, flags: v.flags, built: b.ok };
      if (!b.ok) {
        rows[v.name]!['stderr_preview'] = preview(b.exec.stderr, 10);
        continue;
      }
      built.push({ name: v.name, exe: b.outPath, compiler, flags: v.flags });
    }
    if (built.length === 0) throw new CeaError('TOOL_FAILED', 'no variant compiled', 'See the stderr views of this record.');

    // Correctness first.
    const wanted = input.expected_stdout !== undefined ? sha256(normalizeNewlines(input.expected_stdout)) : null;
    let reference: string | null = wanted;
    const valid: typeof built = [];
    for (const b of built) {
      const r = await runProgram(ev, b.exe, input.run, `correctness run ${b.name}`, { compilerPath: b.compiler.path });
      const row = rows[b.name]!;
      row['outcome'] = r.outcome;
      row['stdout_sha256'] = r.stdout_sha256.slice(0, 16);
      if (r.exec.timedOut) {
        row['output_correct'] = false;
        row['note'] = 'timed out';
        continue;
      }
      if (reference === null) reference = r.stdout_sha256;
      const ok = r.stdout_sha256 === reference && r.exec.exitCode === 0;
      row['output_correct'] = ok;
      if (ok) valid.push(b);
      else ev.observe(`Variant ${b.name} is disqualified: ${r.exec.exitCode !== 0 ? `exit status ${r.outcome}` : 'its output differs from the reference'}.`);
    }
    if (valid.length === 0) {
      return { status: 'inconclusive', summary: 'no variant produced correct output; nothing was timed', result: { variants: rows } };
    }

    // Warm-up, then interleaved timed runs so that drift hits all variants alike.
    for (let w = 0; w < input.warmup; w++) for (const b of valid) await runProgram(ev, b.exe, input.run, `warm-up ${b.name}`, { compilerPath: b.compiler.path, keep: 'none' });
    const samples = new Map<string, number[]>(valid.map((b) => [b.name, []]));
    let unstable = false;
    for (let i = 0; i < input.runs; i++) {
      for (const b of valid) {
        const t0 = process.hrtime.bigint();
        const r = await runProgram(ev, b.exe, input.run, `timed run ${i + 1} ${b.name}`, { compilerPath: b.compiler.path, keep: 'none' });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (r.stdout_sha256 !== reference || r.exec.exitCode !== 0) unstable = true;
        samples.get(b.name)!.push(ms);
      }
    }
    if (unstable) ev.limit('At least one timed run produced different output than the correctness run: the program is non-deterministic or failing intermittently, and its timings are suspect.');

    const stats = new Map<string, Stats>();
    for (const b of valid) {
      const s = computeStats(samples.get(b.name)!);
      stats.set(b.name, s);
      Object.assign(rows[b.name]!, { stats: s, samples_ms: samples.get(b.name)!.map((x) => round(x, 2)) });
      ev.observe(`${b.name}: median ${s.median_ms} ms, range ${s.min_ms}-${s.max_ms} ms, CV ${s.cv_percent}% over ${s.runs} runs`);
    }
    const baseline = valid[0]!;
    const bs = stats.get(baseline.name)!;
    const comparisons = valid.slice(1).map((b) => {
      const s = stats.get(b.name)!;
      const overlap = !(s.max_ms < bs.min_ms || s.min_ms > bs.max_ms);
      const ratio = round(bs.median_ms / s.median_ms, 3);
      if (overlap) ev.infer(`${b.name} vs ${baseline.name}: run-time ranges overlap, so no speed difference is established (median ratio ${ratio}x).`);
      else ev.infer(`${b.name} is ${ratio >= 1 ? `${ratio}x faster` : `${round(1 / ratio, 3)}x slower`} than ${baseline.name} by median, with non-overlapping ranges on this machine and input.`);
      return { variant: b.name, baseline: baseline.name, median_ratio: ratio, ranges_overlap: overlap, distinguishable: !overlap };
    });

    const cpus = os.cpus();
    const machine = {
      cpu_model: (cpus[0]?.model ?? 'unknown').trim(),
      logical_cpus: cpus.length,
      platform: `${process.platform} ${os.release()} ${process.arch}`,
      load_average: os.loadavg().map((x) => round(x, 2)),
      scaling_governor: governor(),
      total_memory_gb: round(os.totalmem() / 2 ** 30, 1),
    };
    if (bs.median_ms < 50) ev.limit(`The baseline runs in ${bs.median_ms} ms; process start-up is a large part of that. Lengthen the workload for a meaningful comparison.`);
    if ([...stats.values()].some((s) => s.cv_percent > 5)) ev.limit('Coefficient of variation above 5% for at least one variant: the machine is noisy. Close other work, pin the governor to performance, or raise runs.');
    ev.limit('Wall-clock time of whole-process runs, including start-up and I/O, on one machine with one input. Not pinned to a core, no hardware counters.');
    ev.unknown('Whether the result holds on other CPUs, inputs and data sizes.');
    ev.cover('runs_per_variant', input.runs);
    ev.cover('warmup', input.warmup);
    const head = comparisons[0];
    return {
      status: 'ok',
      summary: head
        ? head.distinguishable
          ? `${head.variant}: ${head.median_ratio}x vs ${head.baseline} (median, ranges do not overlap)`
          : `${head.variant} vs ${head.baseline}: not distinguishable (ranges overlap, median ratio ${head.median_ratio}x)`
        : `${baseline.name}: median ${bs.median_ms} ms (CV ${bs.cv_percent}%)`,
      result: { machine, variants: rows, comparisons, output_check: wanted !== null ? 'expected_stdout' : 'agreement with baseline', disqualified: built.filter((b) => !valid.includes(b)).map((b) => b.name) },
    };
  },
});
