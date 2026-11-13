import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { instructionsOnly, parseMcaSummary } from '../../src/tools/analyze_throughput.js';
import { computeStats } from '../../src/tools/benchmark.js';
import { parseBisectLines } from '../../src/tools/bisect_passes.js';
import { parseSanitizerOutput } from '../../src/tools/check_ub.js';
import { extractAsmFunction } from '../../src/tools/compile.js';
import { findCsmithInclude } from '../../src/tools/fuzz_compiler.js';
import { parseGccOptInfo, parseLlvmRemarks } from '../../src/tools/opt_remarks.js';
import { extractIrFunction, parsePrintChanged } from '../../src/tools/pass_timeline.js';
import { deriveCrashSignature } from '../../src/tools/reduce_testcase.js';
import { combineForAlive, parseAliveOutput } from '../../src/tools/validate_transform.js';
import { tmpDir } from '../helpers.js';

describe('pass_timeline parsing', () => {
  const dump = [
    '*** IR Dump At Start ***',
    'define i32 @f(i32 %x) {',
    '  %a = add i32 %x, 0',
    '  ret i32 %a',
    '}',
    '*** IR Dump After Annotation2MetadataPass on [module] omitted because no change ***',
    '*** IR Dump After InstCombinePass on f ***',
    'define i32 @f(i32 %x) {',
    '  ret i32 %x',
    '}',
    '*** IR Pass PassManager<Function> on f ignored ***',
    '*** IR Dump After SROAPass on g filtered out ***',
    '*** IR Dump After LoopDeletionPass on loop %bb (invalidated) ***',
    '; Preheader:',
  ].join('\n');

  it('splits -print-changed output into snapshots and counts no-op passes', () => {
    const p = parsePrintChanged(dump);
    expect(p.initial).toContain('add i32 %x, 0');
    expect(p.noop).toBe(1);
    expect(p.filtered).toBe(1);
    expect(p.snapshots.map((s) => [s.pass, s.unit])).toEqual([['InstCombinePass', 'f'], ['LoopDeletionPass', 'loop %bb']]);
    expect(p.snapshots[0]!.body).toBe('define i32 @f(i32 %x) {\n  ret i32 %x\n}');
  });

  it('extracts one function from a module, including quoted names', () => {
    const ir = 'declare void @g()\n\ndefine dso_local i32 @f(i32 %x) #0 {\nentry:\n  ret i32 %x\n}\n\ndefine void @"weird.name"() {\n  ret void\n}\n';
    expect(extractIrFunction(ir, 'f')).toBe('define dso_local i32 @f(i32 %x) #0 {\nentry:\n  ret i32 %x\n}');
    expect(extractIrFunction(ir, 'weird.name')).toContain('ret void');
    expect(extractIrFunction(ir, 'g')).toBeNull();
    expect(extractIrFunction(ir, 'missing')).toBeNull();
  });
});

describe('bisect_passes parsing', () => {
  it('reads pass numbers, names and units', () => {
    const out = 'BISECT: running pass (1) annotation2metadata on [module]\nBISECT: running pass (13) early-cse on check\nBISECT: NOT running pass (14) InstCombinePass on function (main)\nnoise';
    expect(parseBisectLines(out)).toEqual([
      { n: 1, pass: 'annotation2metadata', unit: '[module]' },
      { n: 13, pass: 'early-cse', unit: 'check' },
      { n: 14, pass: 'InstCombinePass', unit: 'main' },
    ]);
  });
});

