import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { EvidenceBuilder } from './context.js';
import { CeaError } from './errors.js';
import type { CompilerFamily, CompilerInfo } from './toolbox.js';
import type { ExecResult, FileRef } from './types.js';
import { exeName, normalizeNewlines, sha256 } from './util.js';

/* ---------- shared input schemas ---------- */

export const LanguageSchema = z.enum(['c', 'c++', 'rust', 'llvm-ir']);
export type Language = z.infer<typeof LanguageSchema>;

export const SourceSchema = z.strictObject({
  path: z.string().min(1).optional().describe('Path to a source file on disk.'),
  code: z.string().max(2_000_000).optional().describe('Source text, when there is no file. Exactly one of path or code.'),
  language: LanguageSchema.optional().describe('Required with code; inferred from the extension with path.'),
}).describe('The program under test: a file path or inline code.');

export const FlagsSchema = z.array(z.string().max(500)).max(200).describe('Extra compiler flags, one array element per argument. Passed verbatim, never through a shell.');

export const OptLevelSchema = z.enum(['O0', 'O1', 'O2', 'O3', 'Os', 'Oz', 'Og']);
export type OptLevel = z.infer<typeof OptLevelSchema>;

export const TimeoutSchema = z.number().int().min(1).max(3600).describe('Seconds.');

export const RunSpecSchema = z.strictObject({
  args: z.array(z.string().max(4000)).max(100).default([]).describe('Arguments for the compiled test program.'),
  stdin: z.string().max(1_000_000).optional().describe('Text fed to the program on stdin.'),
  timeout_s: TimeoutSchema.default(10).describe('Per-run timeout in seconds.'),
}).describe('How to run the compiled test program.');
export type RunSpec = z.infer<typeof RunSpecSchema>;
export const DEFAULT_RUN: RunSpec = { args: [], timeout_s: 10 };

/* ---------- flag safety ---------- */

const UNSAFE_FLAG = [
  /^-fplugin/, /^-fpass-plugin/, /^-load$/, /^--?load-pass-plugin/, /^--?load=/, /^-wrapper$/, /^-B/, /^-specs/, /^--specs/, /^@/,
  /^-fuse-ld=.*[\\/]/, /^--?sysroot-exec/, /^-Xlinker$/, /^-fprofile-use-sample/,
];

/** Reject flags that make the compiler load or execute code other than itself. */
export function checkFlags(flags: string[], allowUnsafe: boolean): void {
  if (allowUnsafe) return;
  for (const f of flags) {
    if (f === '-o' || /^-o./.test(f) && !f.startsWith('-opt') && !f.startsWith('-object')) {
      throw new CeaError('INVALID_INPUT', `flag ${f} is not allowed: cea chooses output paths itself`, 'Remove -o; the output is returned as a view of the Evidence record.');
    }
    if (UNSAFE_FLAG.some((re) => re.test(f))) {
      throw new CeaError('UNSAFE_FLAG', `flag ${f} makes the compiler load or run other code and is rejected by default`, 'Remove the flag, or set CEA_ALLOW_UNSAFE_FLAGS=1 if you trust the plugin or wrapper.');
    }
  }
}

/* ---------- source handling ---------- */

const EXT: Record<Language, string> = { 'c': '.c', 'c++': '.cpp', 'rust': '.rs', 'llvm-ir': '.ll' };

export function languageOf(file: string): Language | null {
  const e = path.extname(file).toLowerCase();
  if (e === '.c' || e === '.h' || e === '.i') return 'c';
  if (['.cc', '.cpp', '.cxx', '.c++', '.hpp', '.ii'].includes(e)) return 'c++';
  if (e === '.rs') return 'rust';
  if (e === '.ll') return 'llvm-ir';
  return null;
}

export interface Source {
  file: string;
  language: Language;
  ref: FileRef;
  text: string;
}

/** Turn a {path | code} input into a file inside the evidence work dir, and record its hash. */
export function materialize(ev: EvidenceBuilder, src: z.infer<typeof SourceSchema>, baseName = 'input'): Source {
  if ((src.path === undefined) === (src.code === undefined)) {
    throw new CeaError('INVALID_INPUT', 'source needs exactly one of path or code', 'Pass {"path": "file.c"} or {"code": "...", "language": "c"}.');
  }
  if (src.path !== undefined) {
    const abs = path.resolve(src.path);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new CeaError('NOT_FOUND', `source file not found: ${abs}`, 'Pass an existing file path, or inline code.');
    }
    const language = src.language ?? languageOf(abs);
    if (!language) {
      throw new CeaError('INVALID_INPUT', `cannot infer the language of ${abs}`, 'Set source.language to c, c++, rust or llvm-ir.');
    }
    // Compile a private copy so that dump files and outputs never land next to the user's source.
    const copy = path.join(ev.workDir, `${baseName}${EXT[language]}`);
    fs.copyFileSync(abs, copy);
    const ref = ev.file(abs);
    return { file: copy, language, ref, text: fs.readFileSync(abs, 'utf8') };
  }
  if (!src.language) {
    throw new CeaError('INVALID_INPUT', 'source.language is required with inline code', 'Set source.language to c, c++, rust or llvm-ir.');
  }
  const file = path.join(ev.workDir, `${baseName}${EXT[src.language]}`);
  fs.writeFileSync(file, src.code!, 'utf8');
  const ref = ev.file(file);
  return { file, language: src.language, ref, text: src.code! };
}

