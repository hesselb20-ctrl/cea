import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callTool, invokeTool } from '../../src/core/context.js';
import { analyzeThroughput } from '../../src/tools/analyze_throughput.js';
import { benchmark } from '../../src/tools/benchmark.js';
import { bisectCompilerHistory } from '../../src/tools/bisect_compiler_history.js';
import { bisectPasses } from '../../src/tools/bisect_passes.js';
import { checkUb } from '../../src/tools/check_ub.js';
import { compile } from '../../src/tools/compile.js';
import { differentialRun } from '../../src/tools/differential_run.js';
import { emitIr } from '../../src/tools/emit_ir.js';
import { environmentReport } from '../../src/tools/environment_report.js';
import { fuzzCompiler } from '../../src/tools/fuzz_compiler.js';
import { exportEvidenceBundle, inspectEvidenceView, listEvidence, recordUnknown, updateUnknown } from '../../src/tools/ledger_tools.js';
import { optRemarks } from '../../src/tools/opt_remarks.js';
import { passTimeline } from '../../src/tools/pass_timeline.js';
import { reduceTestcase } from '../../src/tools/reduce_testcase.js';
import { triageMiscompile } from '../../src/tools/triage_miscompile.js';
import { validateTransform } from '../../src/tools/validate_transform.js';
import { C_SRC, fake, res, srcArg, tmpDir, writeOut, type Handler } from '../helpers.js';

const UB_LINE = "input.c:3:36: runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'";
/** A fake compiler that "builds" by writing its own flags into the output file. */
const stampingCompiler: Handler = (args) => {
  if (args.includes('-o')) writeOut(args, args.join(' '));
  return undefined;
};
const read = (cmd: string) => fs.readFileSync(cmd, 'utf8');

