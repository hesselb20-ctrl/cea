import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { behaviorKey, checkFlags, FlagsSchema, looksLikeCompilerCrash, OptLevelSchema, optFlags, runProgram, TimeoutSchema } from '../core/build.js';
import { defineTool } from '../core/context.js';
import { CeaError } from '../core/errors.js';
import type { CompilerInfo } from '../core/toolbox.js';
import { exeName, preview } from '../core/util.js';

/** Find the directory holding csmith.h. */
export function findCsmithInclude(csmithPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = [];
  if (env['CEA_CSMITH_INCLUDE']) candidates.push(env['CEA_CSMITH_INCLUDE']);
  const prefix = path.dirname(path.dirname(csmithPath));
  for (const root of [path.join(prefix, 'include'), '/usr/include', '/usr/local/include', '/opt/homebrew/include']) {
    candidates.push(root, path.join(root, 'csmith'));
    try {
      for (const d of fs.readdirSync(root)) if (/^csmith/.test(d)) candidates.push(path.join(root, d));
    } catch { /* directory absent */ }
  }
  return candidates.find((d) => fs.existsSync(path.join(d, 'csmith.h'))) ?? null;
}

export const fuzzCompiler = defineTool({
  name: 'fuzz_compiler',
  family: 'correctness',
  title: 'Fuzz compilers differentially',
  description:
    'Time-boxed differential fuzzing: generate random programs with Csmith or YARPGen, build them with several compilers and optimisation levels, and save every program whose builds disagree (or that crashes a compiler) as a candidate with its seed. ' +
    'A candidate is a lead, not a bug report: run check_ub and reduce_testcase on it next.',
  input: z.strictObject({
    generator: z.enum(['auto', 'csmith', 'yarpgen']).default('auto'),
    duration_s: TimeoutSchema.default(60).describe('Wall-clock budget for the campaign.'),
    max_programs: z.number().int().min(1).max(100_000).default(200),
    compilers: z.array(z.string().min(1)).min(1).max(6).optional().describe('Default: every available C compiler.'),
    opt_levels: z.array(OptLevelSchema).min(1).max(6).default(['O0', 'O2']),
    flags: FlagsSchema.default([]),
    seed_start: z.number().int().min(1).max(2 ** 31 - 1).optional().describe('First seed; seeds increase by one. Default: derived from the clock, and reported.'),
    program_timeout_s: TimeoutSchema.max(120).default(10),
    generator_args: z.array(z.string().max(80).regex(/^--?[A-Za-z0-9][\w=.,-]*$/, 'must be an option, not a path')).max(20).default([]),
  }),
  async run(input, ev, ctx) {
    checkFlags(input.flags, ctx.config.allowUnsafeFlags);
    let gen = input.generator;
    if (gen === 'auto') {
      if (await ctx.toolbox.has('csmith')) gen = 'csmith';
      else if (await ctx.toolbox.has('yarpgen')) gen = 'yarpgen';
      else gen = 'csmith'; // fall through to the PROVIDER_UNAVAILABLE error with its remediation
    }
    const tool = await ev.tool(gen);
    let include: string | null = null;
    if (gen === 'csmith') {
      include = findCsmithInclude(tool.path);
      if (!include) throw new CeaError('PROVIDER_UNAVAILABLE', 'csmith is installed but csmith.h was not found', 'Install the csmith runtime headers (apt install libcsmith-dev) or set CEA_CSMITH_INCLUDE to the directory containing csmith.h.', { provider: 'csmith' });
    }
    let names = input.compilers;
    if (!names) {
      names = [];
      for (const c of ['clang', 'gcc']) if (await ctx.toolbox.has(c)) names.push(c);
      if (names.length === 0) throw new CeaError('PROVIDER_UNAVAILABLE', 'no C compiler available', 'Install clang or gcc; see environment_report.');
    }
    const configs: { id: string; compiler: CompilerInfo; flags: string[] }[] = [];
    for (const n of names) {
      const c = await ev.compiler(n);
      for (const l of input.opt_levels) configs.push({ id: `${n}-${l}`, compiler: c, flags: [...optFlags(c.family, l), ...input.flags] });
    }
    if (configs.length < 2) throw new CeaError('INVALID_INPUT', 'differential fuzzing needs at least two configurations', 'Add an optimisation level or a second compiler.');

    const deadline = Date.now() + input.duration_s * 1000;
    const seed0 = input.seed_start ?? (Math.floor(Date.now() / 1000) % 1_000_000_000) + 1;
    const candDir = path.join(ctx.ledger.dir, 'candidates', ev.id);
    const candidates: Record<string, unknown>[] = [];
    let tested = 0;
    let generated = 0;
    let skippedTimeout = 0;
    let genFailures = 0;
    const runSpec = { args: [], timeout_s: input.program_timeout_s };

    for (let i = 0; i < input.max_programs && Date.now() < deadline; i++) {
      const seed = seed0 + i;
      const dir = path.join(ev.workDir, `seed-${seed}`);
      fs.mkdirSync(dir, { recursive: true });
      let sources: string[];
      if (gen === 'csmith') {
        const g = await ev.run(`csmith seed ${seed}`, tool.path, ['--seed', String(seed), ...input.generator_args], { timeoutMs: 60_000, keep: 'none', maxOutputBytes: 32 * 1024 * 1024 });
        if (g.exitCode !== 0 || g.stdout.length === 0) {
          genFailures++;
          continue;
        }
        fs.writeFileSync(path.join(dir, 'prog.c'), g.stdout, 'utf8');
        sources = [path.join(dir, 'prog.c')];
      } else {
        const g = await ev.run(`yarpgen seed ${seed}`, tool.path, ['--std=c', `--seed=${seed}`, `--out-dir=${dir}`, ...input.generator_args], { timeoutMs: 60_000, keep: 'none' });
        sources = ['driver.c', 'func.c'].map((f) => path.join(dir, f));
        if (g.exitCode !== 0 || !sources.every((s) => fs.existsSync(s))) {
          genFailures++;
          continue;
        }
      }
      generated++;
      const keys = new Map<string, string[]>();
      let timedOut = false;
      let crash: { id: string; stderr: string } | null = null;
      for (const cfg of configs) {
        if (Date.now() > deadline) break;
        const exe = path.join(dir, exeName(cfg.id));
        const argv = [...cfg.flags, '-w', ...(include ? ['-I', include] : ['-I', dir]), ...sources, '-o', exe];
        const b = await ev.run(`build seed ${seed} ${cfg.id}`, cfg.compiler.path, argv, { timeoutMs: 120_000, keep: 'none' });
        if (b.exitCode !== 0 || !fs.existsSync(exe)) {
          if (looksLikeCompilerCrash(b)) crash = { id: cfg.id, stderr: b.stderr };
          else keys.set('build-failed', [...(keys.get('build-failed') ?? []), cfg.id]);
          continue;
        }
        const r = await runProgram(ev, exe, runSpec, `run seed ${seed} ${cfg.id}`, { compilerPath: cfg.compiler.path, keep: 'none' });
        if (r.exec.timedOut) {
          timedOut = true;
          break;
        }
        const k = behaviorKey(r);
        keys.set(k, [...(keys.get(k) ?? []), cfg.id]);
      }
      if (timedOut) {
        // Random programs may not terminate; that says nothing about the compiler.
        skippedTimeout++;
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      tested++;
      if (crash || keys.size > 1) {
        const out = path.join(candDir, `seed-${seed}`);
        fs.mkdirSync(out, { recursive: true });
        for (const s of sources) fs.copyFileSync(s, path.join(out, path.basename(s)));
        if (crash) fs.writeFileSync(path.join(out, 'compiler-crash.stderr.txt'), crash.stderr, 'utf8');
        const behaviours = [...keys.entries()].map(([k, ids]) => ({ behaviour: k.split('|')[0], stdout_sha256: (k.split('|')[1] ?? '').slice(0, 16), configs: ids }));
        const c = { seed, kind: crash ? 'compiler_crash' : keys.has('build-failed') ? 'build_difference' : 'divergence', path: out, behaviours, crash_config: crash?.id ?? null, crash_preview: crash ? preview(crash.stderr, 8) : null };
        fs.writeFileSync(path.join(out, 'candidate.json'), JSON.stringify(c, null, 1), 'utf8');
        ev.view(`candidate-seed-${seed}.c`, fs.readFileSync(sources[sources.length - 1]!, 'utf8'), `candidate program for seed ${seed}`);
        candidates.push(c);
        ev.observe(`seed ${seed}: ${crash ? `compiler crash in ${crash.id}` : `${keys.size} distinct behaviours`}`);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }

    ev.observe(`${tested} program(s) compared across ${configs.length} configuration(s); ${candidates.length} candidate(s); ${skippedTimeout} skipped for non-termination; ${genFailures} generator failure(s)`);
    ev.cover('seeds', { first: seed0, attempted: generated + genFailures });
    ev.cover('configs', configs.map((c) => c.id));
    ev.limit('Random differential testing samples the input space; finding nothing in a short campaign says very little about compiler correctness.');
    ev.limit(gen === 'csmith'
      ? 'Csmith aims to generate UB-free programs, but candidates must still pass check_ub before they are treated as miscompiles.'
      : 'YARPGen aims to generate UB-free programs, but candidates must still pass check_ub before they are treated as miscompiles.');
    if (candidates.length > 0) {
      ev.infer('Each candidate shows builds that disagree. Until check_ub is clean and the case is reduced, it is a lead, not a compiler bug.');
      ev.unknown('For each candidate: which build is wrong, and whether the program is free of undefined behaviour.');
    }
    return {
      status: 'ok',
      summary: `${tested} programs, ${candidates.length} candidate(s) (${gen}, seeds from ${seed0})`,
      result: { generator: gen, seed_start: seed0, programs_generated: generated, programs_compared: tested, skipped_timeout: skippedTimeout, generator_failures: genFailures, candidates, candidates_dir: candidates.length ? candDir : null, configs: configs.map((c) => ({ id: c.id, compiler: c.compiler.version, flags: c.flags })) },
    };
  },
});
