import { z } from 'zod';
import { behaviorKey, checkFlags, compileTo, DEFAULT_RUN, driverFor, FlagsSchema, materialize, RunSpecSchema, runProgram, SourceSchema, TimeoutSchema } from '../core/build.js';
import { defineTool } from '../core/context.js';
import { CeaError } from '../core/errors.js';
import { normalizeNewlines, preview, sha256 } from '../core/util.js';

export interface BisectLine {
  n: number;
  pass: string;
  unit: string;
}

/** Parse `BISECT: running pass (N) name on unit` lines from -opt-bisect-limit output. */
export function parseBisectLines(stderr: string): BisectLine[] {
  const out: BisectLine[] = [];
  for (const line of normalizeNewlines(stderr).split('\n')) {
    const m = /^BISECT: (?:NOT )?running pass \((\d+)\) (.+?) on (.+)$/.exec(line);
    if (m) out.push({ n: Number(m[1]), pass: m[2]!, unit: m[3]!.replace(/^function \((.*)\)$/, '$1').replace(/^\((.*)\)$/, '$1') });
  }
  return out;
}

export const bisectPasses = defineTool({
  name: 'bisect_passes',
  family: 'correctness',
  title: 'Bisect optimisation passes',
  description:
    'Binary-search LLVM\'s -opt-bisect-limit to find the first pass whose execution flips the program from the reference behaviour to the bad behaviour (or makes the compiler crash). ' +
    'For GCC, which has no bisect limit, scan -fno-<optimisation> flags instead. The result names a pass; it does not prove the pass is wrong.',
  input: z.strictObject({
    source: SourceSchema,
    compiler: z.string().min(1).default('clang'),
    flags: FlagsSchema.default(['-O2']).describe('The configuration that misbehaves.'),
    mode: z.enum(['behavior', 'crash']).default('behavior').describe('behavior: program output differs from the reference. crash: the compiler itself crashes.'),
    reference_flags: FlagsSchema.default(['-O0']).describe('behavior mode: configuration whose output is taken as the reference.'),
    expected_stdout: z.string().max(1_000_000).optional().describe('behavior mode: use this as the reference output instead of running reference_flags.'),
    crash_signature: z.string().max(500).optional().describe('crash mode: substring that must appear in the compiler\'s stderr for a crash to count as the same crash.'),
    run: RunSpecSchema.default(DEFAULT_RUN),
    timeout_s: TimeoutSchema.default(600).describe('Budget for the whole bisection.'),
  }),
  async run(input, ev, ctx) {
    const base = await ev.compiler(input.compiler);
    const source = materialize(ev, input.source);
    const compiler = await driverFor(ev, base, source.language);
    checkFlags([...input.flags, ...input.reference_flags], ctx.config.allowUnsafeFlags);
    const deadline = Date.now() + input.timeout_s * 1000;
    let builds = 0;

    // Reference behaviour.
    let goodKey: string | null = null;
    if (input.mode === 'behavior') {
      if (input.expected_stdout !== undefined) {
        goodKey = `0|${sha256(normalizeNewlines(input.expected_stdout))}`;
        ev.observe('Reference behaviour: exit 0 with the expected_stdout given by the caller.');
      } else {
        const ref = await compileTo(ev, { compiler, source, flags: input.reference_flags, kind: 'exe', outBase: 'ref', purpose: `build reference ${input.reference_flags.join(' ')}` });
        if (!ref.ok) throw new CeaError('TOOL_FAILED', 'the reference configuration does not compile', 'Fix the source or reference_flags; see the stderr view.', { stderr: preview(ref.exec.stderr, 20) });
        const run = await runProgram(ev, ref.outPath, input.run, 'run reference', { compilerPath: compiler.path });
        goodKey = behaviorKey(run);
        ev.observe(`Reference (${input.reference_flags.join(' ')}): exit=${run.outcome}, stdout sha256 ${run.stdout_sha256.slice(0, 16)}`);
      }
    }

    type Verdict = { bad: boolean; detail: string; stderr: string };
    const test = async (extra: string[], label: string): Promise<Verdict> => {
      if (Date.now() > deadline) throw new CeaError('TIMEOUT', `bisection exceeded its ${input.timeout_s}s budget after ${builds} builds`, 'Raise timeout_s, or reduce the test case first.');
      builds++;
      const b = await compileTo(ev, { compiler, source, flags: [...input.flags, ...extra], kind: 'exe', outBase: `t${builds}`, purpose: `build ${label}`, keep: 'none', maxOutputBytes: 32 * 1024 * 1024 });
      if (input.mode === 'crash') {
        const same = b.crashed && (!input.crash_signature || b.exec.stderr.includes(input.crash_signature));
        return { bad: same, detail: b.ok ? 'compiled' : b.crashed ? 'crashed' : 'failed without crashing', stderr: b.exec.stderr };
      }
      if (!b.ok) return { bad: true, detail: b.crashed ? 'compiler crashed' : 'did not compile', stderr: b.exec.stderr };
      const run = await runProgram(ev, b.outPath, input.run, `run ${label}`, { compilerPath: compiler.path, keep: 'none' });
      return { bad: behaviorKey(run) !== goodKey, detail: `exit=${run.outcome} stdout=${run.stdout_sha256.slice(0, 16)}`, stderr: b.exec.stderr };
    };

    if (compiler.family === 'gcc') {
      const full = await test([], 'full pipeline');
      if (!full.bad) return { status: 'inconclusive', summary: 'the bad configuration does not misbehave; nothing to bisect', result: { reproduced: false, detail: full.detail } };
      const q = await ev.run('list enabled GCC optimisations', compiler.path, ['-Q', '--help=optimizers', ...input.flags.filter((f) => /^-O/.test(f) || /^-f/.test(f) || /^-m/.test(f))], { keep: 'none' });
      const enabled = normalizeNewlines(q.stdout).split('\n').map((l) => /^\s+(-f[\w-]+)\s+\[enabled\]/.exec(l)?.[1]).filter((x): x is string => !!x);
      const fixing: string[] = [];
      let scanned = 0;
      for (const f of enabled) {
        if (Date.now() > deadline) break;
        scanned++;
        const v = await test([f.replace(/^-f/, '-fno-')], f.replace(/^-f/, '-fno-'));
        if (!v.bad) fixing.push(f);
      }
      ev.observe(`${scanned}/${enabled.length} enabled -f optimisation flags scanned; disabling any of these restores the reference behaviour: ${fixing.join(', ') || 'none'}`);
      if (scanned < enabled.length) ev.limit('The scan ran out of time before covering every flag.');
      ev.limit('GCC flag scan tests one flag at a time; a fault needing two optimisations together, or one with no -f switch, is not found.');
      ev.infer(fixing.length ? 'The misbehaviour depends on the listed optimisation(s). They may be wrong, or may only expose a fault (in the program or another pass).' : 'No single -fno- flag removes the misbehaviour.');
      return {
        status: fixing.length ? 'ok' : 'inconclusive',
        summary: fixing.length ? `GCC: disabling ${fixing.slice(0, 5).join(', ')} restores the reference behaviour` : 'GCC: no single optimisation flag accounts for the difference',
        result: { reproduced: true, method: 'gcc-flag-scan', flags_scanned: scanned, flags_enabled: enabled.length, fixing_flags: fixing, builds },
      };
    }
    if (compiler.family !== 'clang') throw new CeaError('UNSUPPORTED', 'bisect_passes supports clang (-opt-bisect-limit) and gcc (flag scan)', 'For rustc pass -C llvm-args=-opt-bisect-limit=N manually, or bisect the emitted IR with clang.');

    const lim = (n: number) => ['-mllvm', `-opt-bisect-limit=${n}`];
    const full = await test(lim(-1), 'limit=-1 (all passes)');
    const passes = parseBisectLines(full.stderr);
    const max = passes.reduce((m, p) => Math.max(m, p.n), 0);
    ev.view('bisect-all-passes.txt', full.stderr, 'compiler stderr at -opt-bisect-limit=-1: the numbered pass list');
    if (!full.bad) {
      ev.observe(`With all ${max} passes enabled the build behaves like the reference (${full.detail}).`);
      return { status: 'inconclusive', summary: 'the bad configuration does not misbehave; nothing to bisect', result: { reproduced: false, total_passes: max, builds } };
    }
    if (max === 0) {
      return { status: 'inconclusive', summary: 'no bisectable passes ran (is this an -O0 build?)', result: { reproduced: true, total_passes: 0, builds } };
    }
    const zero = await test(lim(0), 'limit=0 (no optional passes)');
    if (zero.bad) {
      ev.observe(`Even with every optional pass skipped (limit=0) the behaviour is still bad (${zero.detail}).`);
      ev.infer('The difference does not come from a skippable optimisation pass: suspect the frontend, a required pass, or a difference in the flags themselves (e.g. -ffast-math, -fwrapv semantics).');
      return { status: 'inconclusive', summary: 'bad behaviour persists with all optional passes skipped; not attributable to a pass by bisection', result: { reproduced: true, total_passes: max, culprit: null, builds } };
    }

    let lo = 0; // good
    let hi = max; // bad
    const trail: { limit: number; bad: boolean; detail: string }[] = [];
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const v = await test(lim(mid), `limit=${mid}`);
      trail.push({ limit: mid, bad: v.bad, detail: v.detail });
      if (v.bad) hi = mid;
      else lo = mid;
    }
    const culprit = passes.find((p) => p.n === hi) ?? null;
    ev.observe(`limit=${lo} gives the reference behaviour; limit=${hi} gives the bad behaviour`);
    if (culprit) ev.observe(`Pass ${hi} of ${max} is ${culprit.pass} on ${culprit.unit}`);
    ev.infer(`Running ${culprit?.pass ?? `pass ${hi}`} is what flips the behaviour, given that all earlier passes ran.`);
    ev.unknown('Whether that pass is itself incorrect. It may be a correct transformation that exploits undefined behaviour in the program, or one that exposes a fault in a later pass or in the backend.');
    ev.limit('-opt-bisect-limit only skips optional passes, and skipping changes what later passes see; the search assumes a single good-to-bad flip.');
    ev.cover('builds', builds);
    ev.cover('total_passes', max);
    return {
      status: 'ok',
      summary: culprit ? `first flipping pass: ${culprit.pass} on ${culprit.unit} (limit ${hi} of ${max})` : `behaviour flips at limit ${hi} of ${max}`,
      result: {
        reproduced: true,
        method: 'opt-bisect-limit',
        total_passes: max,
        last_good_limit: lo,
        first_bad_limit: hi,
        culprit,
        previous_pass: passes.find((p) => p.n === lo) ?? null,
        search: trail,
        builds,
        repro_flags: { good: [...input.flags, ...lim(lo)], bad: [...input.flags, ...lim(hi)] },
      },
    };
  },
});
