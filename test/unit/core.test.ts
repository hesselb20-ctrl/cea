import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFlags, languageOf, looksLikeCompilerCrash, optFlags, parseDiagnostics } from '../../src/core/build.js';
import { unifiedDiff } from '../../src/core/diff.js';
import { CeaError, toErrorObject } from '../../src/core/errors.js';
import { realExec } from '../../src/core/exec.js';
import { ddminLines, renderInterestingScript, renderShellWrapper } from '../../src/core/interesting.js';
import { Ledger } from '../../src/core/ledger.js';
import { PROVIDERS, Toolbox } from '../../src/core/toolbox.js';
import type { Evidence, ExecFn, ExecResult } from '../../src/core/types.js';
import { countLines, median, preview, quantile, sha256 } from '../../src/core/util.js';
import { tmpDir } from '../helpers.js';

const node = process.execPath;

describe('exec', () => {
  it('passes arguments verbatim, without a shell', async () => {
    const tricky = 'a b; echo pwned && $(whoami) "q" \'s\' %PATH% | x';
    const r = await realExec(node, ['-e', 'process.stdout.write(process.argv[1])', tricky]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(tricky);
  });

  it('captures stderr and the exit code', async () => {
    const r = await realExec(node, ['-e', 'console.error("bad"); process.exit(3)']);
    expect(r.exitCode).toBe(3);
    expect(r.stderr.trim()).toBe('bad');
  });

  it('kills a process that exceeds its timeout', async () => {
    const r = await realExec(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it('caps output and flags truncation', async () => {
    const r = await realExec(node, ['-e', 'process.stdout.write("x".repeat(200000))'], { maxOutputBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(1000);
  });

  it('feeds stdin', async () => {
    const r = await realExec(node, ['-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'hello' });
    expect(r.stdout).toBe('hello');
  });

  it('reports a missing binary as a spawn error instead of throwing', async () => {
    const r = await realExec(path.join(tmpDir(), 'does-not-exist'), []);
    expect(r.spawnError).toBeTruthy();
    expect(r.exitCode).toBeNull();
  });
});

describe('ledger', () => {
  const record = (ledger: Ledger, op: string): Evidence => ({
    schema: 'cea.evidence/1', evidence_id: ledger.newEvidenceId(op), session_id: ledger.sessionId, created_at: new Date().toISOString(), duration_ms: 1,
    operation: op, status: 'ok', summary: 's', inputs: {}, input_files: [], tools: [], commands: [], target_triple: null, result: {},
    observed: [], inferred: [], unknowns: [], limitations: [], coverage: {}, views: [], derived_from: [],
  });

  it('appends, lists and finds evidence across instances', () => {
    const home = tmpDir();
    const a = new Ledger(home, 's1');
    const e = record(a, 'compile');
    a.append(e);
    a.append(record(a, 'check_ub'));
    const b = new Ledger(home, 's1');
    expect(b.list()).toHaveLength(2);
    expect(b.get(e.evidence_id)?.operation).toBe('compile');
    expect(e.evidence_id).toMatch(/^ev_compile_[0-9a-f]{8}$/);
    expect(new Ledger(home, 's2').list()).toHaveLength(0);
    expect(() => b.require('ev_nope_00000000')).toThrow(CeaError);
  });

  it('stores views with size, line count and hash', () => {
    const ledger = new Ledger(tmpDir(), 's');
    const v = ledger.writeView('ev_x_1', 'out.ll', 'a\nb\nc\n', 'ir');
    expect(v).toMatchObject({ name: 'out.ll', lines: 3, bytes: 6, sha256: sha256('a\nb\nc\n') });
    expect(ledger.readView('ev_x_1', 'out.ll')).toBe('a\nb\nc\n');
    expect(() => ledger.readView('ev_x_1', 'missing')).toThrow(/no view/);
    expect(() => ledger.viewPath('../..', 'x')).toThrow(CeaError);
  });

  it('rejects session names that could escape the home directory', () => {
    expect(() => new Ledger(tmpDir(), '../evil')).toThrow(CeaError);
  });

  it('skips a torn final line', () => {
    const ledger = new Ledger(tmpDir(), 's');
    ledger.append(record(ledger, 'compile'));
    fs.appendFileSync(path.join(ledger.dir, 'evidence.jsonl'), '{"schema":"cea.evid', 'utf8');
    expect(ledger.list()).toHaveLength(1);
  });

  it('keeps the latest revision of an unknown', () => {
    const ledger = new Ledger(tmpDir(), 's');
    const u = { unknown_id: ledger.newUnknownId(), session_id: 's', created_at: 't', updated_at: 't', question: 'q?', why_it_matters: '', status: 'open' as const, supporting_evidence: [], contradicting_evidence: [], notes: [], resolution: null };
    ledger.putUnknown(u);
    ledger.putUnknown({ ...u, status: 'resolved', resolution: 'done' });
    expect(ledger.listUnknowns()).toHaveLength(1);
    expect(ledger.getUnknown(u.unknown_id)?.status).toBe('resolved');
  });
});

describe('toolbox', () => {
  const reply = (stdout: string, exitCode = 0): ExecResult => ({ argv: [], cwd: '', exitCode, signal: null, stdout, stderr: '', timedOut: false, truncated: false, durationMs: 1 });
  const box = (files: Record<string, string>, env: NodeJS.ProcessEnv = {}) => {
    const exec: ExecFn = async (cmd, args) => (args[0] === '-dumpmachine' ? reply('x86_64-pc-linux-gnu') : reply(files[cmd] ?? '', cmd in files ? 0 : 1));
    return new Toolbox({
      exec, platform: 'linux', env: { PATH: [path.normalize('/a'), path.normalize('/b')].join(path.delimiter), ...env },
      exists: (p) => p in files,
      listDir: (d) => Object.keys(files).filter((f) => path.dirname(f) === d).map((f) => path.basename(f)),
    });
  };
  const p = (dir: string, name: string) => path.join(dir, name);

  it('reports a missing provider with a reason and a remediation', async () => {
    const s = await box({}).status('alive-tv');
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/no alive-tv found/);
    expect(s.remediation).toMatch(/CEA_TOOL_ALIVE_TV/);
    await expect(box({}).require('alive-tv')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('rejects a gcc that is really clang and finds the real one later on PATH', async () => {
    const tb = box({ [p('/a', 'gcc')]: 'clang version 18.1.3', [p('/b', 'gcc')]: 'gcc (GCC) 13.2.0\nFree Software Foundation' });
    const s = await tb.status('gcc');
    expect(s.available).toBe(true);
    expect(s.path).toBe(p('/b', 'gcc'));
  });

  it('marks gcc unavailable when the only gcc is clang', async () => {
    const s = await box({ [p('/a', 'gcc')]: 'Apple clang version 15.0.0' }).status('gcc');
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/not a real gcc/);
  });

  it('finds versioned LLVM tools and prefers the one matching clang', async () => {
    const tb = box({ [p('/a', 'clang-18')]: 'clang version 18.1.3', [p('/a', 'opt-18')]: 'LLVM version 18.1.3', [p('/b', 'opt-17')]: 'LLVM version 17.0.6' });
    expect((await tb.status('clang')).path).toBe(p('/a', 'clang-18'));
    expect((await tb.status('opt')).path).toBe(p('/a', 'opt-18'));
  });

  it('honours CEA_TOOL_<NAME> and CEA_TOOLCHAIN_DIRS', async () => {
    const files = { [p('/x', 'my-alive')]: 'alive-tv version 1', [p('/tc', 'clang')]: 'clang version 19.0.0', [p('/a', 'clang')]: 'clang version 18.0.0' };
    const tb = box(files, { CEA_TOOL_ALIVE_TV: p('/x', 'my-alive'), CEA_TOOLCHAIN_DIRS: path.normalize('/tc') });
    expect((await tb.status('alive-tv')).path).toBe(p('/x', 'my-alive'));
    expect((await tb.status('clang')).version).toMatch(/19/);
    const bad = await box({}, { CEA_TOOL_ALIVE_TV: '/nope/alive-tv' }).status('alive-tv');
    expect(bad.reason).toMatch(/does not exist/);
  });

  it('classifies compilers and reads their target', async () => {
    const tb = box({ [p('/a', 'clang')]: 'clang version 18.1.3', [p('/a', 'gcc')]: 'gcc (GCC) 13.2.0 Free Software Foundation' });
    expect(await tb.compiler('clang')).toMatchObject({ family: 'clang', target: 'x86_64-pc-linux-gnu' });
    expect((await tb.compiler('gcc')).family).toBe('gcc');
    await expect(tb.compiler('icc')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('declares every provider the spec asks for', () => {
    const ids = PROVIDERS.map((x) => x.id);
    for (const id of ['clang', 'opt', 'llc', 'llvm-reduce', 'llvm-mca', 'llvm-mc', 'llvm-objdump', 'FileCheck', 'gcc', 'rustc', 'cargo', 'miri', 'alive-tv', 'cvise', 'creduce', 'csmith', 'yarpgen', 'perf', 'git']) {
      expect(ids).toContain(id);
    }
  });
});

describe('flags and diagnostics', () => {
  it('rejects flags that load code into the compiler', () => {
    for (const f of ['-fplugin=x.so', '-fpass-plugin=x.so', '-load', '-wrapper', '-B/tmp/evil', '-specs=evil', '@response.txt', '--load-pass-plugin=x']) {
      expect(() => checkFlags([f], false), f).toThrow(/UNSAFE_FLAG|rejected/);
    }
    expect(() => checkFlags(['-fplugin=x.so'], true)).not.toThrow();
  });

  it('rejects -o but allows ordinary flags', () => {
    expect(() => checkFlags(['-o', 'x'], false)).toThrow(/output paths/);
    expect(() => checkFlags(['-ofoo'], false)).toThrow();
    expect(() => checkFlags(['-O2', '-g', '-std=c11', '-DX=1', '-mllvm', '-opt-bisect-limit=3', '-march=native', '-fno-strict-aliasing'], false)).not.toThrow();
  });

  it('parses GCC/Clang diagnostics including Windows paths', () => {
    const d = parseDiagnostics('C:\\x\\a.c:3:5: warning: unused variable \'x\' [-Wunused-variable]\n/tmp/a.c:9: error: boom\nnoise\na.c:1:1: note: here');
    expect(d).toEqual([
      { file: 'C:\\x\\a.c', line: 3, column: 5, severity: 'warning', message: 'unused variable \'x\' [-Wunused-variable]' },
      { file: '/tmp/a.c', line: 9, column: null, severity: 'error', message: 'boom' },
      { file: 'a.c', line: 1, column: 1, severity: 'note', message: 'here' },
    ]);
  });

  it('tells a compiler crash from a rejected input', () => {
    const r = (stderr: string, signal: string | null = null): ExecResult => ({ argv: [], cwd: '', exitCode: 1, signal, stdout: '', stderr, timedOut: false, truncated: false, durationMs: 1 });
    expect(looksLikeCompilerCrash(r('a.c:1:1: error: expected ;'))).toBe(false);
    expect(looksLikeCompilerCrash(r('PLEASE submit a bug report to https://...\nStack dump:'))).toBe(true);
    expect(looksLikeCompilerCrash(r('a.c:1: internal compiler error: in foo'))).toBe(true);
    expect(looksLikeCompilerCrash(r('', 'SIGSEGV'))).toBe(true);
  });

  it('maps optimisation levels per compiler family', () => {
    expect(optFlags('clang', 'O2')).toEqual(['-O2']);
    expect(optFlags('gcc', 'Oz')).toEqual(['-Os']);
    expect(optFlags('rustc', 'O3')).toEqual(['-C', 'opt-level=3']);
    expect(languageOf('a.cpp')).toBe('c++');
    expect(languageOf('a.ll')).toBe('llvm-ir');
    expect(languageOf('a.txt')).toBeNull();
  });
});

describe('diff and util', () => {
  it('produces a unified diff with counts', () => {
    const d = unifiedDiff('a\nb\nc\nd\ne\nf\ng', 'a\nb\nX\nd\ne\nf\ng', 1);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.text).toBe('@@ -2 +2 @@\n b\n-c\n+X\n d');
    expect(unifiedDiff('same', 'same')).toEqual({ text: '', added: 0, removed: 0 });
  });

  it('computes medians, quantiles, previews and line counts', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('')).toBe(0);
    const pv = preview(Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'), 5);
    expect(pv.split('\n')).toHaveLength(6);
    expect(pv).toMatch(/truncated; 100 lines/);
  });

  it('turns errors into objects with remediation', () => {
    expect(toErrorObject(new CeaError('TIMEOUT', 'm', 'r'))).toEqual({ code: 'TIMEOUT', message: 'm', remediation: 'r' });
    expect(toErrorObject(new Error('x')).code).toBe('INTERNAL');
  });
});

describe('interestingness', () => {
  it('ddmin removes every line that is not needed', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    lines[7] = 'KEEP A';
    lines[29] = 'KEEP B';
    const r = await ddminLines(lines.join('\n'), async (c) => c.includes('KEEP A') && c.includes('KEEP B'), { deadline: Date.now() + 10_000, maxTests: 1000 });
    expect(r.text).toBe('KEEP A\nKEEP B');
    expect(r.exhausted).toBe(false);
    expect(r.tests).toBeLessThan(200);
  });

  it('ddmin stops at its test budget and says so', async () => {
    const text = Array.from({ length: 64 }, (_, i) => `l${i}`).join('\n');
    const r = await ddminLines(text, async (c) => c.includes('l63'), { deadline: Date.now() + 10_000, maxTests: 3 });
    expect(r.exhausted).toBe(true);
    expect(r.tests).toBe(3);
    expect(r.text).toContain('l63');
  });

  it('renders a script that node can run, with the config embedded as data', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'input.c');
    fs.writeFileSync(file, 'int x;');
    const tricky = 'weird $(name) `tick` "quote" \\ back';
    const script = renderInterestingScript({ description: tricky, file_name: 'input.c', path_dirs: [], steps: [{ type: 'differ', a: 'x', b: 'y' }] });
    const sp = path.join(dir, 'interesting.mjs');
    fs.writeFileSync(sp, script);
    // "x" and "y" were never run, so both are undefined and equal: not interesting.
    const r = await realExec(node, [sp, file], { cwd: dir, env: { ...process.env, CEA_INTERESTING_VERBOSE: '1' } });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/behave the same/);
    const ok = renderInterestingScript({ description: 'd', file_name: 'input.c', path_dirs: [], steps: [] });
    fs.writeFileSync(sp, ok);
    expect((await realExec(node, [sp], { cwd: dir })).exitCode).toBe(0);
    expect((await realExec(node, [sp, path.join(dir, 'missing.c')], { cwd: dir })).exitCode).toBe(1);
  });

  it('quotes paths in the shell wrapper', () => {
    expect(renderShellWrapper('/usr/bin/node', "/tmp/it's/interesting.mjs")).toContain(`exec '/usr/bin/node' '/tmp/it'\\''s/interesting.mjs'`);
  });
});