describe('check_ub parsing', () => {
  it('parses UBSan reports with Windows and POSIX paths', () => {
    const f = parseSanitizerOutput("C:\\w\\input.c:3:36: runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'\nSUMMARY: UndefinedBehaviorSanitizer: undefined-behavior\n/t/a.c:9:3: runtime error: index 4 out of bounds for type 'int[4]'", 'O0');
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ sanitizer: 'ubsan', file: 'C:\\w\\input.c', line: 3, column: 36, opt_level: 'O0' });
    expect(f[0]!.message).toMatch(/signed integer overflow/);
    expect(f[1]).toMatchObject({ file: '/t/a.c', line: 9 });
  });

  it('parses ASan reports and takes the first user frame', () => {
    const f = parseSanitizerOutput([
      '==123==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602000000014 at pc 0x0001',
      'READ of size 4 at 0x602000000014 thread T0',
      '    #0 0x4c3a1f in __asan_memcpy /src/compiler-rt/lib/asan/asan_interceptors.cpp:22:3',
      '    #1 0x4f1b2c in get /home/u/t.c:7:10',
      '    #2 0x4f1c11 in main /home/u/t.c:12:3',
    ].join('\n'), 'O1');
    expect(f).toEqual([{ sanitizer: 'asan', kind: 'heap-buffer-overflow', message: 'AddressSanitizer: heap-buffer-overflow on address 0x602000000014 at pc 0x0001', file: '/home/u/t.c', line: 7, column: 10, opt_level: 'O1' }]);
  });

  it('parses MSan warnings and returns nothing for clean output', () => {
    expect(parseSanitizerOutput('==1==WARNING: MemorySanitizer: use-of-uninitialized-value\n    #0 0x1 in main /t/m.c:4:7', 'O0')[0]).toMatchObject({ sanitizer: 'msan', kind: 'use-of-uninitialized-value', line: 4 });
    expect(parseSanitizerOutput('hello\n', 'O0')).toEqual([]);
  });
});

describe('opt_remarks parsing', () => {
  it('parses LLVM optimisation records', () => {
    const yaml = [
      '--- !Missed',
      'Pass:            loop-vectorize',
      'Name:            MissedDetails',
      "DebugLoc:        { File: 'C:\\w\\input.c', Line: 14, Column: 3 }",
      'Function:        scale',
      'Args:',
      '  - String:          loop not vectorized',
      '...',
      '--- !Analysis',
      'Pass:            loop-vectorize',
      'Name:            UnsupportedUncountableLoop',
      'DebugLoc:        { File: a.c, Line: 14, Column: 3 }',
      'Function:        scale',
      'Args:',
      "  - String:          'loop not vectorized: '",
      "  - String:          Cannot vectorize uncountable loop",
      '...',
      '--- !Passed',
      'Pass:            inline',
      'Name:            Inlined',
      'Function:        main',
      'Args:',
      "  - String:          ''''",
      '  - Callee:          helper',
      '    DebugLoc:        { File: a.c, Line: 2, Column: 0 }',
      "  - String:          ''' inlined into '''",
      '  - Caller:          main',
      '...',
    ].join('\n');
    const r = parseLlvmRemarks(yaml);
    expect(r.map((x) => x.kind)).toEqual(['missed', 'analysis', 'passed']);
    expect(r[0]).toMatchObject({ pass: 'loop-vectorize', function: 'scale', line: 14, column: 3, message: 'loop not vectorized' });
    expect(r[1]!.message).toBe('loop not vectorized: Cannot vectorize uncountable loop');
    expect(r[2]!.message).toBe("'helper' inlined into 'main");
    expect(r[2]!.line).toBeNull();
  });

  it('parses GCC -fopt-info lines', () => {
    const r = parseGccOptInfo("a.c:14:21: missed: couldn't vectorize loop\na.c:14:21: optimized: loop vectorized using 16 byte vectors\na.c:3:1: note: vectorized 1 loops in function.\ngarbage");
    expect(r.map((x) => [x.kind, x.pass, x.line])).toEqual([['missed', 'vect', 14], ['passed', 'vect', 14], ['analysis', 'vect', 3]]);
  });
});

