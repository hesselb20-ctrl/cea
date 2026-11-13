// Record a real `cea` run as an asciicast v2 file (https://docs.asciinema.org/manual/asciicast/v2/).
//
//   node scripts/record-demo.mjs docs/demo/triage.cast triage examples/01-ub-not-a-compiler-bug/overflow.c
//
// The command is executed for real and its output is captured with timestamps. The only thing
// that is staged is the prompt line, which is "typed" before the command starts. Play the
// result with `asciinema play`, or turn it into a GIF with scripts/render-demo.mjs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [out, ...args] = process.argv.slice(2);
if (!out || args.length === 0) {
  console.error('usage: node scripts/record-demo.mjs <out.cast> <cea arguments...>');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');
const cols = 104;
const rows = 30;
const events = [];
const shown = `cea ${args.join(' ')}`;

let t = 0.4;
events.push([t, 'o', '\u001b[32m$\u001b[0m ']);
for (const ch of shown) {
  t += 0.035;
  events.push([t, 'o', ch]);
}
t += 0.5;
events.push([t, 'o', '\r\n']);

const started = process.hrtime.bigint();
const base = t;
const child = spawn(process.execPath, [cli, ...args], {
  cwd: root,
  env: { ...process.env, FORCE_COLOR: '1', COLUMNS: String(cols) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const onData = (d) => {
  const now = base + Number(process.hrtime.bigint() - started) / 1e9;
  events.push([Number(now.toFixed(3)), 'o', d.toString('utf8').replace(/\r?\n/g, '\r\n')]);
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('close', (code) => {
  const end = base + Number(process.hrtime.bigint() - started) / 1e9;
  events.push([Number((end + 0.3).toFixed(3)), 'o', '\u001b[32m$\u001b[0m ']);
  const header = { version: 2, width: cols, height: rows, title: shown, env: { TERM: 'xterm-256color' } };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n');
  console.error(`recorded ${events.length} events, ${end.toFixed(1)}s, exit code ${code} -> ${out}`);
  process.exit(code === 0 ? 0 : 1);
});
