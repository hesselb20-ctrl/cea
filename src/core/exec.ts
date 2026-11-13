import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ExecFn, ExecOptions, ExecResult } from './types.js';

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    /* process already gone */
  }
}

function failed(cmd: string, args: string[], cwd: string, spawnError: string): ExecResult {
  return {
    argv: [cmd, ...args], cwd, exitCode: null, signal: null, stdout: '', stderr: '',
    timedOut: false, truncated: false, durationMs: 0, spawnError,
  };
}

/**
 * Run one process. Arguments are passed as an array and no shell is involved, so nothing in
 * `args` can be interpreted as shell syntax. The process tree is killed on timeout, and output
 * beyond the cap is dropped (and flagged) rather than buffered.
 */
export const realExec: ExecFn = (cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> => {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = process.hrtime.bigint();

  return new Promise<ExecResult>((resolve) => {
    const ext = path.extname(cmd).toLowerCase();
    if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
      resolve(failed(cmd, args, cwd, `refusing to run ${cmd}: batch files need a shell, and cea never spawns through a shell`));
      return;
    }
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve(failed(cmd, args, cwd, e instanceof Error ? e.message : String(e)));
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const sizes = { out: 0, err: 0 };
    let truncated = false;
    let timedOut = false;
    let spawnError: string | undefined;
    let settled = false;

    const collect = (chunks: Buffer[], key: 'out' | 'err') => (d: Buffer) => {
      const room = max - sizes[key];
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (d.length > room) {
        chunks.push(d.subarray(0, room));
        sizes[key] += room;
        truncated = true;
      } else {
        chunks.push(d);
        sizes[key] += d.length;
      }
    };
    child.stdout.on('data', collect(out, 'out'));
    child.stderr.on('data', collect(err, 'err'));

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const r: ExecResult = {
        argv: [cmd, ...args], cwd, exitCode, signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut, truncated,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      };
      if (spawnError !== undefined) r.spawnError = spawnError;
      resolve(r);
    };

    child.on('error', (e) => {
      spawnError = e.message;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));

    child.stdin.on('error', () => { /* child closed stdin early */ });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
};
