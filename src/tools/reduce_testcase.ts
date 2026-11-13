import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { checkFlags, compileTo, DEFAULT_RUN, driverFor, FlagsSchema, materialize, RunSpecSchema, runProgram, SourceSchema, TimeoutSchema } from '../core/build.js';
import { defineTool } from '../core/context.js';
import { CeaError } from '../core/errors.js';
import { ddminLines, renderInterestingScript, renderShellWrapper, type InterestingConfig, type Step } from '../core/interesting.js';
import { countLines, normalizeNewlines, preview } from '../core/util.js';

const CRASH_LINE = /(Assertion .* failed\.?|LLVM ERROR: .*|internal compiler error: .*|UNREACHABLE executed.*|fatal error: error in backend: .*)/;

export const reduceTestcase = defineTool({
  name: 'reduce_testcase',
  family: 'correctness',
  title: 'Reduce test case',
  description:
    'Generate a strict interestingness test and shrink the test case with cvise, creduce or llvm-reduce (or a built-in line reducer when none is installed). ' +
    'For a miscompile the test demands: same reference output, same bad output, and still clean under sanitizers at -O0, so the reduction cannot drift into undefined behaviour or a different bug. ' +
    'For a compiler crash it demands the same crash signature. Returns the reduced case and the test script.',
  input: z.strictObject({
    source: SourceSchema,
    kind: z.enum(['miscompile', 'crash']),
    compiler: z.string().min(1).default('clang'),
    flags: FlagsSchema.default(['-O2']).describe('The configuration that misbehaves or crashes.'),
    reference_flags: FlagsSchema.default(['-O0']).describe('miscompile: the configuration that behaves correctly.'),
    crash_signature: z.string().max(500).optional().describe('crash: substring of the compiler\'s stderr that identifies this crash. Derived from the original crash when omitted.'),
    run: RunSpecSchema.default(DEFAULT_RUN),
    strictness: z.enum(['same_outputs', 'any_divergence']).default('same_outputs').describe('same_outputs pins both the reference and the bad output; any_divergence only demands that they differ (reduces further, but may drift to another bug).'),
    reducer: z.enum(['auto', 'cvise', 'creduce', 'llvm-reduce', 'builtin']).default('auto'),
    timeout_s: TimeoutSchema.default(300).describe('Budget for the reduction itself.'),
    max_tests: z.number().int().min(1).max(100_000).default(2000).describe('Built-in reducer: maximum interestingness tests.'),
  }),
  async run(input, ev, ctx) {
    const base = await ev.compiler(input.compiler);
    const source = materialize(ev, input.source);
    const compiler = await driverFor(ev, base, source.language);
    checkFlags([...input.flags, ...input.reference_flags], ctx.config.allowUnsafeFlags);
    const ext = path.extname(source.file);
    const fileName = `input${ext}`;
    const runMs = input.run.timeout_s * 1000;
    const steps: Step[] = [];
    const pathDirs = [path.dirname(compiler.path)];
    const mingwBin = fs.readdirSync(path.dirname(path.dirname(compiler.path))).filter((d) => /mingw|w64/.test(d)).map((d) => path.join(path.dirname(path.dirname(compiler.path)), d, 'bin')).filter((d) => fs.existsSync(d));
    pathDirs.push(...mingwBin);
    let description: string;
    let ubCheck: 'sanitizers' | 'none' = 'none';

    if (input.kind === 'crash') {
      const orig = await compileTo(ev, { compiler, source, flags: input.flags, kind: 'obj', outBase: 'orig', purpose: 'reproduce crash on the original' });
      if (!orig.crashed) {
        throw new CeaError('INVALID_INPUT', orig.ok ? 'the compiler does not crash on this input with these flags' : 'the compiler rejects this input but does not crash', 'Check compiler version and flags; reduction needs a reproducible crash.', { stderr: preview(orig.exec.stderr, 15) });
      }
      let signature = input.crash_signature;
      if (!signature) {
        const m = CRASH_LINE.exec(orig.exec.stderr);
        if (!m) throw new CeaError('INVALID_INPUT', 'could not derive a crash signature from the compiler output', 'Pass crash_signature: a stable substring of the crash message (assertion text or the innermost stack frame).', { stderr: preview(orig.exec.stderr, 25) });
        signature = m[1]!.trim().slice(0, 200);
      } else if (!orig.exec.stderr.includes(signature)) {
        throw new CeaError('INVALID_INPUT', 'crash_signature does not appear in the original crash output', 'Use a substring of the stderr view of this record.');
      }
      ev.observe(`Original crash reproduced; signature: "${signature}"`);
      steps.push({ type: 'compile', id: 'crash', argv: [compiler.path, ...input.flags, '-c', '{file}', '-o', '{out:crash}'], expect: 'crash', stderr_includes: [signature], timeout_ms: 120_000 });
      description = `compiler crash with signature "${signature}" under ${path.basename(compiler.path)} ${input.flags.join(' ')}`;
    } else {
      const ref = await compileTo(ev, { compiler, source, flags: input.reference_flags, kind: 'exe', outBase: 'orig-ref', purpose: 'build reference on the original' });
      const bad = await compileTo(ev, { compiler, source, flags: input.flags, kind: 'exe', outBase: 'orig-bad', purpose: 'build bad config on the original' });
      if (!ref.ok || !bad.ok) throw new CeaError('INVALID_INPUT', 'the original does not compile in both configurations', 'Fix the source or flags first.', { stderr: preview((ref.ok ? bad : ref).exec.stderr, 15) });
      const refRun = await runProgram(ev, ref.outPath, input.run, 'run reference on the original', { compilerPath: compiler.path });
      const badRun = await runProgram(ev, bad.outPath, input.run, 'run bad config on the original', { compilerPath: compiler.path });
      if (refRun.exec.timedOut || badRun.exec.timedOut) throw new CeaError('TIMEOUT', 'the original program timed out', 'Raise run.timeout_s or use a smaller input.');
      if (refRun.outcome === badRun.outcome && refRun.stdout_sha256 === badRun.stdout_sha256) {
        throw new CeaError('INVALID_INPUT', 'the two configurations behave the same on the original; there is nothing to reduce', 'Run differential_run to find a diverging configuration first.');
      }
      ev.observe(`Original: reference exit=${refRun.outcome} stdout=${refRun.stdout_sha256.slice(0, 16)}; bad exit=${badRun.outcome} stdout=${badRun.stdout_sha256.slice(0, 16)}`);

      // UB guard: the candidate must stay clean under sanitizers at -O0.
      const strictC = source.language === 'c' ? ['-Werror=implicit-function-declaration', '-Werror=implicit-int', '-Werror=return-type', '-Werror=int-conversion'] : ['-Werror=return-type'];
      let san: string[] | null = null;
      for (const cand of [['undefined', 'address'], ['undefined']]) {
        const flags = ['-O0', '-g', `-fsanitize=${cand.join(',')}`, '-fno-sanitize-recover=all', ...strictC];
        const b = await compileTo(ev, { compiler, source, flags, kind: 'exe', outBase: `orig-san-${cand.length}`, purpose: `build original with -fsanitize=${cand.join(',')}` });
        if (!b.ok) continue;
        const r = await runProgram(ev, b.outPath, input.run, 'run sanitized original', { compilerPath: compiler.path, env: { UBSAN_OPTIONS: 'halt_on_error=1', ASAN_OPTIONS: 'detect_leaks=0' } });
        if (/runtime error:|AddressSanitizer/.test(r.exec.stderr)) {
          throw new CeaError('INVALID_INPUT', 'the original program has undefined behaviour under sanitizers; this is not a miscompile to reduce', 'Run check_ub and fix the program. Reducing a UB-dependent difference produces a meaningless test case.', { stderr: preview(r.exec.stderr, 10) });
        }
        san = flags;
        steps.push({ type: 'compile', id: 'sanitized build', argv: [compiler.path, ...flags, '{file}', '-o', '{out:san}'], expect: 'success', timeout_ms: 120_000 });
        steps.push({ type: 'run', id: 'sanitized run', exe: '{out:san}', args: input.run.args, ...(input.run.stdin !== undefined ? { stdin: input.run.stdin } : {}), timeout_ms: runMs * 3, forbid_stderr: ['runtime error:', 'AddressSanitizer', 'MemorySanitizer'], ...(r.exec.exitCode !== null ? { expect_status: r.exec.exitCode } : {}) });
        ubCheck = 'sanitizers';
        break;
      }
      if (!san) {
        ev.limit('No sanitizer build links with this compiler, so the interestingness test cannot guard against the reduction introducing undefined behaviour. Treat the reduced case with suspicion and run check_ub on it with another compiler.');
        steps.push({ type: 'compile', id: 'strict build', argv: [compiler.path, '-O0', ...strictC, '-Werror=uninitialized', '{file}', '-o', '{out:strict}'], expect: 'success', timeout_ms: 120_000 });
      }
      const strict = input.strictness === 'same_outputs';
      const stdinPart = input.run.stdin !== undefined ? { stdin: input.run.stdin } : {};
      steps.push({ type: 'compile', id: 'reference build', argv: [compiler.path, ...input.reference_flags, '{file}', '-o', '{out:ref}'], expect: 'success', timeout_ms: 120_000 });
      steps.push({ type: 'run', id: 'reference', exe: '{out:ref}', args: input.run.args, ...stdinPart, timeout_ms: runMs, ...(strict && refRun.exec.exitCode !== null ? { expect_status: refRun.exec.exitCode, expect_stdout_sha256: refRun.stdout_sha256 } : {}) });
      steps.push({ type: 'compile', id: 'bad build', argv: [compiler.path, ...input.flags, '{file}', '-o', '{out:bad}'], expect: 'success', timeout_ms: 120_000 });
      steps.push({ type: 'run', id: 'bad', exe: '{out:bad}', args: input.run.args, ...stdinPart, timeout_ms: runMs, ...(strict && badRun.exec.exitCode !== null ? { expect_status: badRun.exec.exitCode, expect_stdout_sha256: badRun.stdout_sha256 } : {}) });
      steps.push({ type: 'differ', a: 'reference', b: 'bad' });
      description = `miscompile: ${input.reference_flags.join(' ')} and ${input.flags.join(' ')} behave differently${strict ? ' with the original outputs pinned' : ''}; UB guard: ${ubCheck}`;
    }

    // Write the test and check that the original passes it.
    const redDir = path.join(ev.workDir, 'reduce');
    fs.mkdirSync(redDir, { recursive: true });
    const cfg: InterestingConfig = { description, file_name: fileName, path_dirs: pathDirs, steps };
    const script = renderInterestingScript(cfg);
    const scriptPath = path.join(redDir, 'interesting.mjs');
    fs.writeFileSync(scriptPath, script, 'utf8');
    ev.view('interesting.mjs', script, 'interestingness test (node interesting.mjs [file]); exit 0 = still the same failure');
    const target = path.join(redDir, fileName);
    fs.writeFileSync(target, source.text, 'utf8');
    const node = process.execPath;
    const check = await ev.run('interestingness test on the original', node, [scriptPath, target], { cwd: redDir, timeoutMs: 600_000, env: { ...process.env, CEA_INTERESTING_VERBOSE: '1' } });
    if (check.exitCode !== 0) {
      throw new CeaError('TOOL_FAILED', `the original is not interesting under the generated test: ${check.stderr.trim()}`, 'The failure is probably flaky or depends on the file path. Make it deterministic, or relax strictness to any_divergence.');
    }

    // Pick a reducer.
    const isIr = source.language === 'llvm-ir';
    let reducer = input.reducer;
    if (reducer === 'auto') {
      if (isIr && await ctx.toolbox.has('llvm-reduce')) reducer = 'llvm-reduce';
      else if (!isIr && await ctx.toolbox.has('cvise')) reducer = 'cvise';
      else if (!isIr && await ctx.toolbox.has('creduce')) reducer = 'creduce';
      else {
        reducer = 'builtin';
        ev.limit('No cvise/creduce/llvm-reduce available for this input: used the built-in line-based delta debugger, which removes whole lines only and leaves larger results than cvise.');
      }
    }
    const budgetMs = input.timeout_s * 1000;
    let tests: number | null = null;
    let exhausted = false;

    if (reducer === 'builtin') {
      const candDir = path.join(redDir, 'candidate');
      fs.mkdirSync(candDir, { recursive: true });
      const candFile = path.join(candDir, fileName);
      const r = await ddminLines(source.text, async (cand) => {
        fs.writeFileSync(candFile, cand, 'utf8');
        const t = await ctx.exec(node, [scriptPath, candFile], { cwd: candDir, timeoutMs: 600_000 });
        return t.exitCode === 0;
      }, { deadline: Date.now() + budgetMs, maxTests: input.max_tests });
      fs.writeFileSync(target, r.text, 'utf8');
      tests = r.tests;
      exhausted = r.exhausted;
    } else if (reducer === 'llvm-reduce') {
      const tool = await ev.tool('llvm-reduce');
      const out = path.join(redDir, `reduced${ext}`);
      const r = await ev.run('llvm-reduce', tool.path, [`--test=${node}`, `--test-arg=${scriptPath}`, target, '-o', out], { cwd: redDir, timeoutMs: budgetMs, keep: 'stderr' });
      exhausted = r.timedOut;
      if (fs.existsSync(out)) fs.copyFileSync(out, target);
    } else {
      const tool = await ev.tool(reducer);
      const sh = path.join(redDir, 'interesting.sh');
      fs.writeFileSync(sh, renderShellWrapper(node, scriptPath), { encoding: 'utf8', mode: 0o755 });
      ev.view('interesting.sh', fs.readFileSync(sh, 'utf8'), 'shell wrapper passed to cvise/creduce');
      const r = await ev.run(reducer, tool.path, ['--timeout', String(Math.max(30, input.run.timeout_s * 6)), sh, fileName], { cwd: redDir, timeoutMs: budgetMs, keep: 'stderr' });
      exhausted = r.timedOut;
    }

    // Never trust the reducer's word: re-run the test on what it left behind.
    let reduced = fs.readFileSync(target, 'utf8');
    const verify = await ev.run('interestingness test on the reduced case', node, [scriptPath, target], { cwd: redDir, timeoutMs: 600_000, env: { ...process.env, CEA_INTERESTING_VERBOSE: '1' } });
    const verified = verify.exitCode === 0;
    if (!verified) {
      ev.observe(`The reducer's output failed the interestingness test (${verify.stderr.trim()}); returning the original.`);
      reduced = source.text;
    }
    const v = ev.view(`reduced${ext}`, reduced, 'reduced test case');
    const before = { bytes: Buffer.byteLength(source.text), lines: countLines(normalizeNewlines(source.text)) };
    const after = { bytes: v.bytes, lines: v.lines };
    ev.observe(`Reduced from ${before.lines} lines (${before.bytes} bytes) to ${after.lines} lines (${after.bytes} bytes) with ${reducer}${tests !== null ? ` in ${tests} tests` : ''}`);
    if (verified) ev.observe('The reduced case passes the interestingness test when re-run after reduction.');
    if (exhausted) ev.limit('The reduction stopped on its time or test budget; the result is not minimal.');
    ev.limit('A reduced case reproduces the failure the test describes, nothing more. If the test is loose, the reduced case may show a different problem than the original.');
    if (input.kind === 'miscompile' && ubCheck === 'sanitizers') ev.unknown('Whether the reduced program has undefined behaviour that sanitizers cannot see (strict aliasing, unsequenced modification, uninitialised reads).');
    ev.cover('interestingness', description);
    return {
      status: verified ? 'ok' : 'inconclusive',
      summary: verified ? `reduced ${before.lines} -> ${after.lines} lines with ${reducer}` : 'reduction did not produce a verified smaller case',
      result: {
        verified,
        reducer,
        kind: input.kind,
        before,
        after,
        tests_run: tests,
        budget_exhausted: exhausted,
        ub_guard: input.kind === 'miscompile' ? ubCheck : 'not applicable',
        interestingness: description,
        script_view: 'interesting.mjs',
        script_path: scriptPath,
        reduced_view: v.name,
        reduced_path: target,
        reduced_source: preview(reduced, 80, 6000),
      },
    };
  },
});
