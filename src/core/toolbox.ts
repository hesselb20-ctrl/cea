import fs from 'node:fs';
import path from 'node:path';
import { CeaError } from './errors.js';
import type { ExecFn, ToolVersion } from './types.js';

export type ProviderKind = 'compiler' | 'llvm-tool' | 'verifier' | 'reducer' | 'fuzzer' | 'profiler' | 'vcs' | 'remote';

export interface ProviderSpec {
  id: string;
  kind: ProviderKind;
  /** Binary names to try, in order. */
  candidates: string[];
  versionArgs: string[];
  /** LLVM tools are often installed as `opt-18`; try versioned names too. */
  llvmVersioned?: boolean;
  /** Which cea tools need this provider. */
  neededBy: string[];
  /** Remediation shown when the provider is missing. */
  install: string;
  /** Version output that disqualifies a binary (a  that is really clang, as on macOS and llvm-mingw). */
  reject?: RegExp;
  /** Restrict to some platforms (perf is Linux only). */
  platforms?: NodeJS.Platform[];
}

export interface ProviderStatus {
  id: string;
  kind: ProviderKind;
  available: boolean;
  path?: string;
  version?: string;
  reason?: string;
  remediation?: string;
  needed_by: string[];
}

export type CompilerFamily = 'clang' | 'gcc' | 'rustc' | 'unknown';

export interface CompilerInfo extends ToolVersion {
  family: CompilerFamily;
  target: string | null;
}

const LLVM_HINT = 'Install LLVM (apt install llvm clang, brew install llvm, or the release archive from github.com/llvm/llvm-project/releases) and put its bin directory on PATH or in CEA_TOOLCHAIN_DIRS.';

export const PROVIDERS: ProviderSpec[] = [
  { id: 'clang', kind: 'compiler', candidates: ['clang'], versionArgs: ['--version'], llvmVersioned: true, neededBy: ['compile', 'emit_ir', 'pass_timeline', 'opt_remarks', 'check_ub', 'differential_run', 'bisect_passes', 'triage_miscompile'], install: LLVM_HINT },
  { id: 'gcc', kind: 'compiler', candidates: ['gcc'], versionArgs: ['--version'], reject: /clang/i, neededBy: ['compile', 'pass_timeline', 'opt_remarks', 'differential_run'], install: 'Install GCC (apt install gcc, brew install gcc, or a MinGW-w64 build on Windows).' },
  { id: 'rustc', kind: 'compiler', candidates: ['rustc'], versionArgs: ['--version'], neededBy: ['compile', 'emit_ir', 'differential_run'], install: 'Install Rust with rustup (https://rustup.rs).' },
  { id: 'cargo', kind: 'compiler', candidates: ['cargo'], versionArgs: ['--version'], neededBy: ['check_ub (Miri)'], install: 'Install Rust with rustup (https://rustup.rs).' },
  { id: 'miri', kind: 'verifier', candidates: ['cargo'], versionArgs: ['miri', '--version'], neededBy: ['check_ub (Rust)'], install: 'rustup toolchain install nightly && rustup +nightly component add miri, then set CEA_TOOL_MIRI to the nightly cargo if it is not the default.' },
  { id: 'opt', kind: 'llvm-tool', candidates: ['opt'], versionArgs: ['--version'], llvmVersioned: true, neededBy: ['pass_timeline (IR input)', 'validate_transform (pass mode)'], install: LLVM_HINT },
  { id: 'llc', kind: 'llvm-tool', candidates: ['llc'], versionArgs: ['--version'], llvmVersioned: true, neededBy: ['compile (IR input)'], install: LLVM_HINT },
  { id: 'llvm-reduce', kind: 'reducer', candidates: ['llvm-reduce'], versionArgs: ['--version'], llvmVersioned: true, neededBy: ['reduce_testcase (IR)'], install: LLVM_HINT },
  { id: 'llvm-mca', kind: 'llvm-tool', candidates: ['llvm-mca'], versionArgs: ['--version'], llvmVersioned: true, neededBy: ['analyze_throughput'], install: LLVM_HINT },
  { id: 'llvm-mc', kind: 'llvm-tool', candidates: ['llvm-mc'], versionArgs: ['--version'], llvmVersioned: true, neededBy: ['environment_report'], install: LLVM_HINT },
  { id: 'llvm-objdump', kind: 'llvm-tool', candidates: ['llvm-objdump'], versionArgs: ['--version'], llvmVersioned: true, neededBy: ['compile (object disassembly)'], install: LLVM_HINT },
  { id: 'FileCheck', kind: 'llvm-tool', candidates: ['FileCheck'], versionArgs: ['--version'], llvmVersioned: true, neededBy: ['writing lit tests (skill guidance)'], install: 'FileCheck ships with LLVM development packages (apt install llvm-NN-tools) or an LLVM build tree.' },
  { id: 'alive-tv', kind: 'verifier', candidates: ['alive-tv'], versionArgs: ['--version'], neededBy: ['validate_transform', 'triage_miscompile'], install: 'Build Alive2 (https://github.com/AliveToolkit/alive2) against your LLVM and put alive-tv on PATH, or enable the remote provider with CEA_REMOTE_PROVIDERS=compiler-explorer (sends the IR to alive2.llvm.org).' },
  { id: 'cvise', kind: 'reducer', candidates: ['cvise'], versionArgs: ['--version'], neededBy: ['reduce_testcase'], install: 'apt install cvise, or pip install cvise. Without it reduce_testcase falls back to the built-in line reducer.' },
  { id: 'creduce', kind: 'reducer', candidates: ['creduce'], versionArgs: ['--version'], neededBy: ['reduce_testcase'], install: 'apt install creduce / brew install creduce. cvise is preferred when both exist.' },
  { id: 'csmith', kind: 'fuzzer', candidates: ['csmith'], versionArgs: ['--version'], neededBy: ['fuzz_compiler'], install: 'apt install csmith libcsmith-dev, or build from https://github.com/csmith-project/csmith. Set CEA_CSMITH_INCLUDE if csmith.h is not in /usr/include/csmith.' },
  { id: 'yarpgen', kind: 'fuzzer', candidates: ['yarpgen'], versionArgs: ['--version'], neededBy: ['fuzz_compiler'], install: 'Build YARPGen from https://github.com/intel/yarpgen and put it on PATH.' },
  { id: 'perf', kind: 'profiler', candidates: ['perf'], versionArgs: ['--version'], neededBy: ['benchmark (hardware counters)'], install: 'apt install linux-tools-common linux-tools-$(uname -r). Linux only.', platforms: ['linux'] },
  { id: 'git', kind: 'vcs', candidates: ['git'], versionArgs: ['--version'], neededBy: ['bisect_compiler_history'], install: 'Install git.' },
];

