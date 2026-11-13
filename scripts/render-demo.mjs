// Render an asciicast v2 recording to a GIF with ffmpeg (no other dependencies).
//
//   node scripts/render-demo.mjs docs/demo/triage.cast docs/demo/triage.gif [--font <regular.ttf>] [--bold <bold.ttf>]
//
// It is a small terminal emulator: it understands newlines, carriage returns and the SGR
// colour codes cea prints. Each run of same-coloured text becomes one drawtext filter that
// switches on at the moment the text was recorded.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : def;
};
const fontDefault = process.platform === 'win32' ? 'C:/Windows/Fonts/consola.ttf' : process.platform === 'darwin' ? '/System/Library/Fonts/Menlo.ttc' : '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
const boldDefault = process.platform === 'win32' ? 'C:/Windows/Fonts/consolab.ttf' : fontDefault.replace('DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf');
const font = opt('--font', fontDefault);
const bold = opt('--bold', boldDefault);
const hold = Number(opt('--hold', '5'));
// Advance width of one character as a fraction of the font size (Consolas 0.55, DejaVu Sans Mono 0.602).
const advance = Number(opt('--advance', process.platform === 'win32' ? '0.55' : '0.602'));
const [castPath, gifPath] = argv;
if (!castPath || !gifPath) {
  console.error('usage: node scripts/render-demo.mjs <in.cast> <out.gif> [--font f.ttf] [--bold b.ttf] [--hold seconds] [--advance fraction]');
  process.exit(2);
}

const lines = fs.readFileSync(castPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const header = lines[0];
const events = lines.slice(1).filter((e) => e[1] === 'o');

const COLORS = { 30: '0x6e7681', 31: '0xff7b72', 32: '0x7ee787', 33: '0xe3b341', 34: '0x79c0ff', 35: '0xd2a8ff', 36: '0x56d4dd', 37: '0xe6edf3' };
const FG = '0xe6edf3';
const DIM = '0x8b949e';
const BG = '0x0d1117';

// Emulate: produce cells {row, col, ch, time, color, bold}.
const cells = [];
let row = 0;
let col = 0;
let style = { color: FG, bold: false, dim: false };
for (const [time, , data] of events) {
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\u001b' && data[i + 1] === '[') {
      const end = data.indexOf('m', i);
      for (const code of data.slice(i + 2, end).split(';').map(Number)) {
        if (code === 0) style = { color: FG, bold: false, dim: false };
        else if (code === 1) style = { ...style, bold: true };
        else if (code === 2) style = { ...style, dim: true };
        else if (COLORS[code]) style = { ...style, color: COLORS[code] };
      }
      i = end;
    } else if (ch === '\n') {
      row++;
    } else if (ch === '\r') {
      col = 0;
    } else {
      cells.push({ row, col, ch, time, color: style.dim ? DIM : style.color, bold: style.bold });
      col++;
    }
  }
}

// Group adjacent cells with the same row, style and time into runs.
const runs = [];
for (const c of cells) {
  const last = runs[runs.length - 1];
  if (last && last.row === c.row && last.color === c.color && last.bold === c.bold && Math.abs(last.time - c.time) < 1e-6 && last.col + last.text.length === c.col) last.text += c.ch;
  else runs.push({ row: c.row, col: c.col, text: c.ch, time: c.time, color: c.color, bold: c.bold });
}

const fontSize = 16;
const cw = fontSize * advance;
const lh = 20;
const pad = 16;
const totalRows = Math.max(...cells.map((c) => c.row)) + 2;
const width = Math.ceil((pad * 2 + header.width * cw) / 2) * 2;
const height = pad * 2 + totalRows * lh;
const duration = events[events.length - 1][0] + hold;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cea-demo-'));
fs.copyFileSync(font, path.join(tmp, 'r.ttf'));
fs.copyFileSync(fs.existsSync(bold) ? bold : font, path.join(tmp, 'b.ttf'));
const filters = [];
runs.forEach((r, i) => {
  if (r.text.trim() === '') return;
  // Text goes through files, so nothing has to be escaped for the filter graph.
  fs.writeFileSync(path.join(tmp, `t${i}.txt`), r.text);
  filters.push(`drawtext=fontfile=${r.bold ? 'b' : 'r'}.ttf:textfile=t${i}.txt:fontsize=${fontSize}:fontcolor=${r.color}:x=${(pad + r.col * cw).toFixed(2)}:y=${pad + r.row * lh}:y_align=font:enable='gte(t,${r.time.toFixed(3)})'`);
});
const graph = `color=c=${BG}:s=${width}x${height}:r=10:d=${duration.toFixed(2)},${filters.join(',')},split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=none`;
fs.writeFileSync(path.join(tmp, 'graph.txt'), graph);
const out = path.resolve(gifPath);
fs.mkdirSync(path.dirname(out), { recursive: true });
const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-/filter_complex', 'graph.txt', '-loop', '0', out], { cwd: tmp, encoding: 'utf8' });
if (r.status !== 0) {
  console.error(r.stderr || r.error);
  process.exit(1);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.error(`rendered ${runs.length} text runs, ${duration.toFixed(1)}s, ${width}x${height} -> ${out} (${fs.statSync(out).size} bytes)`);