/* ---------- compiler invocation ---------- */

export function optFlags(family: CompilerFamily, level: OptLevel): string[] {
  if (family === 'rustc') {
    const map: Record<OptLevel, string> = { O0: '0', O1: '1', O2: '2', O3: '3', Os: 's', Oz: 'z', Og: '1' };
    return ['-C', `opt-level=${map[level]}`];
  }
  if (family === 'gcc' && level === 'Oz') return ['-Os'];
  return [`-${level}`];
}

export interface Diagnostic {
  file: string;
  line: number;
  column: number | null;
  severity: 'error' | 'warning' | 'note' | 'fatal error';
  message: string;
}

export function parseDiagnostics(stderr: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re = /^(.+?):(\d+):(?:(\d+):)? (fatal error|error|warning|note): (.*)$/;
  for (const line of normalizeNewlines(stderr).split('\n')) {
    const m = re.exec(line);
    if (m) out.push({ file: m[1]!, line: Number(m[2]), column: m[3] ? Number(m[3]) : null, severity: m[4] as Diagnostic['severity'], message: m[5]! });
  }
  return out;
}

/** Signals that the compiler itself crashed, as opposed to rejecting the input. */
export function looksLikeCompilerCrash(r: ExecResult): boolean {
  if (r.timedOut) return false;
  if (r.signal) return true;
  const text = r.stderr;
  return /PLEASE submit a bug report|internal compiler error|Stack dump:|Assertion .* failed|LLVM ERROR:|UNREACHABLE executed|error: clang frontend command failed (due to signal|with exit code 1[3-9]\d)/.test(text);
}

export type OutputKind = 'exe' | 'asm' | 'ir' | 'obj';

export interface CompileRequest {
  compiler: CompilerInfo;
  source: Source;
  flags: string[];
  kind: OutputKind;
  outBase: string;
  purpose: string;
  timeoutMs?: number;
  keep?: 'both' | 'stdout' | 'stderr' | 'none';
  maxOutputBytes?: number;
}

export interface CompileResult {
  ok: boolean;
  outPath: string;
  exec: ExecResult;
  diagnostics: Diagnostic[];
  crashed: boolean;
}

function kindArgs(family: CompilerFamily, kind: OutputKind, lang: Language): { args: string[]; ext: string } {
  if (family === 'rustc') {
    switch (kind) {
      case 'exe': return { args: [], ext: process.platform === 'win32' ? '.exe' : '' };
      case 'asm': return { args: ['--emit=asm', '--crate-type=lib'], ext: '.s' };
      case 'ir': return { args: ['--emit=llvm-ir', '--crate-type=lib'], ext: '.ll' };
      case 'obj': return { args: ['--emit=obj', '--crate-type=lib'], ext: '.o' };
    }
  }
  if (kind === 'ir' && family === 'gcc') {
    throw new CeaError('UNSUPPORTED', 'GCC does not emit LLVM IR', 'Use pass_timeline (GIMPLE dumps) or emit_ir for GCC, or compile with clang.');
  }
  switch (kind) {
    case 'exe': return { args: lang === 'c' ? ['-lm'] : [], ext: process.platform === 'win32' ? '.exe' : '' };
    case 'asm': return { args: ['-S'], ext: '.s' };
    case 'ir': return { args: ['-S', '-emit-llvm'], ext: '.ll' };
    case 'obj': return { args: ['-c'], ext: '.o' };
  }
}

/** If the user asked for clang/gcc but the source is C++, use the C++ driver next to it. */
export async function driverFor(ev: EvidenceBuilder, compiler: CompilerInfo, language: Language): Promise<CompilerInfo> {
  if (language !== 'c++' || (compiler.family !== 'clang' && compiler.family !== 'gcc')) return compiler;
  const base = path.basename(compiler.path);
  if (base.includes('++')) return compiler;
  const cxx = base.replace(/^clang/, 'clang++').replace(/^gcc/, 'g++');
  const candidate = path.join(path.dirname(compiler.path), cxx);
  if (fs.existsSync(candidate)) return ev.compiler(candidate);
  throw new CeaError('PROVIDER_UNAVAILABLE', `no C++ driver (${cxx}) next to ${compiler.path}`, 'Pass the C++ driver explicitly as the compiler (clang++ or g++).');
}

