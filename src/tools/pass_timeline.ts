import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { checkFlags, compileTo, driverFor, FlagsSchema, materialize, SourceSchema, TimeoutSchema } from '../core/build.js';
import { defineTool, type EvidenceBuilder } from '../core/context.js';
import { unifiedDiff } from '../core/diff.js';
import { CeaError } from '../core/errors.js';
import { normalizeNewlines, preview, safeName } from '../core/util.js';

export interface Snapshot {
  pass: string;
  unit: string;
  body: string;
}

export interface ParsedDump {
  initial: string | null;
  snapshots: Snapshot[];
  noop: number;
  filtered: number;
}

/** Parse the stderr of `-print-changed` into the starting IR and one snapshot per changing pass. */
export function parsePrintChanged(stderr: string): ParsedDump {
  const lines = normalizeNewlines(stderr).split('\n');
  const out: ParsedDump = { initial: null, snapshots: [], noop: 0, filtered: 0 };
  let current: { kind: 'initial' } | { kind: 'snap'; pass: string; unit: string } | null = null;
  let body: string[] = [];
  const flush = () => {
    if (!current) return;
    const text = body.join('\n');
    if (current.kind === 'initial') out.initial = text;
    else out.snapshots.push({ pass: current.pass, unit: current.unit, body: text });
    current = null;
    body = [];
  };
  for (const line of lines) {
    const h = /^\*\*\* IR (?:Dump|Pass) (.*) \*\*\*$/.exec(line);
    if (!h) {
      if (current) body.push(line);
      continue;
    }
    flush();
    const head = h[1]!;
    if (head === 'At Start') {
      current = { kind: 'initial' };
    } else if (head.endsWith('omitted because no change')) {
      out.noop++;
    } else if (head.endsWith('filtered out')) {
      out.filtered++;
    } else if (head.endsWith('ignored')) {
      /* pass managers and adaptors: not real passes */
    } else {
      const m = /^After (.+?) on (.+?)(?: \(invalidated\))?$/.exec(head);
      if (m) current = { kind: 'snap', pass: m[1]!, unit: m[2]! };
    }
  }
  flush();
  return out;
}