export interface ToolboxOptions {
  exec: ExecFn;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Replaceable in tests. */
  exists?: (p: string) => boolean;
  listDir?: (d: string) => string[];
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readDir(d: string): string[] {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

function envKey(id: string): string {
  return `CEA_TOOL_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function firstVersionLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.find((l) => /\bversion\b|\d+\.\d+/i.test(l)) ?? lines[0] ?? '';
}

/** Finds provider binaries and remembers their versions. Never installs anything. */
export class Toolbox {
  private readonly exec: ExecFn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly exists: (p: string) => boolean;
  private readonly listDir: (d: string) => string[];
  private readonly statusCache = new Map<string, Promise<ProviderStatus>>();
  private readonly compilerCache = new Map<string, Promise<CompilerInfo>>();

  constructor(opts: ToolboxOptions) {
    this.exec = opts.exec;
    this.env = opts.env ?? process.env;
    this.platform = opts.platform ?? process.platform;
    this.exists = opts.exists ?? isFile;
    this.listDir = opts.listDir ?? readDir;
  }

  searchDirs(): string[] {
    const split = (v: string | undefined) => (v ?? '').split(path.delimiter).map((s) => s.trim()).filter((s) => s.length > 0);
    return [...split(this.env['CEA_TOOLCHAIN_DIRS']), ...split(this.env['PATH'] ?? this.env['Path'])];
  }

  private withExt(p: string): string | null {
    if (this.platform === 'win32') {
      if (path.extname(p) === '' && this.exists(`${p}.exe`)) return `${p}.exe`;
      return this.exists(p) ? p : null;
    }
    return this.exists(p) ? p : null;
  }

  /** Locate a binary by bare name or path. Returns an absolute path or null. */
  locate(name: string, opts: { versioned?: boolean; preferDir?: string; preferSuffix?: string } = {}): string | null {
    if (name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
      const hit = this.withExt(path.resolve(name));
      return hit;
    }
    const dirs = [...(opts.preferDir ? [opts.preferDir] : []), ...this.searchDirs()];
    if (opts.preferDir && opts.preferSuffix) {
      const hit = this.withExt(path.join(opts.preferDir, `${name}${opts.preferSuffix}`));
      if (hit) return hit;
    }
    for (const d of dirs) {
      const hit = this.withExt(path.join(d, name));
      if (hit) return hit;
    }
    if (opts.versioned) {
      const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)(\\.exe)?$`);
      let best: { v: number; p: string } | null = null;
      for (const d of dirs) {
        for (const f of this.listDir(d)) {
          const m = re.exec(f);
          if (m && (!best || Number(m[1]) > best.v)) best = { v: Number(m[1]), p: path.join(d, f) };
        }
        if (best) return best.p;
      }
    }
    return null;
  }

  /** Every match for a bare name, in search order. */
  locateAll(name: string): string[] {
    const hits: string[] = [];
    for (const d of this.searchDirs()) {
      const hit = this.withExt(path.join(d, name));
      if (hit && !hits.includes(hit)) hits.push(hit);
    }
    return hits;
  }

  /** Directory and version suffix of the resolved clang, so `opt` matches `clang`. */
  private clangAnchor(): { dir: string; suffix: string } | null {
    const override = this.env[envKey('clang')];
    const clang = override && this.withExt(override) ? this.withExt(override) : this.locate('clang', { versioned: true });
    if (!clang) return null;
    const base = path.basename(clang).replace(/\.exe$/i, '');
    const m = /^clang(-\d+)$/.exec(base);
    return { dir: path.dirname(clang), suffix: m ? m[1]! : '' };
  }

  private locateSpec(spec: ProviderSpec): { path: string | null; why?: string } {
    const override = this.env[envKey(spec.id)];
    if (override) {
      const hit = this.withExt(override);
      return hit ? { path: hit } : { path: null, why: `${envKey(spec.id)} points to ${override}, which does not exist` };
    }
    const anchor = spec.kind === 'llvm-tool' || spec.id === 'llvm-reduce' ? this.clangAnchor() : null;
    for (const c of spec.candidates) {
      const opts: { versioned?: boolean; preferDir?: string; preferSuffix?: string } = {};
      if (spec.llvmVersioned) opts.versioned = true;
      if (anchor) {
        opts.preferDir = anchor.dir;
        opts.preferSuffix = anchor.suffix;
      }
      const hit = this.locate(c, opts);
      if (hit) return { path: hit };
    }
    return { path: null };
  }

  spec(id: string): ProviderSpec | undefined {
    return PROVIDERS.find((p) => p.id === id);
  }

  status(id: string): Promise<ProviderStatus> {
    const cached = this.statusCache.get(id);
    if (cached) return cached;
    const p = this.computeStatus(id);
    this.statusCache.set(id, p);
    return p;
  }

  private async computeStatus(id: string): Promise<ProviderStatus> {
    const spec = this.spec(id);
    if (!spec) throw new CeaError('INTERNAL', `unknown provider ${id}`, 'Report this as a cea bug.');
    const base = { id: spec.id, kind: spec.kind, needed_by: spec.neededBy };
    if (spec.platforms && !spec.platforms.includes(this.platform)) {
      return { ...base, available: false, reason: `not supported on ${this.platform}`, remediation: spec.install };
    }
    const found = this.locateSpec(spec);
    if (!found.path) {
      return {
        ...base, available: false,
        reason: found.why ?? `no ${spec.candidates.join(' / ')} found in CEA_TOOLCHAIN_DIRS or PATH`,
        remediation: `${spec.install} Or set ${envKey(spec.id)} to the binary.`,
      };
    }
    let r = await this.exec(found.path, spec.versionArgs, { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
    if (spec.reject && spec.reject.test(r.stdout + r.stderr)) {
      // e.g. "gcc" is an alias for clang here: keep looking for a real one further down the search path.
      let real: string | null = null;
      for (const cand of spec.candidates.flatMap((c) => this.locateAll(c))) {
        if (cand === found.path) continue;
        const v = await this.exec(cand, spec.versionArgs, { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
        if (v.exitCode === 0 && !spec.reject.test(v.stdout + v.stderr)) {
          real = cand;
          r = v;
          break;
        }
      }
      if (!real) {
        return { ...base, available: false, path: found.path, reason: `${found.path} is not a real ${spec.id} (it reports: ${firstVersionLine(r.stdout || r.stderr)})`, remediation: `${spec.install} Or set ${envKey(spec.id)} to the binary.` };
      }
      found.path = real;
    }
    if (r.spawnError || r.timedOut || r.exitCode !== 0) {
      const why = r.spawnError ?? (r.timedOut ? 'timed out' : `exit code ${r.exitCode}: ${firstVersionLine(r.stderr || r.stdout)}`);
      return {
        ...base, available: false, path: found.path,
        reason: `found at ${found.path} but \`${spec.versionArgs.join(' ')}\` failed (${why})`,
        remediation: spec.install,
      };
    }
    return { ...base, available: true, path: found.path, version: firstVersionLine(r.stdout || r.stderr) };
  }

  async all(): Promise<ProviderStatus[]> {
    return Promise.all(PROVIDERS.map((p) => this.status(p.id)));
  }

  /** Resolve a provider or throw PROVIDER_UNAVAILABLE with a remediation hint. */
  async require(id: string): Promise<ToolVersion> {
    const s = await this.status(id);
    if (!s.available || !s.path) {
      throw new CeaError('PROVIDER_UNAVAILABLE', `${id} is not available: ${s.reason ?? 'not found'}`, s.remediation ?? 'Install it and re-run environment_report.', { provider: id });
    }
    return { name: id, path: s.path, version: s.version ?? '' };
  }

  async has(id: string): Promise<boolean> {
    return (await this.status(id)).available;
  }

  /** Resolve a compiler by provider id ("clang"), bare name ("clang-17") or path. */
  compiler(nameOrPath: string): Promise<CompilerInfo> {
    const cached = this.compilerCache.get(nameOrPath);
    if (cached) return cached;
    const p = this.computeCompiler(nameOrPath);
    this.compilerCache.set(nameOrPath, p);
    p.catch(() => this.compilerCache.delete(nameOrPath));
    return p;
  }

  private async computeCompiler(nameOrPath: string): Promise<CompilerInfo> {
    let bin: string | null = null;
    const spec = this.spec(nameOrPath);
    if (spec && spec.kind === 'compiler') {
      const s = await this.status(nameOrPath);
      if (!s.available || !s.path) {
        throw new CeaError('PROVIDER_UNAVAILABLE', `${nameOrPath} is not available: ${s.reason ?? 'not found'}`, s.remediation ?? spec.install, { provider: nameOrPath });
      }
      bin = s.path;
    } else {
      bin = this.locate(nameOrPath);
      if (!bin) {
        throw new CeaError('PROVIDER_UNAVAILABLE', `compiler "${nameOrPath}" was not found`, 'Pass a compiler name on PATH / CEA_TOOLCHAIN_DIRS (clang, gcc, clang-17, rustc) or an absolute path. environment_report lists what was detected.', { provider: nameOrPath });
      }
    }
    const v = await this.exec(bin, ['--version'], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
    if (v.spawnError || v.exitCode !== 0) {
      throw new CeaError('PROVIDER_UNAVAILABLE', `${bin} --version failed: ${v.spawnError ?? v.stderr.trim()}`, 'Check that the path is a working compiler.', { provider: nameOrPath });
    }
    const text = `${v.stdout}\n${v.stderr}`;
    const family: CompilerFamily = /rustc/i.test(text) ? 'rustc'
      : /clang/i.test(text) ? 'clang'
      : /Free Software Foundation|\bgcc\b|\bg\+\+/i.test(text) ? 'gcc'
      : 'unknown';
    let target: string | null = null;
    if (family === 'clang' || family === 'gcc') {
      const t = await this.exec(bin, ['-dumpmachine'], { timeoutMs: 15_000, maxOutputBytes: 4096 });
      if (t.exitCode === 0 && t.stdout.trim()) target = t.stdout.trim();
    } else if (family === 'rustc') {
      const t = await this.exec(bin, ['-vV'], { timeoutMs: 15_000, maxOutputBytes: 4096 });
      const m = /^host:\s*(\S+)/m.exec(t.stdout);
      if (m) target = m[1]!;
    }
    return { name: nameOrPath, path: bin, version: firstVersionLine(text), family, target };
  }
}
