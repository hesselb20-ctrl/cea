import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FileRef } from './types.js';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function fileRef(p: string): FileRef {
  const buf = fs.readFileSync(p);
  return { path: path.resolve(p), sha256: sha256(buf), bytes: buf.length };
}

export function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return s.endsWith('\n') ? n : n + 1;
}

/** Bounded preview of a long text: head lines, with a note of how much was cut. */
export function preview(text: string, maxLines = 40, maxChars = 4000): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let out = lines.slice(0, maxLines).join('\n');
  let cut = lines.length > maxLines;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    cut = true;
  }
  return cut ? `${out}\n... [truncated; ${lines.length} lines in the full view]` : out;
}

export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

export function exeName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export function round(x: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