/** Extract one function definition from textual LLVM IR. */
export function extractIrFunction(ir: string, name: string): string | null {
  const lines = normalizeNewlines(ir).split('\n');
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^define\\b[^@]*@"?${esc}"?\\(`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end < 0) return null;
  return lines.slice(start, end + 1).join('\n');
}

export interface TimelineStep {
  index: number;
  pass: string;
  unit: string;
  added: number;
  removed: number;
  diff_view: string | null;
  ir_view: string | null;
  note?: string;
}

function gccFunctionSection(dump: string, fn: string): string | null {
  const parts = normalizeNewlines(dump).split(/^(?=;; Function )/m);
  const esc = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hit = parts.find((p) => new RegExp(`^;; Function ${esc} \\(`).test(p));
  if (!hit) return null;
  // Drop the header line: it carries pass-specific counters that would show up as fake diffs.
  return hit.split('\n').slice(1).join('\n').trim();
}

function recordSteps(ev: EvidenceBuilder, initial: string | null, states: { pass: string; unit: string; text: string | null }[], suffix: string): { steps: TimelineStep[]; unchanged: number; all: string } {
  const steps: TimelineStep[] = [];
  let prev = initial;
  let unchanged = 0;
  const combined: string[] = [];
  for (const s of states) {
    if (s.text === null) {
      if (prev !== null) {
        steps.push({ index: steps.length + 1, pass: s.pass, unit: s.unit, added: 0, removed: 0, diff_view: null, ir_view: null, note: 'function no longer present in this dump (deleted, inlined away, or not printed for this unit)' });
      }
      continue;
    }
    if (prev !== null && s.text === prev) {
      unchanged++;
      continue;
    }
    const d = unifiedDiff(prev ?? '', s.text);
    const n = String(steps.length + 1).padStart(3, '0');
    const irView = ev.view(`step-${n}-${safeName(s.pass)}${suffix}`, s.text + '\n', `function after ${s.pass}`);
    const diffView = ev.view(`step-${n}-${safeName(s.pass)}.diff`, d.text + '\n', `diff introduced by ${s.pass}`);
    steps.push({ index: steps.length + 1, pass: s.pass, unit: s.unit, added: d.added, removed: d.removed, diff_view: diffView.name, ir_view: irView.name });
    combined.push(`=== step ${steps.length}: ${s.pass} on ${s.unit} (+${d.added} -${d.removed}) ===\n${d.text}\n`);
    prev = s.text;
  }
  return { steps, unchanged, all: combined.join('\n') };
}

export const passTimeline = defineTool({
  name: 'pass_timeline',
  family: 'compile',
  title: 'Pass timeline',
  description:
    'Show what each optimisation pass did to one function, as a list of diffs with no-op passes skipped. ' +
    'LLVM: -print-changed with -filter-print-funcs (or an explicit opt pipeline via `passes`); GCC: -fdump-tree-all. ' +
    'Each step is stored as a view (IR after the pass, and the diff); the result inlines the first page.',
  input: z.strictObject({
    source: SourceSchema,
    function: z.string().min(1).max(200).describe('Function to follow (IR name without @; mangled name for C++).'),
    compiler: z.string().min(1).default('clang'),
    flags: FlagsSchema.default(['-O2']).describe('Flags that select the pipeline, e.g. ["-O2"].'),
    passes: z.string().max(2000).optional().describe('LLVM only: run this opt pipeline (e.g. "instcombine,simplifycfg") instead of the driver pipeline. Needs opt.'),
    only_passes: z.array(z.string().max(100)).max(50).optional().describe('Keep only steps whose pass name contains one of these substrings.'),
    offset: z.number().int().min(0).default(0).describe('First step to inline.'),
    limit: z.number().int().min(1).max(50).default(8).describe('Number of step diffs to inline.'),
    timeout_s: TimeoutSchema.default(180),
  }),
  async run(input, ev, ctx) {
    const base = await ev.compiler(input.compiler);
    const source = materialize(ev, input.source);
    const compiler = await driverFor(ev, base, source.language);
    checkFlags(input.flags, ctx.config.allowUnsafeFlags);
    const timeoutMs = input.timeout_s * 1000;
    let steps: TimelineStep[];
    let unchanged = 0;
    let noop = 0;
    let all = '';
    let suffix = '.ll';

    if (compiler.family === 'gcc') {
      if (input.passes) throw new CeaError('UNSUPPORTED', '`passes` is LLVM-only', 'Remove `passes` for GCC; the pipeline is selected by flags.');
      suffix = '.gimple';
      const r = await compileTo(ev, { compiler, source, flags: [...input.flags, '-fdump-tree-all'], kind: 'obj', outBase: 'timeline', purpose: 'compile with -fdump-tree-all', timeoutMs });
      if (!r.ok) return { status: 'ok', summary: 'compilation failed; no timeline', result: { success: false, stderr_preview: preview(r.exec.stderr, 30) } };
      const dumps = fs.readdirSync(ev.workDir)
        .map((f) => ({ f, m: /\.(\d{3})t\.([\w-]+)$/.exec(f) }))
        .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
        .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
      const states = dumps.map((d) => ({ pass: d.m[2]!, unit: input.function, text: gccFunctionSection(fs.readFileSync(path.join(ev.workDir, d.f), 'utf8'), input.function) }));
      const present = states.filter((s) => s.text !== null);
      if (present.length === 0) {
        throw new CeaError('NOT_FOUND', `function "${input.function}" does not appear in any GCC tree dump`, 'Check the name (C++ needs the source-level name here) and that the function is not removed before gimplification.');
      }
      const first = present[0]!;
      const rec = recordSteps(ev, first.text, states.slice(states.indexOf(first) + 1), suffix);
      ev.view('step-000-start.gimple', first.text + '\n', `function at the first dump (${first.pass})`);
      steps = rec.steps;
      unchanged = rec.unchanged;
      all = rec.all;
      ev.limit('GCC timeline covers tree (GIMPLE) passes only; RTL passes are not included.');
    } else if (compiler.family === 'clang') {
      let stderr: string;
      const dumpFlags = ['-print-changed', `-filter-print-funcs=${input.function}`, '-print-module-scope'];
      if (input.passes) {
        const opt = await ev.tool('opt');
        let irFile = source.file;
        if (source.language !== 'llvm-ir') {
          const fe = await compileTo(ev, { compiler, source, flags: [...input.flags, '-Xclang', '-disable-llvm-passes'], kind: 'ir', outBase: 'frontend', purpose: 'emit frontend IR for opt', timeoutMs });
          if (!fe.ok) return { status: 'ok', summary: 'compilation failed; no timeline', result: { success: false, stderr_preview: preview(fe.exec.stderr, 30) } };
          irFile = fe.outPath;
        }
        const r = await ev.run('opt with -print-changed', opt.path, [`-passes=${input.passes}`, ...dumpFlags, '-S', irFile, '-o', path.join(ev.workDir, 'after.ll')], { timeoutMs, maxOutputBytes: 256 * 1024 * 1024, keep: 'none' });
        if (r.exitCode !== 0) return { status: 'ok', summary: 'opt failed; no timeline', result: { success: false, stderr_preview: preview(r.stderr, 30) } };
        stderr = r.stderr;
      } else {
        const flags = [...input.flags, ...dumpFlags.flatMap((f) => ['-mllvm', f])];
        const r = await compileTo(ev, { compiler, source, flags, kind: 'ir', outBase: 'after', purpose: 'compile with -print-changed', timeoutMs, keep: 'none', maxOutputBytes: 256 * 1024 * 1024 });
        if (!r.ok) return { status: 'ok', summary: 'compilation failed; no timeline', result: { success: false, stderr_preview: preview(r.exec.stderr, 30) } };
        stderr = r.exec.stderr;
        if (r.exec.truncated) ev.limit('The pass dump exceeded the output cap and was truncated; later passes are missing.');
      }
      ev.view('print-changed.raw.txt', stderr, 'raw -print-changed output');
      const parsed = parsePrintChanged(stderr);
      noop = parsed.noop;
      const initial = parsed.initial ? extractIrFunction(parsed.initial, input.function) : null;
      if (initial === null && !parsed.snapshots.some((s) => extractIrFunction(s.body, input.function))) {
        throw new CeaError('NOT_FOUND', `function "${input.function}" was not found in the IR`, 'Check the name: use the IR symbol (mangled for C++), and note that static functions may be inlined away before any dump.');
      }
      if (initial) ev.view('step-000-start.ll', initial + '\n', 'function before the first pass');
      const states = parsed.snapshots.map((s) => ({ pass: s.pass, unit: s.unit, text: extractIrFunction(s.body, input.function) }));
      const rec = recordSteps(ev, initial, states, suffix);
      steps = rec.steps;
      unchanged = rec.unchanged;
      all = rec.all;
      ev.limit('Only passes of the new pass manager IR pipeline are shown; instruction selection and machine passes are not.');
    } else {
      throw new CeaError('UNSUPPORTED', 'pass_timeline supports clang and gcc', 'For Rust, emit LLVM IR with emit_ir and run pass_timeline on the .ll with `passes`.');
    }

    if (input.only_passes && input.only_passes.length > 0) {
      steps = steps.filter((s) => input.only_passes!.some((p) => s.pass.toLowerCase().includes(p.toLowerCase())));
    }
    const allView = ev.view('timeline.diff', all, 'all step diffs in order');
    const page = steps.slice(input.offset, input.offset + input.limit).map((s) => ({
      ...s,
      diff: s.diff_view ? preview(ctx.ledger.readView(ev.id, s.diff_view), 60, 5000) : null,
    }));
    ev.observe(`${steps.length} pass run(s) changed ${input.function}; ${noop} pass run(s) reported no change; ${unchanged} changed the module but not this function`);
    ev.cover('steps_total', steps.length);
    ev.cover('steps_inlined', { offset: input.offset, count: page.length });
    ev.limit('A diff shows what a pass changed, not whether the change is correct; use validate_transform on the before/after views for that.');
    return {
      status: 'ok',
      summary: `${steps.length} changing pass run(s) on ${input.function}${steps.length ? `: ${[...new Set(steps.map((s) => s.pass))].slice(0, 8).join(', ')}` : ''}`,
      result: {
        success: true,
        function: input.function,
        compiler: { path: compiler.path, version: compiler.version, target: compiler.target },
        steps_total: steps.length,
        noop_passes_skipped: noop,
        index: steps.map((s) => ({ index: s.index, pass: s.pass, added: s.added, removed: s.removed, diff_view: s.diff_view, ir_view: s.ir_view })),
        page: { offset: input.offset, limit: input.limit, steps: page },
        all_diffs_view: allView.name,
        next_offset: input.offset + input.limit < steps.length ? input.offset + input.limit : null,
      },
    };
  },
});
