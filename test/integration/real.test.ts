/**
 * Integration tests against the real compilers on this machine. A test whose provider is
 * missing is skipped, never failed; the last test prints which providers were absent so a
 * green run cannot be mistaken for full coverage.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callTool, createContext, invokeTool } from '../../src/core/context.js';
import { realExec } from '../../src/core/exec.js';
import { PROVIDERS } from '../../src/core/toolbox.js';
import { TOOLS } from '../../src/registry.js';
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
import { exportEvidenceBundle } from '../../src/tools/ledger_tools.js';
import { optRemarks } from '../../src/tools/opt_remarks.js';
import { passTimeline } from '../../src/tools/pass_timeline.js';
import { reduceTestcase } from '../../src/tools/reduce_testcase.js';
import { triageMiscompile } from '../../src/tools/triage_miscompile.js';
import { validateTransform } from '../../src/tools/validate_transform.js';
import { res, tmpDir } from '../helpers.js';

const home = tmpDir('cea-int-');
const ctx = createContext({ home, session: 'integration' });
const have: Record<string, boolean> = Object.fromEntries(await Promise.all(PROVIDERS.map(async (p) => [p.id, await ctx.toolbox.has(p.id)] as const)));
const remote = ctx.config.remoteProviders.has('compiler-explorer');
const clangTarget = have['clang'] ? (await ctx.toolbox.compiler('clang')).target ?? '' : '';
const x86 = /^(x86_64|amd64)/.test(clangTarget);
const ex = (p: string) => path.resolve('examples', p);
const cli = path.resolve('dist', 'cli.js');
const built = fs.existsSync(cli);
const skipped = new Set<string>();
const need = (...ids: string[]) => {
  const missing = ids.filter((i) => !have[i]);
  for (const m of missing) skipped.add(m);
  return missing.length > 0;
};
const T = 300_000;

describe('environment', () => {
  it('reports real providers and their versions', async () => {
    const e = await invokeTool(ctx, environmentReport, {});
    expect(e.status).toBe('ok');
    const r = res(e);
    expect(r.providers).toHaveLength(PROVIDERS.length);
    for (const p of r.providers) {
      if (p.available) expect(p.version, p.id).toBeTruthy();
      else expect(p.remediation, p.id).toBeTruthy();
    }
    expect(r.providers.find((p: { id: string }) => p.id === 'git').available).toBe(true);
  }, T);
});

describe('compile and inspect', () => {
  it.skipIf(need('clang'))('compile: clang emits assembly for one function', async () => {
    const e = await invokeTool(ctx, compile, { source: { path: ex('02-missed-vectorization-aliasing/scale.c') }, flags: ['-O2'], function: 'scale' });
    const r = res(e);
    expect(r.success).toBe(true);
    expect(r.function_asm.length).toBeGreaterThan(20);
    expect(e.target_triple).toBeTruthy();
    expect(e.input_files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, T);

  it.skipIf(need('clang'))('compile: a syntax error becomes diagnostics, not a failure of the tool', async () => {
    const e = await invokeTool(ctx, compile, { source: { code: 'int main(void) { return x; }', language: 'c' } });
    expect(e.status).toBe('ok');
    expect(res(e).success).toBe(false);
    expect(res(e).diagnostics[0]).toMatchObject({ severity: 'error', line: 1 });
  }, T);

  it.skipIf(need('gcc'))('compile: gcc emits assembly', async () => {
    const e = await invokeTool(ctx, compile, { source: { path: ex('02-missed-vectorization-aliasing/scale.c') }, compiler: 'gcc', flags: ['-O2'] });
    expect(res(e).success).toBe(true);
    expect(e.tools[0]!.version).not.toMatch(/clang/i);
  }, T);

  it.skipIf(need('clang'))('emit_ir: clang frontend IR lists the functions', async () => {
    const e = await invokeTool(ctx, emitIr, { source: { path: ex('02-missed-vectorization-aliasing/scale.c') } });
    expect(res(e).functions).toEqual(expect.arrayContaining(['scale', 'main']));
  }, T);

  it.skipIf(need('gcc'))('emit_ir: gcc produces a GIMPLE dump', async () => {
    const e = await invokeTool(ctx, emitIr, { source: { path: ex('02-missed-vectorization-aliasing/scale.c') }, compiler: 'gcc' });
    expect(res(e)).toMatchObject({ success: true, ir_kind: 'gimple' });
  }, T);

  it.skipIf(need('clang'))('pass_timeline: follows a function through the -O2 pipeline', async () => {
    const e = await invokeTool(ctx, passTimeline, { source: { path: ex('02-missed-vectorization-aliasing/scale_restrict.c') }, function: 'scale', flags: ['-O2'], limit: 2 });
    const r = res(e);
    expect(r.steps_total).toBeGreaterThan(3);
    expect(r.noop_passes_skipped).toBeGreaterThan(0);
    expect(r.page.steps).toHaveLength(2);
    expect(r.index.map((s: { pass: string }) => s.pass).join(' ')).toMatch(/SROA|InstCombine/);
  }, T);

  it.skipIf(need('clang', 'opt'))('pass_timeline: an explicit opt pipeline shows the fold that nsw allows', async () => {
    const e = await invokeTool(ctx, passTimeline, { source: { path: ex('03-alive2-counterexample/correct-with-nsw.ll') }, function: 'src', passes: 'instcombine' });
    const r = res(e);
    expect(r.steps_total).toBe(1);
    expect(r.page.steps[0].diff).toContain('+  ret i1 true');
  }, T);

  it.skipIf(need('gcc'))('pass_timeline: gcc tree dumps', async () => {
    const e = await invokeTool(ctx, passTimeline, { source: { path: ex('02-missed-vectorization-aliasing/scale.c') }, compiler: 'gcc', function: 'scale', flags: ['-O2'], limit: 1 });
    expect(res(e).steps_total).toBeGreaterThan(3);
  }, T);

  it.skipIf(need('clang'))('opt_remarks: example 2 is a missed vectorisation, fixed by restrict', async () => {
    const base = await invokeTool(ctx, optRemarks, { source: { path: ex('02-missed-vectorization-aliasing/scale.c') }, flags: ['-O2'], function: 'scale', passes: ['loop-vectorize'] });
    const missed = Object.values(res(base).by_function.scale.loops).flat() as { kind: string; message: string }[];
    expect(missed.some((m) => m.kind === 'missed' && /not vectorized/.test(m.message))).toBe(true);
    const fixed = await invokeTool(ctx, optRemarks, { source: { path: ex('02-missed-vectorization-aliasing/scale_restrict.c') }, flags: ['-O2'], function: 'scale', passes: ['loop-vectorize'], kinds: ['passed'] });
    expect(res(fixed).counts.passed).toBeGreaterThan(0);
  }, T);
});

describe('correctness', () => {
  it.skipIf(need('clang'))('check_ub: example 1 has signed overflow at line 3', async () => {
    const e = await invokeTool(ctx, checkUb, { source: { path: ex('01-ub-not-a-compiler-bug/overflow.c') } });
    const r = res(e);
    expect(r.clean).toBe(false);
    expect(r.findings[0]).toMatchObject({ sanitizer: 'ubsan', line: 3 });
    expect(r.findings[0].message).toMatch(/signed integer overflow/);
  }, T);

  it.skipIf(need('clang'))('check_ub: example 5 is clean under sanitizers (and says that proves nothing)', async () => {
    const e = await invokeTool(ctx, checkUb, { source: { path: ex('05-ub-sanitizers-cannot-see/alias.c') } });
    expect(res(e).clean).toBe(true);
    expect(e.summary).toMatch(/not proof/);
  }, T);

  it.skipIf(need('clang'))('differential_run: example 1 diverges between -O0 and -O2', async () => {
    const e = await invokeTool(ctx, differentialRun, { source: { path: ex('01-ub-not-a-compiler-bug/overflow.c') }, compilers: ['clang'], opt_levels: ['O0', 'O2'] });
    expect(res(e).divergent).toBe(true);
    expect(res(e).nondeterministic).toEqual([]);
  }, T);

  it.skipIf(need('clang'))('bisect_passes: names the pass that flips example 5', async () => {
    const e = await invokeTool(ctx, bisectPasses, { source: { path: ex('05-ub-sanitizers-cannot-see/alias.c') } });
    const r = res(e);
    expect(e.status).toBe('ok');
    expect(r.culprit.unit).toBe('store_both');
    expect(r.first_bad_limit - r.last_good_limit).toBe(1);
  }, T);

  it.skipIf(need('clang'))('reduce_testcase: example 4, a clang crash, shrinks to a few lines', async () => {
    const e = await invokeTool(ctx, reduceTestcase, { source: { path: ex('04-crash-reduction/crash.c') }, kind: 'crash', flags: ['-O2'], timeout_s: 240 });
    const r = res(e);
    expect(e.status, JSON.stringify(e.error)).toBe('ok');
    expect(r.verified).toBe(true);
    expect(r.before.lines).toBeGreaterThan(80);
    expect(r.after.lines).toBeLessThanOrEqual(5);
    expect(r.reduced_source).toContain('__debug crash');
    console.log(`[reduce] ${r.before.lines} -> ${r.after.lines} lines with ${r.reducer}`);
  }, T);

  it.skipIf(need('clang'))('reduce_testcase: a miscompile-shaped case keeps both outputs and stays sanitizer-clean', async () => {
    const e = await invokeTool(ctx, reduceTestcase, { source: { path: ex('05-ub-sanitizers-cannot-see/alias.c') }, kind: 'miscompile', reducer: 'builtin', timeout_s: 200 });
    const r = res(e);
    expect(r.verified).toBe(true);
    expect(r.ub_guard).toBe('sanitizers');
    expect(r.after.lines).toBeLessThan(r.before.lines);
    // The generated test is a real, runnable script.
    const again = await realExec(process.execPath, [r.script_path, r.reduced_path]);
    expect(again.exitCode).toBe(0);
  }, T);

  it.skipIf(need('clang'))('reduce_testcase: refuses a program with sanitizer-visible UB', async () => {
    const e = await invokeTool(ctx, reduceTestcase, { source: { path: ex('01-ub-not-a-compiler-bug/overflow.c') }, kind: 'miscompile' });
    expect(e.error?.message).toMatch(/undefined behaviour/);
  }, T);

  it.skipIf(!remote && need('alive-tv'))('validate_transform: example 3, Alive2 refutes the rewrite without nsw and accepts it with nsw', async () => {
    const bad = await invokeTool(ctx, validateTransform, { pair: { path: ex('03-alive2-counterexample/wrong.ll') } });
    expect(res(bad).verdict).toBe('incorrect');
    expect(res(bad).pairs[0].counterexample).toContain('2147483647');
    const good = await invokeTool(ctx, validateTransform, { pair: { path: ex('03-alive2-counterexample/correct-with-nsw.ll') } });
    expect(res(good).verdict).toBe('correct');
  }, T);

  it.skipIf(need('clang', 'csmith'))('fuzz_compiler: a short Csmith campaign runs and reports its seeds', async () => {
    const e = await invokeTool(ctx, fuzzCompiler, { compilers: ['clang'], duration_s: 60, max_programs: 3, seed_start: 1000, program_timeout_s: 5 });
    expect(e.status, JSON.stringify(e.error)).toBe('ok');
    const r = res(e);
    expect(r.seed_start).toBe(1000);
    expect(r.programs_generated).toBeGreaterThan(0);
    console.log(`[fuzz] generated ${r.programs_generated}, compared ${r.programs_compared}, candidates ${r.candidates.length}, timeouts ${r.skipped_timeout}`);
  }, T);

  it.skipIf(need('git'))('bisect_compiler_history: finds the commit that introduced a failure in a real repository', async () => {
    const repo = tmpDir('cea-bisect-');
    const git = (await ctx.toolbox.require('git')).path;
    const g = async (...args: string[]) => {
      const r = await realExec(git, ['-C', repo, '-c', 'user.name=cea', '-c', 'user.email=cea@example.invalid', '-c', 'commit.gpgsign=false', ...args]);
      expect(r.exitCode, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
      return r.stdout.trim();
    };
    await g('init', '-q');
    const shas: string[] = [];
    for (let v = 1; v <= 8; v++) {
      fs.writeFileSync(path.join(repo, 'value.txt'), String(v));
      await g('add', 'value.txt');
      await g('commit', '-q', '-m', `value ${v}`);
      shas.push(await g('rev-parse', 'HEAD'));
    }
    // The "compiler" is broken from value 6 on. Exit 0 means the failure is present.
    const test = path.join(tmpDir(), 'is-bad.mjs');
    fs.writeFileSync(test, `import fs from 'node:fs';\nprocess.exit(Number(fs.readFileSync(${JSON.stringify(path.join(repo, 'value.txt'))}, 'utf8')) >= 6 ? 0 : 1);\n`);
    const e = await invokeTool(ctx, bisectCompilerHistory, { repo, good: shas[0]!, bad: shas[7]!, test: [process.execPath, test] });
    expect(e.status, JSON.stringify(e.error ?? e.result)).toBe('ok');
    expect(res(e).first_bad_commit).toBe(shas[5]);
    expect(await g('rev-parse', 'HEAD')).toBe(shas[7]);
    expect(fs.existsSync(path.join(repo, '.git', 'BISECT_LOG'))).toBe(false);
  }, T);
});

describe('performance', () => {
  it.skipIf(need('clang', 'llvm-mca') || !x86)('analyze_throughput: llvm-mca on the vectorised loop', async () => {
    const e = await invokeTool(ctx, analyzeThroughput, { source: { path: ex('02-missed-vectorization-aliasing/scale_restrict.c') }, function: 'scale', cpu: 'skylake', flags: ['-O2', '-march=skylake'] });
    expect(e.status, JSON.stringify(e.error)).toBe('ok');
    expect(res(e).summary.ipc).toBeGreaterThan(0);
    expect(e.limitations.join(' ')).toMatch(/ignores caches/);
  }, T);

  it.skipIf(need('clang'))('benchmark: example 2, both variants print the same answer and get a median and a spread', async () => {
    const e = await invokeTool(ctx, benchmark, {
      source: { path: ex('02-missed-vectorization-aliasing/scale.c') },
      variants: [{ name: 'baseline', flags: ['-O2'] }, { name: 'restrict', flags: ['-O2'], source: { path: ex('02-missed-vectorization-aliasing/scale_restrict.c') } }],
      runs: 5, warmup: 1,
    });
    const r = res(e);
    expect(r.disqualified).toEqual([]);
    expect(r.variants.baseline.output_correct).toBe(true);
    expect(r.variants.restrict.stats.median_ms).toBeGreaterThan(0);
    console.log(`[benchmark] ${e.summary}`);
  }, T);
});

describe('triage_miscompile', () => {
  it.skipIf(need('clang'))('example 1: says "UB found, not a compiler bug" and stops', async () => {
    const e = await invokeTool(ctx, triageMiscompile, { source: { path: ex('01-ub-not-a-compiler-bug/overflow.c') } });
    const r = res(e);
    expect(r.verdict).toBe('undefined_behavior');
    expect(e.summary).toMatch(/^UB found at overflow\.c:3:\d+ \(signed integer overflow.*\), not a compiler bug$/);
    expect(r.steps.map((s: { step: string }) => s.step)).toEqual(['environment', 'check_ub']);
  }, T);

  it.skipIf(need('clang'))('example 5: goes the whole way and still does not blame the compiler', async () => {
    const e = await invokeTool(ctx, triageMiscompile, { source: { path: ex('05-ub-sanitizers-cannot-see/alias.c') }, reduce: false, validate: false });
    const r = res(e);
    expect(r.verdict).toBe('suspected_undetected_ub');
    expect(r.is_compiler_bug).toBe('unlikely');
    expect(r.culprit.unit).toBe('store_both');
    expect(r.report_markdown).toContain('!tbaa');
  }, T);
});

describe('command line and MCP over stdio', () => {
  const run = (args: string[]) => realExec(process.execPath, [cli, ...args, '--home', home, '--session', 'cli'], { timeoutMs: T });

  it.skipIf(!built)('cea tools / schema / unknown command', async () => {
    const tools = await run(['tools']);
    expect(tools.exitCode).toBe(0);
    for (const t of TOOLS) expect(tools.stdout).toContain(t.name);
    const schema = await run(['schema', 'check-ub']);
    expect(JSON.parse(schema.stdout).properties.source).toBeDefined();
    expect((await run(['frobnicate'])).exitCode).toBe(2);
  }, T);

  it.skipIf(!built || need('clang'))('cea <tool> --json and --input give the same kind of record, with exit codes', async () => {
    const a = await run(['compile', '--json', JSON.stringify({ source: { code: 'int f(void){return 1;}', language: 'c' } })]);
    expect(a.exitCode).toBe(0);
    expect(JSON.parse(a.stdout).result.success).toBe(true);
    const b = await run(['check_ub', '--input', ex('01-ub-not-a-compiler-bug/check_ub.json')]);
    expect(JSON.parse(b.stdout).result.clean).toBe(false);
    const bad = await run(['compile', '--json', '{"bogus":1}']);
    expect(bad.exitCode).toBe(2);
    expect(JSON.parse(bad.stdout).error.code).toBe('INVALID_INPUT');
  }, T);

  it.skipIf(!built || need('clang'))('cea triage prints the verdict for example 1', async () => {
    const r = await run(['triage', ex('01-ub-not-a-compiler-bug/overflow.c')]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/verdict: undefined_behavior/);
    expect(r.stdout).toMatch(/not a compiler bug/);
    expect(r.stdout).toMatch(/evidence ev_check_ub_[0-9a-f]{8}/);
  }, T);

  it.skipIf(!built)('cea mcp speaks MCP over stdio', async () => {
    const env = { ...process.env, CEA_HOME: home, CEA_SESSION: 'mcp' } as Record<string, string>;
    const client = new Client({ name: 'integration', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env }));
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(TOOLS.length);
      const r = await client.callTool({ name: 'environment_report', arguments: { probe_sanitizers: false } });
      const e = JSON.parse((r.content as { text: string }[])[0]!.text);
      expect(e.operation).toBe('environment_report');
      expect(e.result.providers.length).toBe(PROVIDERS.length);
    } finally {
      await client.close();
    }
  }, T);
});

describe('session', () => {
  it('exports everything the run produced as one bundle', async () => {
    const r = res(await callTool(ctx, exportEvidenceBundle, {}));
    expect(r.evidence_count).toBe(ctx.ledger.list().length);
    expect(fs.existsSync(r.bundle_path)).toBe(true);
  });

  it('reports which providers were missing', () => {
    const missing = PROVIDERS.filter((p) => !have[p.id]).map((p) => p.id);
    console.log(`[providers] available: ${PROVIDERS.filter((p) => have[p.id]).map((p) => p.id).join(', ') || 'none'}`);
    console.log(`[providers] missing: ${missing.join(', ') || 'none'}`);
    console.log(`[providers] tests skipped for lack of: ${[...skipped].join(', ') || 'nothing'}${built ? '' : '; CLI tests skipped: run `npm run build` first'}`);
    console.log(`[providers] remote Alive2: ${remote ? 'enabled' : 'disabled'}`);
    expect(Array.isArray(missing)).toBe(true);
  });
});
