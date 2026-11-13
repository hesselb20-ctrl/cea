import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { compileTo, FlagsSchema, materialize, OptLevelSchema, optFlags, RunSpecSchema, runProgram, SANITIZER_BLIND_SPOTS, SourceSchema, DEFAULT_RUN } from '../core/build.js';
import { defineTool } from '../core/context.js';
import { CeaError } from '../core/errors.js';
import { normalizeNewlines, preview } from '../core/util.js';

export interface UbFinding {
  sanitizer: 'ubsan' | 'asan' | 'msan' | 'miri' | 'trap';
  kind: string;
  message: string;
  file: string | null;
  line: number | null;
  column: number | null;
  opt_level: string;
}

/** Parse UBSan / ASan / MSan reports out of a program's stderr. */
export function parseSanitizerOutput(stderr: string, optLevel: string): UbFinding[] {
  const out: UbFinding[] = [];
  const lines = normalizeNewlines(stderr).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const ub = /^(.+?):(\d+):(\d+): runtime error: (.*)$/.exec(line);
    if (ub) {
      const msg = ub[4]!;
      out.push({ sanitizer: 'ubsan', kind: msg.split(/[:(]| of | by | in /)[0]!.trim().split(' ').slice(0, 4).join(' '), message: msg, file: ub[1]!, line: Number(ub[2]), column: Number(ub[3]), opt_level: optLevel });
      continue;
    }
    const san = /ERROR: (AddressSanitizer|MemorySanitizer|LeakSanitizer): ([^\s]+)(.*)$/.exec(line) ?? /WARNING: (MemorySanitizer): ([^\s]+)(.*)$/.exec(line);
    if (san) {
      let file: string | null = null;
      let ln: number | null = null;
      let col: number | null = null;
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const fr = /^\s*#\d+ 0x[0-9a-f]+ (?:in \S+ )?(.+?):(\d+)(?::(\d+))?\s*$/.exec(lines[j]!);
        if (fr && !/sanitizer|compiler-rt|libsanitizer/.test(fr[1]!)) {
          file = fr[1]!;
          ln = Number(fr[2]);
          col = fr[3] ? Number(fr[3]) : null;
          break;
        }
      }
      out.push({ sanitizer: san[1] === 'MemorySanitizer' ? 'msan' : 'asan', kind: san[2]!, message: `${san[1]}: ${san[2]}${san[3] ?? ''}`.trim(), file, line: ln, column: col, opt_level: optLevel });
    }
  }
  return out;
}

