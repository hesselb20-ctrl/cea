import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ctx } from '../src/core/context.js';
import { Ledger } from '../src/core/ledger.js';
import { Toolbox } from '../src/core/toolbox.js';
import type { Evidence, ExecFn, ExecOptions, ExecResult } from '../src/core/types.js';

/** Where the fake provider binaries "live". Nothing is ever created here. */
export const FAKE_DIR = path.join(os.tmpdir(), 'cea-fake-bin');

export type Reply = Partial<Pick<ExecResult, 'exitCode' | 'stdout' | 'stderr' | 'timedOut' | 'signal'>> | undefined;
export type Handler = (args: string[], opts: ExecOptions | undefined, cmd: string) => Reply | Promise<Reply>;

const VERSIONS: Record<string, string> = {
  clang: 'Ubuntu clang version 18.1.3 (1ubuntu1)\nTarget: x86_64-pc-linux-gnu',
  gcc: 'gcc (Ubuntu 13.2.0-23ubuntu4) 13.2.0\nCopyright (C) 2023 Free Software Foundation, Inc.',
  git: 'git version 2.43.0',
};

export interface Fake {
  ctx: Ctx;
  home: string;
  calls: { cmd: string; args: string[] }[];
}

export function tmpDir(prefix = 'cea-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const baseName = (cmd: string) => path.basename(cmd).replace(/\.exe$/i, '');

/**
 * A context whose providers are fakes. `handlers` maps a binary name to a function that plays
 * that binary; "*" plays any other executable (the compiled test programs). A handler that
 * returns undefined falls back to a default (--version, -dumpmachine, or exit 0).
 */
export function fake(handlers: Record<string, Handler>, opts: { remote?: boolean; fetch?: typeof fetch; allowUnsafeFlags?: boolean } = {}): Fake {
  const home = tmpDir();
  const calls: Fake['calls'] = [];
  const providers = new Set(Object.keys(handlers).filter((k) => k !== '*' && k !== 'node'));
  const exec: ExecFn = async (cmd, args, o) => {
    calls.push({ cmd, args });
    const name = baseName(cmd);
    const isProvider = providers.has(name) && path.dirname(cmd) === FAKE_DIR;
    const handler = isProvider ? handlers[name] : cmd === process.execPath && handlers['node'] ? handlers['node'] : handlers['*'];
    const blank: ExecResult = { argv: [cmd, ...args], cwd: o?.cwd ?? process.cwd(), exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1 };
    if (!handler) return { ...blank, exitCode: null, spawnError: `ENOENT: no fake for ${cmd}` };
    const reply = await handler(args, o, cmd);
    if (reply !== undefined) return { ...blank, ...reply };
    if (isProvider && args.includes('--version')) return { ...blank, stdout: VERSIONS[name] ?? `${name} version 1.2.3` };
    if (isProvider && args[0] === '-dumpmachine') return { ...blank, stdout: 'x86_64-pc-linux-gnu\n' };
    return blank;
  };
  const toolbox = new Toolbox({
    exec,
    env: { PATH: FAKE_DIR },
    platform: 'linux',
    exists: (p) => path.dirname(p) === FAKE_DIR && providers.has(path.basename(p)),
    listDir: () => [],
  });
  const config = { home, session: 'test', remoteProviders: new Set(opts.remote ? ['compiler-explorer'] : []), allowUnsafeFlags: opts.allowUnsafeFlags ?? false };
  const ctx: Ctx = {
    config,
    ledger: new Ledger(home, 'test'),
    exec,
    toolbox,
    fetch: opts.fetch ?? (async () => { throw new Error('network access attempted in a unit test'); }),
  };
  return { ctx, home, calls };
}

/** The path a fake compiler was asked to write to. */
export function outArg(args: string[]): string {
  const i = args.lastIndexOf('-o');
  if (i < 0 || i + 1 >= args.length) throw new Error(`no -o in ${args.join(' ')}`);
  return args[i + 1]!;
}

export function writeOut(args: string[], content: string): void {
  fs.writeFileSync(outArg(args), content, 'utf8');
}

/** The source file a fake compiler was given. */
export function srcArg(args: string[]): string {
  const f = args.find((a) => /\.(c|cpp|ll|rs)$/.test(a) && !a.startsWith('-'));
  if (!f) throw new Error(`no source file in ${args.join(' ')}`);
  return f;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const res = (e: { result: Record<string, unknown> }): any => e.result;

export function isEvidence(e: unknown): e is Evidence {
  return typeof e === 'object' && e !== null && (e as Evidence).schema === 'cea.evidence/1';
}

export const C_SRC = { code: 'int main(void) { return 0; }\n', language: 'c' as const };