describe('analyze_throughput parsing', () => {
  it('reads the llvm-mca summary', () => {
    const s = parseMcaSummary('Iterations:        100\nInstructions:      400\nTotal Cycles:      110\nTotal uOps:        400\n\nDispatch Width:    6\nuOps Per Cycle:    3.64\nIPC:               3.64\nBlock RThroughput: 1.0\n');
    expect(s).toEqual({ iterations: 100, instructions: 400, total_cycles: 110, total_uops: 400, dispatch_width: 6, uops_per_cycle: 3.64, ipc: 3.64, block_rthroughput: 1 });
    expect(parseMcaSummary('nothing').ipc).toBeNull();
  });

  it('keeps labels, instructions and region markers; drops directives', () => {
    const asm = '\t.text\n\t.globl\tf\nf:\n\t.cfi_startproc\n# LLVM-MCA-BEGIN loop\n.LBB0_1:\n\taddl\t$1, %eax\n\tjne\t.LBB0_1\n# LLVM-MCA-END\n# a comment\n\tretq\n\t.cfi_endproc\n';
    expect(instructionsOnly(asm)).toBe('f:\n# LLVM-MCA-BEGIN loop\n.LBB0_1:\n\taddl\t$1, %eax\n\tjne\t.LBB0_1\n# LLVM-MCA-END\n\tretq\n');
  });

  it('slices one function out of ELF, Mach-O and COFF style assembly', () => {
    const elf = '\t.globl\tf\nf:\n\t.cfi_startproc\n\tretq\n\t.cfi_endproc\n\t.size\tf, .-f\n\t.globl\tg\ng:\n\tretq\n';
    expect(extractAsmFunction(elf, 'f')).toBe('f:\n\t.cfi_startproc\n\tretq\n\t.cfi_endproc\n');
    expect(extractAsmFunction('_f:\n\tretq\n\t.globl\t_g\n_g:\n\tretq\n', 'f')).toBe('_f:\n\tretq\n');
    expect(extractAsmFunction('f:\n.seh_proc f\n\tretq\n\t.seh_endproc\n\t.def\tg;\n', 'f')).toContain('.seh_endproc');
    expect(extractAsmFunction(elf, 'nope')).toBeNull();
  });
});

describe('validate_transform parsing', () => {
  const incorrect = [
    '', '----------------------------------------',
    'define i1 @src(i32 %x) {', '#0:', '  %a = add i32 %x, 1', '  %c = icmp sgt i32 %a, %x', '  ret i1 %c', '}',
    '=>', 'define i1 @tgt(i32 %x) {', '#0:', '  ret i1 1', '}',
    "Transformation doesn't verify!", '', 'ERROR: Value mismatch', '',
    'Example:', 'i32 %x = #x7fffffff (2147483647)', '', 'Source:', 'i32 %a = #x80000000 (2147483648, -2147483648)', 'i1 %c = #x0 (0)', '',
    'Target:', 'Source value: #x0 (0)', 'Target value: #x1 (1)', '',
    'Summary:', '  0 correct transformations', '  1 incorrect transformations', '  0 failed-to-prove transformations', '  0 Alive2 errors',
  ].join('\n');

  it('extracts the verdict, the error and the counterexample', () => {
    const r = parseAliveOutput(incorrect);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]).toMatchObject({ function: 'src', verdict: 'incorrect', error: 'Value mismatch' });
    expect(r.pairs[0]!.counterexample).toMatch(/^Example:\ni32 %x = #x7fffffff \(2147483647\)/);
    expect(r.pairs[0]!.counterexample).not.toMatch(/Summary/);
    expect(r.summary).toEqual({ correct: 0, incorrect: 1, failed_to_prove: 0, errors: 0 });
  });

  it('recognises correct and unproven results', () => {
    const ok = '----------------------------------------\ndefine i1 @f() {\n  ret i1 1\n}\n=>\ndefine i1 @f() {\n  ret i1 1\n}\nTransformation seems to be correct!\n\nSummary:\n  1 correct transformations\n  0 incorrect transformations\n';
    expect(parseAliveOutput(ok).pairs).toEqual([{ function: 'f', verdict: 'correct', error: null, counterexample: null }]);
    const to = "----------------------------------------\ndefine i1 @f() {\n  ret i1 1\n}\nTransformation doesn't verify!\n\nERROR: Timeout\n";
    expect(parseAliveOutput(to).pairs[0]!.verdict).toBe('unproven');
    expect(parseAliveOutput('<Compilation failed>').pairs).toEqual([]);
  });

  it('merges before/after modules keeping only what the function reaches', () => {
    const before = [
      'target triple = "x86_64-pc-linux-gnu"',
      '@g = global i32 0',
      '@unused = global i32 7',
      'define dso_local i32 @f(ptr %p) #0 {',
      '  %v = load i32, ptr %p, align 4, !range !3',
      '  call void @ext()',
      '  ret i32 %v',
      '}',
      'declare void @ext() #1',
      'declare void @other()',
      'attributes #0 = { nounwind }',
      'attributes #1 = { nofree }',
      '!llvm.dbg.cu = !{!0}',
      '!0 = distinct !DICompileUnit(file: !1)',
      '!1 = !DIFile(filename: "/home/alice/secret/input.c", directory: "/home/alice/secret")',
      '!3 = !{i32 0, i32 10}',
    ].join('\n');
    const after = before.replace('  call void @ext()\n', '');
    const m = combineForAlive(before, after, 'f');
    expect(m).toContain('define dso_local i32 @src(ptr %p) #0 {');
    expect(m).toContain('define dso_local i32 @tgt(ptr %p) #100000 {');
    expect(m).toContain('!range !100003');
    expect(m).toContain('!100003 = !{i32 0, i32 10}');
    expect(m).toContain('!3 = !{i32 0, i32 10}');
    expect(m).toContain('attributes #100000 = { nounwind }');
    expect(m).toContain('declare void @ext() #1');
    expect(m).toContain('attributes #1 = { nofree }');
    // Unreached material stays local: other declarations, globals, debug info with file paths.
    expect(m).not.toContain('@other');
    expect(m).not.toContain('@unused');
    expect(m).not.toContain('alice');
    expect(m).not.toContain('DICompileUnit');
    expect(() => combineForAlive(before, after, 'nope')).toThrow(/not defined in both/);
  });
});