export const checkUb = defineTool({
  name: 'check_ub',
  family: 'correctness',
  title: 'Check for undefined behaviour',
  description:
    'Build the program with UBSan and ASan (MSan where it links; Miri for a Rust crate) at -O0 and -O1, run it, and return every finding with its source location. ' +
    'Run this before blaming a compiler: a program with undefined behaviour has no "correct" output for the optimiser to preserve.',
  input: z.strictObject({
    source: SourceSchema,
    compiler: z.string().min(1).default('clang'),
    flags: FlagsSchema.default([]).describe('Extra flags (defines, -std=...). Do not pass an -O level; see opt_levels.'),
    opt_levels: z.array(OptLevelSchema).min(1).max(4).default(['O0', 'O1']),
    sanitizers: z.array(z.enum(['undefined', 'address', 'memory'])).min(1).max(3).default(['undefined', 'address']).describe('memory (MSan) cannot be combined with address and is tried as a separate build.'),
    run: RunSpecSchema.default(DEFAULT_RUN),
    cargo_project: z.string().optional().describe('Rust only: path to a cargo project to run under Miri instead of `source`.'),
  }),
  async run(input, ev, ctx) {
    for (const l of SANITIZER_BLIND_SPOTS) ev.limit(l);

    if (input.cargo_project) {
      const miri = await ev.tool('miri');
      const dir = path.resolve(input.cargo_project);
      if (!fs.existsSync(path.join(dir, 'Cargo.toml'))) throw new CeaError('NOT_FOUND', `no Cargo.toml in ${dir}`, 'Pass the directory of a cargo project.');
      const r = await ev.run('cargo miri run', miri.path, ['miri', 'run'], { cwd: dir, timeoutMs: Math.max(input.run.timeout_s, 120) * 1000 });
      const findings: UbFinding[] = [];
      const m = /error: Undefined Behavior: (.*)/.exec(r.stderr);
      if (m) {
        const loc = /--> (.+?):(\d+):(\d+)/.exec(r.stderr);
        findings.push({ sanitizer: 'miri', kind: 'undefined behavior', message: m[1]!, file: loc?.[1] ?? null, line: loc ? Number(loc[2]) : null, column: loc ? Number(loc[3]) : null, opt_level: 'miri' });
      }
      ev.observe(findings.length ? `Miri reported: ${findings[0]!.message}` : `Miri run exited with ${r.exitCode} and reported no undefined behaviour`);
      return { status: 'ok', summary: findings.length ? `UB found by Miri: ${findings[0]!.message}` : 'Miri reported no UB on this run', result: { clean: findings.length === 0, findings, exit_code: r.exitCode, stderr_preview: preview(r.stderr, 30) } };
    }

    const compiler = await ev.compiler(input.compiler);
    if (compiler.family !== 'clang' && compiler.family !== 'gcc') {
      throw new CeaError('UNSUPPORTED', 'check_ub builds with sanitizers and needs clang or gcc', 'For Rust pass cargo_project to use Miri.');
    }
    const source = materialize(ev, input.source);
    const groups: string[][] = [];
    const main = input.sanitizers.filter((s) => s !== 'memory');
    if (main.length) groups.push(main);
    if (input.sanitizers.includes('memory')) groups.push(['memory']);

    const findings: UbFinding[] = [];
    const builds: Record<string, unknown>[] = [];
    const warnings = new Map<string, unknown>();
    let ranAny = false;

    for (const level of input.opt_levels) {
      for (const group of groups) {
        let active = [...group];
        let built = null;
        // If a combination does not link here (ASan missing on a platform), retry with fewer.
        while (active.length > 0) {
          const id = `${level}-${active.join('+')}`;
          const flags = [...optFlags(compiler.family, level), '-g', `-fsanitize=${active.join(',')}`, '-fno-sanitize-recover=all', '-fno-omit-frame-pointer', '-Wall', '-Wextra', ...input.flags];
          const r = await compileTo(ev, { compiler, source, flags, kind: 'exe', outBase: `san-${id}`, purpose: `build ${id}` });
          for (const d of r.diagnostics.filter((x) => x.severity === 'warning')) warnings.set(`${d.line}:${d.column}:${d.message}`, { line: d.line, column: d.column, message: d.message });
          if (r.ok) {
            built = { r, id, active: [...active] };
            break;
          }
          const hadCompileError = r.diagnostics.some((d) => d.severity === 'error' || d.severity === 'fatal error');
          if (hadCompileError) {
            builds.push({ id, opt_level: level, sanitizers: active, built: false, reason: 'source does not compile', stderr_preview: preview(r.exec.stderr, 15) });
            active = [];
            break;
          }
          builds.push({ id, opt_level: level, sanitizers: active, built: false, reason: 'sanitizer runtime does not link on this toolchain', stderr_preview: preview(r.exec.stderr, 6) });
          ev.limit(`-fsanitize=${active.join(',')} did not link with ${compiler.name}; retried with fewer sanitizers.`);
          active = active.slice(0, -1);
        }
        if (!built) continue;
        const env: Record<string, string> = {
          UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=0',
          ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=0:symbolize=1',
          MSAN_OPTIONS: 'halt_on_error=1',
        };
        const run = await runProgram(ev, built.r.outPath, input.run, `run ${built.id}`, { compilerPath: compiler.path, env });
        ranAny = true;
        const f = parseSanitizerOutput(run.exec.stderr, level);
        findings.push(...f);
        builds.push({ id: built.id, opt_level: level, sanitizers: built.active, built: true, outcome: run.outcome, findings: f.length, stderr_preview: run.exec.stderr ? preview(run.exec.stderr, 8) : '' });
        if (run.exec.timedOut) ev.unknown(`The ${built.id} build timed out after ${input.run.timeout_s}s; paths after that point were not checked.`);
        if (f.length === 0 && run.exec.exitCode !== 0 && !run.exec.timedOut) {
          ev.unknown(`The ${built.id} build exited with ${run.outcome} but printed no sanitizer report; the cause of the non-zero exit is not established.`);
        }
      }
    }

    if (!ranAny) {
      return {
        status: 'inconclusive',
        summary: 'no sanitizer build could be produced; UB status unknown',
        result: { clean: null, findings: [], builds, compiler_warnings: [...warnings.values()].slice(0, 30) },
      };
    }
    const unique = new Map<string, UbFinding>();
    for (const f of findings) {
      const k = `${f.sanitizer}|${f.file}|${f.line}|${f.column}|${f.message}`;
      if (!unique.has(k)) unique.set(k, f);
    }
    const list = [...unique.values()];
    for (const f of list) ev.observe(`${f.sanitizer}: ${f.message}${f.file ? ` at ${path.basename(f.file)}:${f.line}${f.column !== null ? `:${f.column}` : ''}` : ''} (-${f.opt_level})`);
    const used = [...new Set(builds.filter((b) => b['built']).flatMap((b) => b['sanitizers'] as string[]))];
    ev.cover('opt_levels', input.opt_levels);
    ev.cover('sanitizers_run', used);
    ev.cover('inputs', { args: input.run.args, stdin: input.run.stdin !== undefined });
    if (list.length === 0) {
      ev.observe(`No sanitizer report at ${input.opt_levels.map((l) => `-${l}`).join(', ')} with ${used.join(', ')}.`);
      ev.unknown('Whether the program has UB that these sanitizers cannot see, or on inputs that were not run.');
    } else {
      ev.infer('The program executes undefined behaviour, so differing output across optimisation levels is permitted by the language standard and is not evidence of a compiler bug.');
    }
    const first = list[0];
    return {
      status: 'ok',
      summary: first
        ? `UB found: ${first.message}${first.file ? ` at ${path.basename(first.file)}:${first.line}` : ''}`
        : `no sanitizer findings (${used.join(', ')} at ${input.opt_levels.join(', ')}); not proof of UB-freedom`,
      result: {
        clean: list.length === 0,
        findings: list.slice(0, 50),
        findings_total: list.length,
        builds,
        compiler: { path: compiler.path, version: compiler.version, target: compiler.target },
        compiler_warnings: [...warnings.values()].slice(0, 30),
      },
    };
  },
});
