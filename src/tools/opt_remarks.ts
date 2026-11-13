import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { compileTo, FlagsSchema, materialize, SourceSchema, TimeoutSchema } from '../core/build.js';
import { defineTool } from '../core/context.js';
import { CeaError } from '../core/errors.js';
import { normalizeNewlines, preview } from '../core/util.js';

export interface Remark {
  kind: 'passed' | 'missed' | 'analysis';
  pass: string;
  name: string;
  function: string;
  line: number | null;
  column: number | null;
  message: string;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** Parse LLVM's optimisation-record YAML (-fsave-optimization-record). Purpose-built, no YAML dependency. */
export function parseLlvmRemarks(yaml: string): Remark[] {
  const out: Remark[] = [];
  for (const doc of normalizeNewlines(yaml).split(/^--- /m)) {
    const head = /^!(Passed|Missed|Analysis)\b/.exec(doc);
    if (!head) continue;
    const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(doc)?.[1];
    const loc = /^DebugLoc:\s*\{[^}]*Line:\s*(\d+),\s*Column:\s*(\d+)/m.exec(doc);
    const argsIdx = doc.indexOf('\nArgs:');
    let message = '';
    if (argsIdx >= 0) {
      for (const line of doc.slice(argsIdx + 6).split('\n')) {
        const m = /^\s+- (\w+):\s*(.*)$/.exec(line);
        if (m && m[1] !== 'DebugLoc') message += unquote(m[2]!);
      }
    }
    out.push({
      kind: head[1]!.toLowerCase() as Remark['kind'],
      pass: unquote(field('Pass') ?? ''),
      name: unquote(field('Name') ?? ''),
      function: unquote(field('Function') ?? ''),
      line: loc ? Number(loc[1]) : null,
      column: loc ? Number(loc[2]) : null,
      message: message.trim(),
    });
  }
  return out;
}

/** Parse GCC -fopt-info output: `file:line:col: optimized|missed|note: message`. */
export function parseGccOptInfo(text: string): Remark[] {
  const out: Remark[] = [];
  for (const line of normalizeNewlines(text).split('\n')) {
    const m = /^(.+?):(\d+):(\d+): (optimized|missed|note): (.*)$/.exec(line);
    if (!m) continue;
    const message = m[5]!;
    const pass = /vectoriz|\bSLP\b|\bvect/i.test(message) ? 'vect' : /inlin/i.test(message) ? 'inline' : /loop/i.test(message) ? 'loop' : 'other';
    out.push({ kind: m[4] === 'optimized' ? 'passed' : m[4] === 'missed' ? 'missed' : 'analysis', pass, name: '', function: '', line: Number(m[2]), column: Number(m[3]), message });
  }
  return out;
}

const LOOP_PASS = /loop|licm|vectoriz|unroll|slp|vect/i;

export const optRemarks = defineTool({
  name: 'opt_remarks',
  family: 'performance',
  title: 'Optimisation remarks',
  description:
    'Collect optimisation remarks: what the optimiser did and, more usefully, what it declined to do and why (-fsave-optimization-record for clang, -fopt-info-all for GCC). ' +
    'Remarks are grouped by function and by source line of the loop, with duplicates counted.',
  input: z.strictObject({
    source: SourceSchema,
    compiler: z.string().min(1).default('clang'),
    flags: FlagsSchema.default(['-O2']),
    function: z.string().max(200).optional().describe('Only remarks in this function (clang only; GCC remarks carry no function name).'),
    passes: z.array(z.string().max(100)).max(30).optional().describe('Only remarks whose pass name contains one of these, e.g. ["loop-vectorize","inline"].'),
    kinds: z.array(z.enum(['passed', 'missed', 'analysis'])).min(1).default(['missed', 'analysis', 'passed']),
    max_remarks: z.number().int().min(1).max(500).default(60).describe('Remarks inlined in the result; the rest stay in the view.'),
    timeout_s: TimeoutSchema.default(120),
  }),
  async run(input, ev) {
    const compiler = await ev.compiler(input.compiler);
    const source = materialize(ev, input.source);
    let remarks: Remark[];
    if (compiler.family === 'clang') {
      const rec = path.join(ev.workDir, 'remarks.opt.yaml');
      const r = await compileTo(ev, { compiler, source, flags: [...input.flags, '-fsave-optimization-record', `-foptimization-record-file=${rec}`], kind: 'obj', outBase: 'remarks', purpose: 'compile with -fsave-optimization-record', timeoutMs: input.timeout_s * 1000 });
      if (!r.ok || !fs.existsSync(rec)) return { status: 'ok', summary: 'compilation failed; no remarks', result: { success: false, stderr_preview: preview(r.exec.stderr, 30) } };
      const yaml = fs.readFileSync(rec, 'utf8');
      ev.view('remarks.opt.yaml', yaml, 'raw LLVM optimisation record');
      remarks = parseLlvmRemarks(yaml);
    } else if (compiler.family === 'gcc') {
      const rec = path.join(ev.workDir, 'optinfo.txt');
      const r = await compileTo(ev, { compiler, source, flags: [...input.flags, `-fopt-info-all=${rec}`], kind: 'obj', outBase: 'remarks', purpose: 'compile with -fopt-info-all', timeoutMs: input.timeout_s * 1000 });
      if (!r.ok) return { status: 'ok', summary: 'compilation failed; no remarks', result: { success: false, stderr_preview: preview(r.exec.stderr, 30) } };
      const text = fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8') : '';
      ev.view('optinfo.txt', text, 'raw GCC -fopt-info-all output');
      remarks = parseGccOptInfo(text);
      ev.limit('GCC opt-info lines carry no function name; remarks are grouped by source line only.');
      if (input.function) ev.limit('`function` filter ignored for GCC.');
    } else {
      throw new CeaError('UNSUPPORTED', 'opt_remarks supports clang and gcc', 'For Rust use -C remark=all manually or analyse the emitted IR with clang.');
    }

    const total = remarks.length;
    remarks = remarks.filter((r) => input.kinds.includes(r.kind));
    if (input.function && compiler.family === 'clang') remarks = remarks.filter((r) => r.function === input.function);
    if (input.passes?.length) remarks = remarks.filter((r) => input.passes!.some((p) => r.pass.toLowerCase().includes(p.toLowerCase())));

    // Deduplicate, then group by function and by loop (source line of loop-pass remarks).
    const dedup = new Map<string, Remark & { count: number }>();
    for (const r of remarks) {
      const k = `${r.kind}|${r.pass}|${r.function}|${r.line}|${r.message}`;
      const cur = dedup.get(k);
      if (cur) cur.count++;
      else dedup.set(k, { ...r, count: 1 });
    }
    const list = [...dedup.values()];
    const rank = { missed: 0, analysis: 1, passed: 2 } as const;
    list.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.line ?? 0) - (b.line ?? 0));
    const byFunction: Record<string, { loops: Record<string, unknown[]>; other: unknown[] }> = {};
    for (const r of list.slice(0, input.max_remarks)) {
      const fn = r.function || '(unknown function)';
      const g = (byFunction[fn] ??= { loops: {}, other: [] });
      const item = { kind: r.kind, pass: r.pass, name: r.name, line: r.line, column: r.column, message: r.message, count: r.count };
      if (LOOP_PASS.test(r.pass) && r.line !== null) (g.loops[`line ${r.line}`] ??= []).push(item);
      else g.other.push(item);
    }
    const counts = { missed: list.filter((r) => r.kind === 'missed').length, analysis: list.filter((r) => r.kind === 'analysis').length, passed: list.filter((r) => r.kind === 'passed').length };
    const all = list.map((r) => `${r.kind}\t${r.pass}\t${r.function}\t${r.line ?? ''}:${r.column ?? ''}\t${r.message}${r.count > 1 ? `\t(x${r.count})` : ''}`).join('\n');
    const allView = ev.view('remarks.tsv', all + '\n', 'all selected remarks: kind, pass, function, line:col, message');
    for (const r of list.filter((x) => x.kind !== 'passed').slice(0, 10)) {
      ev.observe(`${r.kind} [${r.pass}] ${r.function || ''}${r.line !== null ? ` line ${r.line}` : ''}: ${r.message}`);
    }
    ev.cover('remarks_total', total);
    ev.cover('remarks_selected', list.length);
    ev.limit('A remark is the optimiser\'s own explanation, not a measurement: a "missed" optimisation may not matter for run time, and a "passed" one may not help. Measure with benchmark.');
    ev.limit('Passes only emit remarks where their authors added them; silence does not mean a transformation happened.');
    return {
      status: 'ok',
      summary: `${list.length} distinct remark(s): ${counts.missed} missed, ${counts.analysis} analysis, ${counts.passed} passed`,
      result: {
        success: true,
        compiler: { path: compiler.path, version: compiler.version, target: compiler.target },
        flags: input.flags,
        counts,
        by_function: byFunction,
        inlined: Math.min(list.length, input.max_remarks),
        all_remarks_view: allView.name,
      },
    };
  },
});