export async function compileTo(ev: EvidenceBuilder, req: CompileRequest): Promise<CompileResult> {
  checkFlags(req.flags, ev.ctx.config.allowUnsafeFlags);
  const compiler = await driverFor(ev, req.compiler, req.source.language);
  const { args: kArgs, ext } = kindArgs(compiler.family, req.kind, req.source.language);
  const outPath = path.join(ev.workDir, `${req.outBase}${ext}`);
  // -lm goes after the source for linkers that resolve left to right.
  const pre = kArgs.filter((a) => a !== '-lm');
  const post = kArgs.filter((a) => a === '-lm' && process.platform !== 'win32');
  const argv = [...req.flags, ...pre, req.source.file, '-o', outPath, ...post];
  const runOpts: Parameters<EvidenceBuilder['run']>[3] = { timeoutMs: req.timeoutMs ?? 120_000, keep: req.keep ?? 'stderr' };
  if (req.maxOutputBytes !== undefined) runOpts.maxOutputBytes = req.maxOutputBytes;
  const exec = await ev.run(req.purpose, compiler.path, argv, runOpts);
  const ok = !exec.timedOut && exec.exitCode === 0 && fs.existsSync(outPath);
  return { ok, outPath, exec, diagnostics: parseDiagnostics(exec.stderr), crashed: !ok && looksLikeCompilerCrash(exec) };
}

/* ---------- running compiled test programs ---------- */

/** Directories holding compiler runtime DLLs (sanitizers, libgcc) that test programs need on Windows. */
export function runtimeDirs(compilerPath: string): string[] {
  const bin = path.dirname(compilerPath);
  const dirs = [bin];
  const root = path.dirname(bin);
  try {
    for (const d of fs.readdirSync(root)) {
      const cand = path.join(root, d, 'bin');
      if (/mingw|w64/.test(d) && fs.existsSync(cand)) dirs.push(cand);
    }
  } catch {
    /* toolchain root not listable: the compiler's own directory is enough */
  }
  return dirs;
}

export interface ProgramRun {
  exec: ExecResult;
  stdout_sha256: string;
  /** exit code, or "timeout", or "signal:NAME" */
  outcome: string;
}

/**
 * Run a compiled test program with a scrubbed environment, a timeout and an output cap.
 * This limits accidents; it is not a security boundary. The program's code does execute.
 */
export async function runProgram(ev: EvidenceBuilder, exe: string, spec: RunSpec, purpose: string, opts: { compilerPath?: string; env?: Record<string, string>; keep?: 'both' | 'stdout' | 'stderr' | 'none' } = {}): Promise<ProgramRun> {
  const extraDirs = opts.compilerPath ? runtimeDirs(opts.compilerPath) : [];
  const basePath = process.env['PATH'] ?? process.env['Path'] ?? '';
  const env: Record<string, string> = {
    PATH: [...extraDirs, basePath].join(path.delimiter),
    LANG: 'C',
    LC_ALL: 'C',
    ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
    ...(process.env['TEMP'] ? { TEMP: process.env['TEMP'] } : {}),
    ...(process.env['TMP'] ? { TMP: process.env['TMP'] } : {}),
    ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
    ...(opts.env ?? {}),
  };
  const runOpts: Parameters<EvidenceBuilder['run']>[3] = { timeoutMs: spec.timeout_s * 1000, maxOutputBytes: 4 * 1024 * 1024, env, keep: opts.keep ?? 'both' };
  if (spec.stdin !== undefined) runOpts.stdin = spec.stdin;
  const exec = await ev.run(purpose, exe, spec.args, runOpts);
  const outcome = exec.timedOut ? 'timeout' : exec.signal ? `signal:${exec.signal}` : String(exec.exitCode);
  return { exec, stdout_sha256: sha256(normalizeNewlines(exec.stdout)), outcome };
}

export function behaviorKey(run: ProgramRun): string {
  return `${run.outcome}|${run.stdout_sha256}`;
}

export function exePath(ev: EvidenceBuilder, base: string): string {
  return path.join(ev.workDir, exeName(base));
}

export const SANITIZER_BLIND_SPOTS = [
  'Sanitizers only see undefined behaviour on the paths this input executed; a clean run is not proof of UB-freedom.',
  'Not detected by UBSan/ASan: strict-aliasing violations, unsequenced modifications, most uninitialised reads (needs MSan), data races (needs TSan), and UB the frontend folded away before instrumentation.',
];