describe('every tool returns a complete Evidence record', () => {
  it('records inputs, hashes, tool versions, exact commands, target and limitations', async () => {
    const f = fake({ clang: (args) => { if (args.includes('-o')) writeOut(args, 'f:\n\tretq\n'); return undefined; } });
    const e = await invokeTool(f.ctx, compile, { source: C_SRC, flags: ['-O2'] });
    expect(e.schema).toBe('cea.evidence/1');
    expect(e.evidence_id).toMatch(/^ev_compile_[0-9a-f]{8}$/);
    expect(e.session_id).toBe('test');
    expect(e.operation).toBe('compile');
    expect(e.inputs).toEqual({ source: C_SRC, flags: ['-O2'] });
    expect(e.input_files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e.tools[0]).toMatchObject({ name: 'clang', version: 'Ubuntu clang version 18.1.3 (1ubuntu1)' });
    expect(e.target_triple).toBe('x86_64-pc-linux-gnu');
    const cmd = e.commands[0]!;
    expect(cmd.argv[0]).toBe(e.tools[0]!.path);
    expect(cmd.argv.slice(1, 3)).toEqual(['-O2', '-S']);
    expect(cmd.exit_code).toBe(0);
    expect(e.limitations.length).toBeGreaterThan(0);
    expect(e.views.map((v) => v.name)).toContain('output.s');
    expect(f.ctx.ledger.get(e.evidence_id)).toEqual(e);
  });

  it('turns invalid input into an error record with a remediation, not an exception', async () => {
    const f = fake({});
    const e = await invokeTool(f.ctx, compile, { source: C_SRC, bogus: true });
    expect(e.status).toBe('error');
    expect(e.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(e.error!.remediation).toMatch(/cea schema compile/);
    expect(f.ctx.ledger.list()).toHaveLength(1);
  });

  it('records a missing provider as unavailable with the install hint', async () => {
    const e = await invokeTool(fake({}).ctx, compile, { source: C_SRC });
    expect(e.status).toBe('unavailable');
    expect(e.error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(e.error!.remediation).toMatch(/Install LLVM/);
  });
});

describe('environment_report', () => {
  it('lists providers, missing ones with reasons, and which sanitizers link', async () => {
    const f = fake({
      clang: (args) => {
        if (args.some((a) => a === '-fsanitize=memory')) return { exitCode: 1, stderr: 'ld: cannot find -lmsan' };
        if (args.includes('-o')) writeOut(args, 'exe');
        return undefined;
      },
      gcc: stampingCompiler,
      llc: (args) => (args[0] === '--version' ? { stdout: 'LLVM version 18.1.3\n\n  Registered Targets:\n    aarch64 - AArch64\n    x86-64  - 64-bit X86\n' } : undefined),
      opt: (args) => (args[0] === '--version' ? { stdout: 'LLVM version 17.0.6' } : undefined),
    });
    const e = await invokeTool(f.ctx, environmentReport, {});
    const r = res(e);
    expect(r.compilers.map((c: { id: string }) => c.id)).toEqual(['clang', 'gcc']);
    expect(r.sanitizers.clang).toEqual({ undefined: true, address: true, memory: false });
    expect(r.missing).toContain('alive-tv');
    expect(r.llvm_targets).toEqual(['aarch64', 'x86-64']);
    expect(r.warnings.join(' ')).toMatch(/different major versions/);
    expect(r.providers.find((p: { id: string }) => p.id === 'cvise')).toMatchObject({ available: false });
    expect(r.remote_providers.compiler_explorer).toBe(false);
  });
});

describe('compile', () => {
  it('returns assembly and slices out one function', async () => {
    const f = fake({ clang: (args) => { if (args.includes('-o')) writeOut(args, 'g:\n\tretq\n\t.globl\tscale\nscale:\n\taddl\t%esi, %edi\n\tretq\n\t.cfi_endproc\n'); return undefined; } });
    const r = res(await invokeTool(f.ctx, compile, { source: C_SRC, flags: ['-O2'], function: 'scale' }));
    expect(r.success).toBe(true);
    expect(r.function_asm).toBe('scale:\n\taddl\t%esi, %edi\n\tretq\n\t.cfi_endproc\n');
  });

  it('reports diagnostics and compiler crashes without throwing', async () => {
    const f = fake({ clang: (args) => (args.includes('-o') ? { exitCode: 1, stderr: 'input.c:1:9: error: use of undeclared identifier \'x\'' } : undefined) });
    const e = await invokeTool(f.ctx, compile, { source: C_SRC });
    expect(e.status).toBe('ok');
    expect(res(e)).toMatchObject({ success: false, compiler_crashed: false, diagnostic_counts: { errors: 1, warnings: 0, total: 1 } });
    const g = fake({ clang: (args) => (args.includes('-o') ? { exitCode: 1, stderr: 'PLEASE submit a bug report\nStack dump:' } : undefined) });
    expect(res(await invokeTool(g.ctx, compile, { source: C_SRC })).compiler_crashed).toBe(true);
  });

  it('refuses plugin flags', async () => {
    const e = await invokeTool(fake({ clang: stampingCompiler }).ctx, compile, { source: C_SRC, flags: ['-fplugin=x.so'] });
    expect(e.error).toMatchObject({ code: 'UNSAFE_FLAG' });
  });

  it('requires exactly one of path or code', async () => {
    const e = await invokeTool(fake({ clang: stampingCompiler }).ctx, compile, { source: { language: 'c' } });
    expect(e.error).toMatchObject({ code: 'INVALID_INPUT' });
    const g = await invokeTool(fake({ clang: stampingCompiler }).ctx, compile, { source: { path: path.join(tmpDir(), 'nope.c') } });
    expect(g.error).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('emit_ir', () => {
  it('asks clang for IR with LLVM passes disabled', async () => {
    const f = fake({ clang: (args) => { if (args.includes('-o')) writeOut(args, 'define i32 @main() {\n  ret i32 0\n}\n'); return undefined; } });
    const e = await invokeTool(f.ctx, emitIr, { source: C_SRC });
    const argv = e.commands.at(-1)!.argv;
    expect(argv).toEqual(expect.arrayContaining(['-O1', '-Xclang', '-disable-llvm-passes', '-emit-llvm']));
    expect(res(e)).toMatchObject({ success: true, functions: ['main'], ir_view: 'frontend.ll' });
  });
});

describe('pass_timeline', () => {
  const dump = [
    '*** IR Dump At Start ***', 'define i32 @f(i32 %x) {', '  %a = add i32 %x, 0', '  ret i32 %a', '}',
    '*** IR Dump After Annotation2MetadataPass on [module] omitted because no change ***',
    '*** IR Dump After InstCombinePass on f ***', 'define i32 @f(i32 %x) {', '  ret i32 %x', '}',
    '*** IR Dump After GlobalOptPass on [module] ***', 'define i32 @f(i32 %x) {', '  ret i32 %x', '}',
  ].join('\n');

  it('returns one diff per changing pass and skips no-ops', async () => {
    const f = fake({ clang: (args) => { if (args.includes('-o')) { writeOut(args, 'ir'); return { stderr: dump }; } return undefined; } });
    const e = await invokeTool(f.ctx, passTimeline, { source: C_SRC, function: 'f' });
    const r = res(e);
    expect(e.commands.at(-1)!.argv).toEqual(expect.arrayContaining(['-mllvm', '-print-changed', '-filter-print-funcs=f']));
    expect(r.steps_total).toBe(1);
    expect(r.noop_passes_skipped).toBe(1);
    expect(r.page.steps[0]).toMatchObject({ pass: 'InstCombinePass', added: 1, removed: 2 });
    expect(r.page.steps[0].diff).toContain('-  %a = add i32 %x, 0');
    expect(f.ctx.ledger.readView(e.evidence_id, 'timeline.diff')).toContain('step 1: InstCombinePass');
    expect(f.ctx.ledger.readView(e.evidence_id, 'step-000-start.ll')).toContain('add i32 %x, 0');
  });

  it('says so when the function does not exist', async () => {
    const f = fake({ clang: (args) => { if (args.includes('-o')) { writeOut(args, 'ir'); return { stderr: dump }; } return undefined; } });
    const e = await invokeTool(f.ctx, passTimeline, { source: C_SRC, function: 'nope' });
    expect(e.error).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('opt_remarks', () => {
  it('groups remarks by function and loop line', async () => {
    const yaml = '--- !Missed\nPass:            loop-vectorize\nName:            MissedDetails\nDebugLoc:        { File: input.c, Line: 14, Column: 3 }\nFunction:        scale\nArgs:\n  - String:          loop not vectorized\n...\n--- !Passed\nPass:            inline\nName:            Inlined\nFunction:        main\nArgs:\n  - String:          inlined\n...\n';
    const f = fake({ clang: (args) => {
      const rec = args.find((a) => a.startsWith('-foptimization-record-file='));
      if (rec) { fs.writeFileSync(rec.split('=')[1]!, yaml); writeOut(args, 'obj'); }
      return undefined;
    } });
    const e = await invokeTool(f.ctx, optRemarks, { source: C_SRC });
    const r = res(e);
    expect(r.counts).toEqual({ missed: 1, analysis: 0, passed: 1 });
    expect(r.by_function.scale.loops['line 14'][0]).toMatchObject({ kind: 'missed', pass: 'loop-vectorize', message: 'loop not vectorized' });
    expect(r.by_function.main.other[0].pass).toBe('inline');
    expect(e.limitations.join(' ')).toMatch(/not a measurement/);
    const only = res(await invokeTool(f.ctx, optRemarks, { source: C_SRC, kinds: ['missed'], function: 'scale' }));
    expect(only.counts).toEqual({ missed: 1, analysis: 0, passed: 0 });
  });
});

describe('check_ub', () => {
  it('reports sanitizer findings with source locations', async () => {
    const f = fake({ clang: stampingCompiler, '*': (_a, _o, cmd) => (read(cmd).includes('-fsanitize') ? { exitCode: 1, stderr: UB_LINE } : undefined) });
    const e = await invokeTool(f.ctx, checkUb, { source: C_SRC });
    const r = res(e);
    expect(r.clean).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ sanitizer: 'ubsan', line: 3, column: 36 });
    expect(e.summary).toMatch(/^UB found: signed integer overflow.* at input\.c:3$/);
    expect(e.inferred.join(' ')).toMatch(/not evidence of a compiler bug/);
    expect(e.commands.filter((c) => c.purpose.startsWith('build')).map((c) => c.argv.find((a) => /^-O/.test(a)))).toEqual(['-O0', '-O1']);
  });

  it('never calls a clean run proof of UB-freedom', async () => {
    const e = await invokeTool(fake({ clang: stampingCompiler, '*': () => ({ stdout: 'ok\n' }) }).ctx, checkUb, { source: C_SRC });
    expect(res(e).clean).toBe(true);
    expect(e.summary).toMatch(/not proof of UB-freedom/);
    expect(e.unknowns.join(' ')).toMatch(/cannot see/);
    expect(e.limitations.join(' ')).toMatch(/strict-aliasing/);
  });

  it('retries with fewer sanitizers when one does not link, and is inconclusive when none does', async () => {
    const f = fake({ clang: (args) => { if (args.some((a) => a.includes('address'))) return { exitCode: 1, stderr: 'ld: cannot find -lasan' }; if (args.includes('-o')) writeOut(args, 'x'); return undefined; }, '*': () => undefined });
    const e = await invokeTool(f.ctx, checkUb, { source: C_SRC, opt_levels: ['O0'] });
    expect(res(e).clean).toBe(true);
    expect(e.coverage['sanitizers_run']).toEqual(['undefined']);
    const none = await invokeTool(fake({ clang: (args) => (args.includes('-o') ? { exitCode: 1, stderr: 'ld: cannot find -lubsan' } : undefined) }).ctx, checkUb, { source: C_SRC });
    expect(none.status).toBe('inconclusive');
    expect(res(none).clean).toBeNull();
  });
});

describe('differential_run', () => {
  it('groups builds by behaviour and flags divergence', async () => {
    const f = fake({ clang: stampingCompiler, '*': (_a, _o, cmd) => ({ stdout: read(cmd).includes('-O0') ? '0\n' : '1\n' }) });
    const e = await invokeTool(f.ctx, differentialRun, { source: C_SRC, compilers: ['clang'], opt_levels: ['O0', 'O1', 'O2'] });
    const r = res(e);
    expect(r.divergent).toBe(true);
    expect(r.behaviours.map((b: { configs: string[] }) => b.configs)).toEqual([['clang-O1', 'clang-O2'], ['clang-O0']]);
    expect(e.unknowns.join(' ')).toMatch(/which of the behaviours is the correct one/i);
  });

  it('detects a program that is non-deterministic on its own', async () => {
    let n = 0;
    const f = fake({ clang: stampingCompiler, '*': () => ({ stdout: String(n++) }) });
    const e = await invokeTool(f.ctx, differentialRun, { source: C_SRC, compilers: ['clang'], opt_levels: ['O0'] });
    expect(res(e).nondeterministic).toEqual(['clang-O0']);
    expect(e.inferred.join(' ')).toMatch(/non-deterministic on its own/);
  });

  it('agrees quietly when nothing differs', async () => {
    const e = await invokeTool(fake({ clang: stampingCompiler, '*': () => ({ stdout: 'same' }) }).ctx, differentialRun, { source: C_SRC, compilers: ['clang'] });
    expect(res(e).divergent).toBe(false);
    expect(e.summary).toBe('all 5 builds agree');
  });
});

describe('bisect_passes', () => {
  const FIRST_BAD = 37;
  const bisectable: Handler = (args) => {
    if (!args.includes('-o')) return undefined;
    const lim = args.find((a) => a.startsWith('-opt-bisect-limit='));
    writeOut(args, lim ? `limit:${lim.split('=')[1]}` : 'ref');
    if (lim?.endsWith('=-1')) return { stderr: Array.from({ length: 64 }, (_, i) => `BISECT: running pass (${i + 1}) pass${i + 1} on f`).join('\n') };
    return undefined;
  };
  const runner: Handler = (_a, _o, cmd) => {
    const c = read(cmd);
    if (c === 'ref') return { stdout: 'good' };
    const n = Number(c.split(':')[1]);
    return { stdout: n === -1 || n >= FIRST_BAD ? 'bad' : 'good' };
  };

  it('finds the first pass that flips the behaviour in O(log n) builds', async () => {
    const e = await invokeTool(fake({ clang: bisectable, '*': runner }).ctx, bisectPasses, { source: C_SRC });
    const r = res(e);
    expect(r.culprit).toEqual({ n: FIRST_BAD, pass: 'pass37', unit: 'f' });
    expect(r.last_good_limit).toBe(36);
    expect(r.first_bad_limit).toBe(37);
    expect(r.builds).toBeLessThanOrEqual(9);
    expect(r.repro_flags.bad).toEqual(['-O2', '-mllvm', '-opt-bisect-limit=37']);
    expect(e.unknowns.join(' ')).toMatch(/Whether that pass is itself incorrect/);
  });

  it('is inconclusive when nothing misbehaves, or when skipping all passes does not help', async () => {
    const same = await invokeTool(fake({ clang: bisectable, '*': () => ({ stdout: 'good' }) }).ctx, bisectPasses, { source: C_SRC });
    expect(same.status).toBe('inconclusive');
    expect(res(same).reproduced).toBe(false);
    const always = await invokeTool(fake({ clang: bisectable, '*': (_a, _o, cmd) => ({ stdout: read(cmd) === 'ref' ? 'good' : 'bad' }) }).ctx, bisectPasses, { source: C_SRC });
    expect(always.status).toBe('inconclusive');
    expect(res(always).culprit).toBeNull();
    expect(always.inferred.join(' ')).toMatch(/does not come from a skippable optimisation pass/);
  });

  it('scans -fno- flags for GCC', async () => {
    const gcc: Handler = (args) => {
      if (args.includes('--help=optimizers')) return { stdout: '  -fstrict-aliasing            \t\t[enabled]\n  -ftree-vrp                  \t\t[enabled]\n  -funroll-loops              \t\t[disabled]\n' };
      if (args.includes('-o')) writeOut(args, args.join(' '));
      return undefined;
    };
    const run: Handler = (_a, _o, cmd) => { const c = read(cmd); return { stdout: c.includes('-O0') || c.includes('-fno-strict-aliasing') ? 'good' : 'bad' }; };
    const e = await invokeTool(fake({ gcc, '*': run }).ctx, bisectPasses, { source: C_SRC, compiler: 'gcc' });
    expect(res(e)).toMatchObject({ method: 'gcc-flag-scan', fixing_flags: ['-fstrict-aliasing'], flags_scanned: 2 });
  });
});

describe('reduce_testcase', () => {
  const big = Array.from({ length: 30 }, (_, i) => `int v${i};`);
  big[17] = 'int CRASH_HERE;';
  const crashing: Handler = (args) => {
    if (!args.includes('-o')) return undefined;
    if (read(srcArg(args)).includes('CRASH_HERE')) return { exitCode: 1, stderr: "clang: Sema.cpp:10: Assertion `Ty' failed.\nPLEASE submit a bug report" };
    writeOut(args, 'obj');
    return undefined;
  };
  // Stands in for `node interesting.mjs <file>`: interesting while the trigger line survives.
  const interesting: Handler = (args) => ({ exitCode: read(args[1]!).includes('CRASH_HERE') ? 0 : 1, stderr: 'not interesting: crash gone' });

  it('reduces a crash with the built-in reducer and re-verifies the result', async () => {
    const f = fake({ clang: crashing, node: interesting });
    const e = await invokeTool(f.ctx, reduceTestcase, { source: { code: big.join('\n'), language: 'c' }, kind: 'crash' });
    const r = res(e);
    expect(e.status).toBe('ok');
    expect(r).toMatchObject({ verified: true, reducer: 'builtin', before: { lines: 30 }, after: { lines: 1 } });
    expect(r.reduced_source).toBe('int CRASH_HERE;');
    expect(r.interestingness).toMatch(/Assertion `Ty' failed/);
    const script = f.ctx.ledger.readView(e.evidence_id, 'interesting.mjs');
    expect(script).toContain('"expect": "crash"');
    expect(script).toContain("Assertion `Ty' failed.");
    expect(e.limitations.join(' ')).toMatch(/built-in line-based/);
  });

  it('refuses to reduce when the compiler does not crash', async () => {
    const e = await invokeTool(fake({ clang: stampingCompiler, node: interesting }).ctx, reduceTestcase, { source: C_SRC, kind: 'crash' });
    expect(e.error).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses to reduce a miscompile whose original has UB under sanitizers', async () => {
    const run: Handler = (_a, _o, cmd) => { const c = read(cmd); if (c.includes('-fsanitize')) return { exitCode: 1, stderr: UB_LINE }; return { stdout: c.includes('-O0') ? '0' : '1' }; };
    const e = await invokeTool(fake({ clang: stampingCompiler, '*': run, node: interesting }).ctx, reduceTestcase, { source: C_SRC, kind: 'miscompile' });
    expect(e.error?.message).toMatch(/undefined behaviour under sanitizers/);
    expect(e.error?.remediation).toMatch(/check_ub/);
  });

  it('builds a miscompile test that pins both outputs and keeps the UB guard', async () => {
    const run: Handler = (_a, _o, cmd) => ({ stdout: read(cmd).includes('-O2') ? '1' : '0' });
    const f = fake({ clang: stampingCompiler, '*': run, node: () => ({ exitCode: 0 }) });
    const e = await invokeTool(f.ctx, reduceTestcase, { source: C_SRC, kind: 'miscompile', max_tests: 5 });
    expect(res(e).ub_guard).toBe('sanitizers');
    const cfg = f.ctx.ledger.readView(e.evidence_id, 'interesting.mjs');
    for (const needle of ['-fsanitize=undefined,address', '"forbid_stderr"', 'runtime error:', '"expect_stdout_sha256"', '"type": "differ"', '-Werror=implicit-function-declaration']) {
      expect(cfg, needle).toContain(needle);
    }
    expect(e.unknowns.join(' ')).toMatch(/sanitizers cannot see/);
  });

  it('refuses when the two configurations already agree', async () => {
    const e = await invokeTool(fake({ clang: stampingCompiler, '*': () => ({ stdout: 'x' }) }).ctx, reduceTestcase, { source: C_SRC, kind: 'miscompile' });
    expect(e.error?.message).toMatch(/behave the same/);
  });
});

describe('validate_transform', () => {
  const IR = { code: 'define i1 @src(i32 %x) {\n  ret i1 true\n}\ndefine i1 @tgt(i32 %x) {\n  ret i1 true\n}\n' };
  const BAD = "----------------------------------------\ndefine i1 @src(i32 %x) {\n  ret i1 1\n}\n=>\ndefine i1 @tgt(i32 %x) {\n  ret i1 1\n}\nTransformation doesn't verify!\n\nERROR: Value mismatch\n\nExample:\ni32 %x = #x7fffffff (2147483647)\n\nSummary:\n  0 correct transformations\n  1 incorrect transformations\n";
  const GOOD = '----------------------------------------\ndefine i1 @src(i32 %x) {\n  ret i1 1\n}\nTransformation seems to be correct!\n\nSummary:\n  1 correct transformations\n  0 incorrect transformations\n';

  it('returns the counterexample from a local alive-tv', async () => {
    const e = await invokeTool(fake({ 'alive-tv': (args) => (args[0] === '--version' ? undefined : { stdout: BAD }) }).ctx, validateTransform, { pair: IR });
    const r = res(e);
    expect(r.verdict).toBe('incorrect');
    expect(r.pairs[0].counterexample).toContain('2147483647');
    expect(e.summary).toBe('INCORRECT: src: Value mismatch');
    expect(e.commands.at(-1)!.argv.at(-1)).toBe('--smt-to=60000');
  });

  it('qualifies a "correct" verdict with what Alive2 cannot see', async () => {
    const e = await invokeTool(fake({ 'alive-tv': (args) => (args[0] === '--version' ? undefined : { stdout: GOOD }) }).ctx, validateTransform, { pair: IR });
    expect(res(e).verdict).toBe('correct');
    expect(e.summary).toMatch(/within Alive2 bounds/);
    expect(e.limitations.join(' ')).toMatch(/bounded/);
    expect(e.unknowns.length).toBeGreaterThan(0);
  });

  it('does not use the network unless the remote provider is enabled', async () => {
    const e = await invokeTool(fake({}).ctx, validateTransform, { pair: IR });
    expect(e.status).toBe('unavailable');
    expect(e.error!.remediation).toMatch(/CEA_REMOTE_PROVIDERS=compiler-explorer/);
    const forced = await invokeTool(fake({}).ctx, validateTransform, { pair: IR, provider: 'remote' });
    expect(forced.error).toMatchObject({ code: 'REMOTE_DISABLED' });
  });

  it('uses the Alive2 online instance when explicitly enabled, and says that it did', async () => {
    const seen: { url: string; body: string }[] = [];
    const fetchFn = (async (url: string, init: { body: string }) => {
      seen.push({ url, body: init.body });
      return { ok: true, status: 200, json: async () => ({ code: 0, asm: [{ text: GOOD }] }) };
    }) as unknown as typeof fetch;
    const f = fake({}, { remote: true, fetch: fetchFn });
    const before = 'define i32 @f(i32 %x) {\n  %a = add i32 %x, 0\n  ret i32 %a\n}\n';
    const after = 'define i32 @f(i32 %x) {\n  ret i32 %x\n}\n';
    const e = await invokeTool(f.ctx, validateTransform, { before: { code: before }, after: { code: after } });
    expect(res(e).verdict).toBe('correct');
    expect(seen[0]!.url).toBe('https://alive2.llvm.org/ce/api/compiler/alive/compile');
    const sent = JSON.parse(seen[0]!.body).source as string;
    expect(sent).toContain('@src(i32 %x)');
    expect(sent).toContain('@tgt(i32 %x)');
    expect(e.observed.join(' ')).toMatch(/IR was sent to https:\/\/alive2\.llvm\.org/);
  });

  it('explains a missing verdict on IR that uses !tbaa', async () => {
    const fetchFn = (async () => ({ ok: true, status: 200, json: async () => ({ code: 1, asm: [{ text: '<Compilation failed>' }] }) })) as unknown as typeof fetch;
    const ir = 'define i32 @f(ptr %p) {\n  %v = load i32, ptr %p, align 4, !tbaa !1\n  ret i32 %v\n}\n!1 = !{!2, !2, i64 0}\n!2 = !{!"int"}\n';
    const e = await invokeTool(fake({}, { remote: true, fetch: fetchFn }).ctx, validateTransform, { before: { code: ir }, after: { code: ir } });
    expect(e.status).toBe('inconclusive');
    expect(res(e).uses_tbaa).toBe(true);
    expect(e.summary).toMatch(/!tbaa/);
  });

  it('rejects ambiguous input', async () => {
    const e = await invokeTool(fake({}).ctx, validateTransform, { pair: IR, before: IR });
    expect(e.error).toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('analyze_throughput', () => {
  const MCA = 'Iterations:        100\nInstructions:      200\nTotal Cycles:      58\nTotal uOps:        200\n\nDispatch Width:    6\nuOps Per Cycle:    3.45\nIPC:               3.45\nBlock RThroughput: 0.5\n\nNo resource or data dependency bottlenecks discovered.\n';
  it('runs llvm-mca on one function and always carries the static-model limitation', async () => {
    const f = fake({
      clang: (args) => { if (args.includes('-o')) writeOut(args, '\t.text\nscale:\n\taddl\t%esi, %edi\n\tretq\n\t.cfi_endproc\n'); return undefined; },
      'llvm-mca': (args) => (args[0] === '--version' ? undefined : { stdout: MCA }),
    });
    const e = await invokeTool(f.ctx, analyzeThroughput, { source: C_SRC, function: 'scale', cpu: 'skylake' });
    const r = res(e);
    expect(r.summary).toMatchObject({ ipc: 3.45, block_rthroughput: 0.5 });
    expect(r.instructions_in_region).toBe(2);
    expect(e.commands.at(-1)!.argv).toEqual(expect.arrayContaining(['-mcpu=skylake', '-mtriple=x86_64-pc-linux-gnu']));
    expect(e.limitations[0]).toMatch(/ignores caches.*branch misprediction/);
    expect(e.summary).toMatch(/ignores caches and branch misses/);
    expect(f.ctx.ledger.readView(e.evidence_id, 'region.s')).toBe('scale:\n\taddl\t%esi, %edi\n\tretq\n');
  });

  it('requires a CPU name', async () => {
    const e = await invokeTool(fake({}).ctx, analyzeThroughput, { asm: 'retq' });
    expect(e.error).toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('benchmark', () => {
  it('reports median and spread and refuses a speed claim when ranges overlap', async () => {
    const f = fake({ clang: stampingCompiler, '*': () => ({ stdout: '42\n' }) });
    const e = await invokeTool(f.ctx, benchmark, { source: C_SRC, variants: [{ name: 'base', flags: ['-O1'] }, { name: 'new', flags: ['-O3'] }], runs: 5, warmup: 1 });
    const r = res(e);
    expect(r.variants.base.stats.runs).toBe(5);
    expect(r.variants.new.output_correct).toBe(true);
    expect(r.comparisons[0]).toMatchObject({ variant: 'new', baseline: 'base' });
    expect(typeof r.comparisons[0].ranges_overlap).toBe('boolean');
    expect(r.machine.logical_cpus).toBeGreaterThan(0);
    expect(e.commands.filter((c) => c.purpose.startsWith('timed run')).length).toBe(10);
    expect(e.limitations.join(' ')).toMatch(/Wall-clock/);
  });

  it('disqualifies a variant that prints the wrong answer: semantics before speed', async () => {
    const f = fake({ clang: stampingCompiler, '*': (_a, _o, cmd) => ({ stdout: read(cmd).includes('-ffast') ? '43\n' : '42\n' }) });
    const e = await invokeTool(f.ctx, benchmark, { source: C_SRC, variants: [{ name: 'base' }, { name: 'fast', flags: ['-O3', '-ffast'] }], runs: 5, warmup: 0 });
    const r = res(e);
    expect(r.disqualified).toEqual(['fast']);
    expect(r.variants.fast.output_correct).toBe(false);
    expect(r.variants.fast.stats).toBeUndefined();
    expect(r.comparisons).toEqual([]);
  });

  it('refuses fewer than five runs', async () => {
    const e = await invokeTool(fake({ clang: stampingCompiler }).ctx, benchmark, { source: C_SRC, variants: [{ name: 'a' }], runs: 3 });
    expect(e.error).toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('fuzz_compiler', () => {
  const saved = process.env['CEA_CSMITH_INCLUDE'];
  afterEach(() => {
    if (saved === undefined) delete process.env['CEA_CSMITH_INCLUDE'];
    else process.env['CEA_CSMITH_INCLUDE'] = saved;
  });

  it('saves each divergence as a candidate with its seed', async () => {
    const inc = tmpDir();
    fs.writeFileSync(path.join(inc, 'csmith.h'), '');
    process.env['CEA_CSMITH_INCLUDE'] = inc;
    const f = fake({
      csmith: (args) => (args[0] === '--seed' ? { stdout: `/* seed ${args[1]} */ int main(void){return 0;}\n` } : undefined),
      clang: stampingCompiler,
      '*': (_a, _o, cmd) => ({ stdout: cmd.includes('seed-101') && read(cmd).includes('-O2') ? 'checksum = 1\n' : 'checksum = 0\n' }),
    });
    const e = await invokeTool(f.ctx, fuzzCompiler, { compilers: ['clang'], seed_start: 100, max_programs: 3, duration_s: 60 });
    const r = res(e);
    expect(r.programs_compared).toBe(3);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ seed: 101, kind: 'divergence' });
    expect(fs.readFileSync(path.join(r.candidates[0].path, 'prog.c'), 'utf8')).toContain('seed 101');
    expect(e.inferred.join(' ')).toMatch(/a lead, not a compiler bug/);
  });

  it('is unavailable without a generator and says how to get one', async () => {
    const e = await invokeTool(fake({ clang: stampingCompiler }).ctx, fuzzCompiler, {});
    expect(e.status).toBe('unavailable');
    expect(e.error!.remediation).toMatch(/csmith/);
  });
});

describe('bisect_compiler_history', () => {
  const GOOD = 'a'.repeat(40);
  const BAD = 'b'.repeat(40);
  const FIRST = 'c'.repeat(40);
  const git = (dirty = false): Handler => (args) => {
    const a = args.slice(2).join(' ');
    if (a.startsWith('status')) return { stdout: dirty ? ' M file.c\n' : '' };
    if (a.startsWith('rev-parse')) return { stdout: `${a.includes('good-tag') ? GOOD : BAD}\n` };
    if (a.startsWith('rev-list')) return { stdout: '5\n' };
    if (a.startsWith('bisect run')) return { stdout: `running...\n${FIRST} is the first bad commit\n` };
    if (a.startsWith('bisect log')) return { stdout: 'git bisect start\n# good\n' };
    if (a.startsWith('show')) return { stdout: 'ccccccc 2026-01-02 Dev\nRewrite the folder\n' };
    return undefined;
  };
  const repo = () => { const d = tmpDir(); fs.mkdirSync(path.join(d, '.git')); return d; };

  it('drives git bisect run and always resets', async () => {
    const f = fake({ git: git() });
    const e = await invokeTool(f.ctx, bisectCompilerHistory, { repo: repo(), good: 'good-tag', bad: 'HEAD', test: [process.execPath, 'test.mjs'] });
    expect(res(e)).toMatchObject({ first_bad_commit: FIRST, commits_in_range: 5, good: GOOD, bad: BAD });
    const cmds = e.commands.map((c) => c.argv.slice(3).join(' '));
    expect(cmds).toContain(`bisect start ${BAD} ${GOOD}`);
    expect(cmds.at(-2)).toBe('bisect reset');
    const runner = f.ctx.ledger.readView(e.evidence_id, 'bisect-runner.mjs');
    expect(runner).toContain('"test_exit_zero_means": "bad"');
    expect(runner).toContain('process.exit(125)');
  });

  it('understands the quoted wording of newer git versions', async () => {
    const quoted: Handler = (args) => (args.slice(2).join(' ').startsWith('bisect run') ? { stdout: `${FIRST} is the first 'bad' commit\n` } : git()(args, undefined, ''));
    const e = await invokeTool(fake({ git: quoted }).ctx, bisectCompilerHistory, { repo: repo(), good: 'good-tag', bad: 'HEAD', test: ['t'] });
    expect(res(e).first_bad_commit).toBe(FIRST);
  });

  it('refuses a dirty checkout and option-like revisions', async () => {
    const dirty = await invokeTool(fake({ git: git(true) }).ctx, bisectCompilerHistory, { repo: repo(), good: 'good-tag', bad: 'HEAD', test: ['t'] });
    expect(dirty.error?.message).toMatch(/uncommitted changes/);
    const inj = await invokeTool(fake({ git: git() }).ctx, bisectCompilerHistory, { repo: repo(), good: '--upload-pack=evil', bad: 'HEAD', test: ['t'] });
    expect(inj.error).toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('triage_miscompile', () => {
  it('stops at undefined behaviour and says it is not a compiler bug', async () => {
    const f = fake({ clang: stampingCompiler, '*': (_a, _o, cmd) => (read(cmd).includes('-fsanitize') ? { exitCode: 1, stderr: UB_LINE } : { stdout: 'x' }) });
    const file = path.join(tmpDir(), 'foo.c');
    fs.writeFileSync(file, C_SRC.code);
    const e = await invokeTool(f.ctx, triageMiscompile, { source: { path: file } });
    const r = res(e);
    expect(r.verdict).toBe('undefined_behavior');
    expect(r.is_compiler_bug).toBe('no');
    expect(e.summary).toBe("UB found at foo.c:3:36 (signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'), not a compiler bug");
    expect(r.steps.map((s: { step: string }) => s.step)).toEqual(['environment', 'check_ub']);
    expect(e.derived_from).toHaveLength(2);
    for (const id of e.derived_from) expect(f.ctx.ledger.get(id)).toBeDefined();
    expect(r.report_markdown).toContain('do not file a compiler bug');
    expect(r.report_markdown).toContain(e.derived_from[1]!);
  });

  it('stops when the difference does not reproduce', async () => {
    const e = await invokeTool(fake({ clang: stampingCompiler, '*': () => ({ stdout: 'same' }) }).ctx, triageMiscompile, { source: C_SRC });
    expect(res(e).verdict).toBe('not_reproduced');
    expect(res(e).steps.map((s: { step: string }) => s.step)).toEqual(['environment', 'check_ub', 'differential_run']);
  });

  it('never claims a compiler bug when -fwrapv/-fno-strict-aliasing hides the difference', async () => {
    const compiler: Handler = (args) => {
      if (!args.includes('-o')) return undefined;
      writeOut(args, args.join(' '));
      if (args.includes('-opt-bisect-limit=-1')) return { stderr: Array.from({ length: 8 }, (_, i) => `BISECT: running pass (${i + 1}) instcombine on f`).join('\n') };
      return undefined;
    };
    const run: Handler = (_a, _o, cmd) => {
      const c = read(cmd);
      const lim = /-opt-bisect-limit=(-?\d+)/.exec(c);
      const optimised = c.includes('-O2') && !c.includes('-fno-strict-aliasing') && (!lim || lim[1] === '-1' || Number(lim[1]) >= 5);
      return { stdout: optimised ? '1' : '0' };
    };
    const e = await invokeTool(fake({ clang: compiler, '*': run }).ctx, triageMiscompile, { source: C_SRC, reduce: false, validate: false });
    const r = res(e);
    expect(r.verdict).toBe('suspected_undetected_ub');
    expect(r.is_compiler_bug).toBe('unlikely');
    expect(r.culprit).toMatchObject({ n: 5, pass: 'instcombine' });
    expect(r.semantic_probe_hides_difference).toBe(true);
    expect(r.report_markdown).toContain('not a bug report');
  });
});

describe('ledger tools', () => {
  it('pages and filters views, lists evidence, tracks unknowns and exports a bundle', async () => {
    const f = fake({ clang: (args) => { if (args.includes('-o')) writeOut(args, Array.from({ length: 50 }, (_, i) => `line${i}${i % 10 === 0 ? ' mark' : ''}`).join('\n')); return undefined; } });
    const e = await invokeTool(f.ctx, compile, { source: C_SRC });

    const page = await callTool(f.ctx, inspectEvidenceView, { evidence_id: e.evidence_id, view: 'output.s', offset: 10, limit: 3 });
    expect(page.schema).toBe('cea.response/1');
    expect(res(page)).toMatchObject({ text: 'line10 mark\nline11\nline12', total_lines: 50, next_offset: 13 });
    const grep = res(await callTool(f.ctx, inspectEvidenceView, { evidence_id: e.evidence_id, view: 'output.s', contains: 'mark' }));
    expect(grep.matching_lines).toBe(5);
    expect(grep.text.split('\n')[1]).toBe('10: line10 mark');
    expect(res(await callTool(f.ctx, inspectEvidenceView, { evidence_id: e.evidence_id })).evidence.evidence_id).toBe(e.evidence_id);
    expect((await callTool(f.ctx, inspectEvidenceView, { evidence_id: 'ev_compile_ffffffff' })).error).toMatchObject({ code: 'NOT_FOUND' });

    expect(res(await callTool(f.ctx, listEvidence, {})).total).toBe(1);
    expect(f.ctx.ledger.list()).toHaveLength(1); // ledger tools do not create evidence

    const bogus = await callTool(f.ctx, recordUnknown, { question: 'Is the loop bound invariant?', supporting_evidence: ['ev_compile_00000000'] });
    expect(bogus.error?.message).toMatch(/unknown evidence id/);
    const u = res(await callTool(f.ctx, recordUnknown, { question: 'Is the loop bound invariant?', why_it_matters: 'decides vectorisation' })).unknown;
    expect(u).toMatchObject({ status: 'open', supporting_evidence: [] });
    const early = await callTool(f.ctx, updateUnknown, { unknown_id: u.unknown_id, status: 'resolved', resolution: 'yes' });
    expect(early.error?.message).toMatch(/cannot be resolved without evidence/);
    const done = res(await callTool(f.ctx, updateUnknown, { unknown_id: u.unknown_id, status: 'resolved', resolution: 'yes', add_supporting_evidence: [e.evidence_id], note: 'see asm' })).unknown;
    expect(done).toMatchObject({ status: 'resolved', supporting_evidence: [e.evidence_id], notes: ['see asm'] });

    const out = path.join(tmpDir(), 'bundle.cea.json');
    const b = res(await callTool(f.ctx, exportEvidenceBundle, { output_path: out }));
    expect(b).toMatchObject({ evidence_count: 1, unknown_count: 1 });
    const bundle = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(bundle.schema).toBe('cea.bundle/1');
    expect(bundle.evidence[0].evidence_id).toBe(e.evidence_id);
    expect(bundle.views.find((v: { name: string }) => v.name === 'output.s').text).toContain('line49');
    expect(fs.readFileSync(b.index_path, 'utf8')).toContain(e.evidence_id);
  });
});
