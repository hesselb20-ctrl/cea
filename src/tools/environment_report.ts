import os from 'node:os';
import { z } from 'zod';
import { compileTo, materialize } from '../core/build.js';
import { defineTool } from '../core/context.js';
import type { CompilerInfo } from '../core/toolbox.js';

const PROBE = 'int main(void) { return 0; }\n';

export const environmentReport = defineTool({
  name: 'environment_report',
  family: 'environment',
  title: 'Environment report',
  description:
    'Detect compilers, their versions and targets, and every provider cea can use, with the reason and a fix for each one that is missing. ' +
    'Call this first: no conclusion about a compiler is valid without the exact version, flags and target.',
  input: z.strictObject({
    probe_sanitizers: z.boolean().default(true).describe('Compile a one-line program with each sanitizer to see which ones actually link on this machine.'),
  }),
  async run(input, ev, ctx) {
    const providers = await ctx.toolbox.all();
    const compilers: CompilerInfo[] = [];
    for (const id of ['clang', 'gcc', 'rustc']) {
      if (await ctx.toolbox.has(id)) compilers.push(await ev.compiler(id));
    }
    for (const p of providers) {
      if (p.available) ev.observe(`${p.id}: ${p.version} (${p.path})`);
      else ev.observe(`${p.id}: unavailable, ${p.reason}`);
    }

    const sanitizers: Record<string, Record<string, boolean>> = {};
    if (input.probe_sanitizers) {
      const src = materialize(ev, { code: PROBE, language: 'c' }, 'probe');
      for (const c of compilers.filter((x) => x.family === 'clang' || x.family === 'gcc')) {
        const kinds = c.family === 'clang' ? ['undefined', 'address', 'memory'] : ['undefined', 'address'];
        const table: Record<string, boolean> = {};
        for (const k of kinds) {
          const r = await compileTo(ev, { compiler: c, source: src, flags: [`-fsanitize=${k}`], kind: 'exe', outBase: `probe-${c.name}-${k}`, purpose: `probe ${c.name} -fsanitize=${k}`, keep: 'none', timeoutMs: 60_000 });
          table[k] = r.ok;
        }
        sanitizers[c.name] = table;
        ev.observe(`${c.name} sanitizers that link here: ${Object.entries(table).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
      }
    } else {
      ev.unknown('Sanitizer availability was not probed (probe_sanitizers=false).');
    }

    let llvmTargets: string[] = [];
    const llc = providers.find((p) => p.id === 'llc');
    if (llc?.available && llc.path) {
      const r = await ev.run('list llc targets', llc.path, ['--version'], { keep: 'none', timeoutMs: 15_000 });
      const idx = r.stdout.indexOf('Registered Targets:');
      if (idx >= 0) {
        llvmTargets = r.stdout.slice(idx).split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)[0] ?? '').filter(Boolean);
      }
    }

    const warnings: string[] = [];
    const majors = new Map<string, string>();
    for (const p of providers) {
      if (!p.available || !(p.kind === 'llvm-tool' || p.id === 'clang' || p.id === 'llvm-reduce')) continue;
      const m = /(\d+)\.\d+\.\d+/.exec(p.version ?? '');
      if (m) majors.set(p.id, m[1]!);
    }
    if (new Set(majors.values()).size > 1) {
      const w = `LLVM tools have different major versions: ${[...majors].map(([k, v]) => `${k}=${v}`).join(', ')}. IR printed by one may not parse in another.`;
      warnings.push(w);
      ev.limit(w);
    }
    const remote = { compiler_explorer: ctx.config.remoteProviders.has('compiler-explorer') };
    if (remote.compiler_explorer) warnings.push('Remote provider compiler-explorer is enabled: validate_transform may send IR to alive2.llvm.org.');

    const cpus = os.cpus();
    const missing = providers.filter((p) => !p.available).map((p) => p.id);
    ev.cover('providers_checked', providers.length);
    ev.limit('Detection covers binaries on PATH, CEA_TOOLCHAIN_DIRS and CEA_TOOL_* overrides only; other installed toolchains are not discovered.');
    return {
      status: 'ok',
      summary: `${providers.length - missing.length}/${providers.length} providers available; compilers: ${compilers.map((c) => `${c.name} (${c.target ?? 'unknown target'})`).join(', ') || 'none'}`,
      result: {
        host: {
          platform: process.platform,
          arch: process.arch,
          os_release: os.release(),
          cpu_model: (cpus[0]?.model ?? 'unknown').trim(),
          logical_cpus: cpus.length,
          node: process.version,
        },
        compilers: compilers.map((c) => ({ id: c.name, family: c.family, path: c.path, version: c.version, target: c.target })),
        providers,
        missing,
        sanitizers,
        llvm_targets: llvmTargets,
        remote_providers: remote,
        warnings,
        session: { home: ctx.config.home, session: ctx.config.session, ledger_dir: ctx.ledger.dir },
      },
    };
  },
});
