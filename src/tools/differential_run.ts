import { z } from 'zod';
import { behaviorKey, compileTo, DEFAULT_RUN, FlagsSchema, materialize, OptLevelSchema, optFlags, RunSpecSchema, runProgram, SourceSchema } from '../core/build.js';
import { defineTool } from '../core/context.js';
import { CeaError } from '../core/errors.js';
import type { CompilerInfo } from '../core/toolbox.js';
import { preview } from '../core/util.js';

export const differentialRun = defineTool({
  name: 'differential_run',
  family: 'correctness',
  title: 'Differential run',
  description:
    'Compile the same program with several compilers and optimisation levels, run each build, and compare stdout and exit codes. ' +
    'Each build runs twice so that a program that is non-deterministic by itself is not mistaken for a compiler difference.',
  input: z.strictObject({
    source: SourceSchema,
    compilers: z.array(z.string().min(1)).min(1).max(8).optional().describe('Default: every available C compiler (clang, gcc), or rustc for Rust.'),
    opt_levels: z.array(OptLevelSchema).min(1).max(7).default(['O0', 'O1', 'O2', 'O3', 'Os']),
    flags: FlagsSchema.default([]).describe('Flags added to every build.'),
    extra_configs: z.array(z.strictObject({ compiler: z.string().min(1), flags: FlagsSchema })).max(16).default([]).describe('Additional exact configurations, e.g. {"compiler":"clang","flags":["-O2","-fwrapv"]}.'),
    run: RunSpecSchema.default(DEFAULT_RUN),
  }),
  async run(input, ev, ctx) {
    const source = materialize(ev, input.source);
    let names = input.compilers;
    if (!names) {
      names = [];
      const candidates = source.language === 'rust' ? ['rustc'] : ['clang', 'gcc'];
      for (const c of candidates) if (await ctx.toolbox.has(c)) names.push(c);
      if (names.length === 0) {
        throw new CeaError('PROVIDER_UNAVAILABLE', `no compiler available for ${source.language}`, 'Install clang or gcc (rustc for Rust), or pass `compilers` with explicit paths. See environment_report.');
      }
    }
    const configs: { id: string; compiler: CompilerInfo; flags: string[] }[] = [];
    for (const n of names) {
      const c = await ev.compiler(n);
      for (const l of input.opt_levels) configs.push({ id: `${n}-${l}`, compiler: c, flags: [...optFlags(c.family, l), ...input.flags] });
    }
    for (const [i, x] of input.extra_configs.entries()) {
      configs.push({ id: `extra${i + 1}-${x.compiler}-${x.flags.join('_')}`.slice(0, 60), compiler: await ev.compiler(x.compiler), flags: x.flags });
    }

    const rows: Record<string, unknown>[] = [];
    const classes = new Map<string, string[]>();
    const nondeterministic: string[] = [];
    let failedBuilds = 0;
    for (const [i, cfg] of configs.entries()) {
      const b = await compileTo(ev, { compiler: cfg.compiler, source, flags: cfg.flags, kind: 'exe', outBase: `cfg${i}`, purpose: `build ${cfg.id}`, keep: 'stderr' });
      if (!b.ok) {
        failedBuilds++;
        rows.push({ id: cfg.id, compiler: cfg.compiler.version, flags: cfg.flags, built: false, compiler_crashed: b.crashed, stderr_preview: preview(b.exec.stderr, 8) });
        continue;
      }
      const r1 = await runProgram(ev, b.outPath, input.run, `run ${cfg.id}`, { compilerPath: cfg.compiler.path });
      const r2 = await runProgram(ev, b.outPath, input.run, `rerun ${cfg.id}`, { compilerPath: cfg.compiler.path, keep: 'none' });
      const stable = behaviorKey(r1) === behaviorKey(r2);
      if (!stable) nondeterministic.push(cfg.id);
      const key = behaviorKey(r1);
      classes.set(key, [...(classes.get(key) ?? []), cfg.id]);
      rows.push({
        id: cfg.id, compiler: cfg.compiler.version, flags: cfg.flags, built: true,
        outcome: r1.outcome, stdout_sha256: r1.stdout_sha256.slice(0, 16), stable_across_reruns: stable,
        stdout_preview: preview(r1.exec.stdout, 6, 400), stderr_preview: r1.exec.stderr ? preview(r1.exec.stderr, 4, 300) : '',
      });
    }

    const groups = [...classes.entries()].map(([key, members]) => ({ outcome: key.split('|')[0], stdout_sha256: key.split('|')[1]!.slice(0, 16), configs: members }));
    groups.sort((a, b) => b.configs.length - a.configs.length);
    const built = rows.filter((r) => r['built']).length;
    const divergent = groups.length > 1;
    ev.cover('configs', configs.map((c) => c.id));
    ev.cover('inputs', { args: input.run.args, stdin: input.run.stdin !== undefined });
    ev.observe(`${built}/${configs.length} configurations built and ran; ${groups.length} distinct behaviour(s)`);
    for (const g of groups) ev.observe(`exit=${g.outcome} stdout=${g.stdout_sha256}: ${g.configs.join(', ')}`);
    if (nondeterministic.length) {
      ev.observe(`Output changed between two runs of the same binary for: ${nondeterministic.join(', ')}`);
      ev.infer('The program is non-deterministic on its own (uninitialised memory, addresses, time, threads); differences between configurations are not attributable to the compiler until that is removed.');
    }
    if (divergent) {
      ev.infer('Behaviour depends on compiler or optimisation level. That is expected for programs with undefined, unspecified or implementation-defined behaviour and is a compiler bug only if those are ruled out.');
      ev.unknown('Which of the behaviours is the correct one: differential testing shows disagreement, not which side is right.');
    } else if (built > 0) {
      ev.limit('Agreement across configurations does not show the output is correct, only that these builds agree on this input.');
    }
    ev.limit('One input only. Divergence on other inputs is not covered.');
    return {
      status: built === 0 ? 'inconclusive' : 'ok',
      summary: built === 0 ? 'no configuration built' : divergent ? `DIVERGENCE: ${groups.length} distinct behaviours across ${built} builds` : `all ${built} builds agree`,
      result: { divergent, behaviours: groups, configs: rows, failed_builds: failedBuilds, nondeterministic },
    };
  },
});