describe('reduce_testcase crash signatures', () => {
  it('prefers assertion and fatal error text', () => {
    expect(deriveCrashSignature("clang: /src/X.cpp:10: void f(): Assertion `Idx < size()' failed.\nPLEASE submit a bug report")).toEqual({ signature: "Assertion `Idx < size()' failed.", specific: true });
    expect(deriveCrashSignature('LLVM ERROR: Cannot select: t1: i32 = foo')?.signature).toBe('LLVM ERROR: Cannot select: t1: i32 = foo');
    expect(deriveCrashSignature("a.c:3:1: internal compiler error: in expand_expr, at expr.cc:10")?.signature).toMatch(/^internal compiler error: in expand_expr/);
  });

  it('falls back to the innermost real stack frame, skipping signal handling frames', () => {
    const stderr = [
      'PLEASE submit a bug report to https://github.com/llvm/llvm-project/issues/',
      'Stack dump:',
      ' #0 0x00007f llvm::sys::PrintStackTrace(llvm::raw_ostream&, int) (/usr/lib/llvm-18/bin/clang+0x1)',
      ' #1 0x00007f SignalHandler(int) Signals.cpp:0:0',
      ' #2 0x00007f (anonymous namespace)::PragmaDebugHandler::HandlePragma(clang::Preprocessor&) Pragma.cpp:0:0',
      ' #3 0x00007f clang::Preprocessor::HandlePragmaDirective(clang::PragmaIntroducer)',
    ].join('\n');
    expect(deriveCrashSignature(stderr)).toEqual({ signature: 'PragmaDebugHandler::HandlePragma', specific: true });
  });

  it('admits when only a generic signature is available', () => {
    expect(deriveCrashSignature('PLEASE submit a bug report\n #0 0x1 (/usr/bin/clang+0x1)')).toEqual({ signature: 'PLEASE submit a bug report', specific: false });
    expect(deriveCrashSignature('a.c:1:1: error: expected expression')).toBeNull();
  });
});

describe('benchmark statistics', () => {
  it('computes median, spread and coefficient of variation', () => {
    const s = computeStats([10, 12, 11, 13, 14]);
    expect(s).toMatchObject({ runs: 5, median_ms: 12, min_ms: 10, max_ms: 14, mean_ms: 12, mad_ms: 1, iqr_ms: 2 });
    expect(s.stddev_ms).toBeCloseTo(1.581, 2);
    expect(s.cv_percent).toBeCloseTo(13.18, 1);
  });
});

describe('fuzz_compiler helpers', () => {
  it('finds csmith.h through CEA_CSMITH_INCLUDE', () => {
    const d = tmpDir();
    expect(findCsmithInclude(path.join(d, 'bin', 'csmith'), { CEA_CSMITH_INCLUDE: d })).toBeNull();
    fs.writeFileSync(path.join(d, 'csmith.h'), '');
    expect(findCsmithInclude(path.join(d, 'bin', 'csmith'), { CEA_CSMITH_INCLUDE: d })).toBe(d);
  });
});
