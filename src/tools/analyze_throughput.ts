import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { compileTo, FlagsSchema, materialize, SourceSchema, TimeoutSchema } from '../core/build.js';
import { defineTool } from '../core/context.js';
import { CeaError } from '../core/errors.js';
import { normalizeNewlines, preview } from '../core/util.js';
import { extractAsmFunction } from './compile.js';

export interface McaSummary {
  iterations: number | null;
  instructions: number | null;
  total_cycles: number | null;
  total_uops: number | null;
  dispatch_width: number | null;
  uops_per_cycle: number | null;
  ipc: number | null;
  block_rthroughput: number | null;
}

export function parseMcaSummary(text: string): McaSummary {
  const num = (label: string) => {
    const m = new RegExp(`^${label}:\\s+([\\d.]+)`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  return {
    iterations: num('Iterations'),
    instructions: num('Instructions'),
    total_cycles: num('Total Cycles'),
    total_uops: num('Total uOps'),
    dispatch_width: num('Dispatch Width'),
    uops_per_cycle: num('uOps Per Cycle'),
    ipc: num('IPC'),
    block_rthroughput: num('Block RThroughput'),
  };
}

/** Keep labels and instructions; drop assembler directives that llvm-mca does not need. */
export function instructionsOnly(asm: string): string {
  return normalizeNewlines(asm).split('\n').filter((l) => {
    const t = l.trim();
    if (t.length === 0) return false;
    if (/^#\s*LLVM-MCA-(BEGIN|END)/.test(t)) return true;
    if (t.startsWith('#') || t.startsWith('//')) return false;
    if (t.startsWith('.') && !/^\.L?[\w.$]+:/.test(t)) return false;
    return true;
  }).join('\n') + '\n';
}

export const MCA_LIMITATION =
  'llvm-mca is a static model of the out-of-order core only. It ignores caches and memory latency beyond L1 hits, branch misprediction, the frontend (decoding, uop cache), page faults and frequency effects, and it assumes the block runs repeatedly in a straight line. Its cycle counts are not run-time measurements.';

export const analyzeThroughput = defineTool({
  name: 'analyze_throughput',
  family: 'performance',
  title: 'Analyze throughput (llvm-mca)',
  description:
    'Run llvm-mca on a function or marked loop for a named CPU and return IPC, uops per cycle, block reciprocal throughput and the bottleneck report. ' +
    'Static model only: it ignores caches and branch mispredictions. Use it to compare instruction sequences, then confirm with benchmark.',
  input: z.strictObject({
    source: SourceSchema.optional().describe('C/C++ source to compile to assembly first.'),
    asm: z.string().max(1_000_000).optional().describe('Alternative: assembly text (AT&T syntax for x86) to analyse directly.'),
    function: z.string().max(200).optional().describe('Function to analyse. Without it the whole file is analysed, or the region between "# LLVM-MCA-BEGIN" / "# LLVM-MCA-END" comments if present.'),
    cpu: z.string().min(1).max(60).regex(/^[A-Za-z0-9._+-]+$/).describe('CPU model name for -mcpu, e.g. skylake, znver4, cortex-a76. Name it explicitly: results differ per CPU.'),
    triple: z.string().max(100).regex(/^[A-Za-z0-9._-]+$/).optional().describe('Target triple; default: the compiler\'s target.'),
    compiler: z.string().min(1).default('clang'),
    flags: FlagsSchema.default(['-O2']),
    iterations: z.number().int().min(1).max(100_000).default(100),
    timeout_s: TimeoutSchema.default(120),
  }),
  async run(input, ev) {
    ev.limit(MCA_LIMITATION);
    if ((input.source === undefined) === (input.asm === undefined)) {
      throw new CeaError('INVALID_INPUT', 'pass exactly one of source or asm', 'Use {"source": {...}} to compile first, or {"asm": "..."}.');
    }
    const mca = await ev.tool('llvm-mca');
    let asm: string;
    let triple = input.triple ?? null;
    if (input.source) {
      const compiler = await ev.compiler(input.compiler);
      if (compiler.family !== 'clang' && compiler.family !== 'gcc') throw new CeaError('UNSUPPORTED', 'analyze_throughput compiles with clang or gcc', 'Pass assembly text via `asm` for other compilers.');
      const source = materialize(ev, input.source);
      const r = await compileTo(ev, { compiler, source, flags: input.flags, kind: 'asm', outBase: 'mca', purpose: 'compile to assembly', timeoutMs: input.timeout_s * 1000 });
      if (!r.ok) return { status: 'ok', summary: 'compilation failed; nothing to analyse', result: { success: false, stderr_preview: preview(r.exec.stderr, 30) } };
      asm = fs.readFileSync(r.outPath, 'utf8');
      triple ??= compiler.target;
      if (!input.flags.some((f) => /^-m(arch|cpu|tune)=/.test(f))) {
        ev.limit(`The code was compiled without -march/-mtune for ${input.cpu}; the compiler chose instructions for its default CPU while llvm-mca models ${input.cpu}.`);
      }
    } else {
      asm = input.asm!;
    }
    const hasMarkers = /LLVM-MCA-BEGIN/.test(asm);
    let region: string;
    let regionDesc: string;
    if (input.function) {
      const fn = extractAsmFunction(asm, input.function);
      if (!fn) throw new CeaError('NOT_FOUND', `no assembly label for function "${input.function}"`, 'Check the name (mangled for C++); the function may have been inlined. Use compile with output "asm" to look.');
      region = instructionsOnly(fn);
      regionDesc = `function ${input.function}`;
    } else if (hasMarkers) {
      region = asm;
      regionDesc = 'LLVM-MCA-BEGIN/END region(s)';
    } else {
      region = instructionsOnly(asm);
      regionDesc = 'whole file';
      ev.limit('No function or region was selected: the whole file was modelled as one block, which rarely corresponds to a real hot loop.');
    }
    const file = path.join(ev.workDir, 'region.s');
    fs.writeFileSync(file, region, 'utf8');
    ev.view('region.s', region, `assembly analysed (${regionDesc})`);
    const args = [`-mcpu=${input.cpu}`, `-iterations=${input.iterations}`, '-bottleneck-analysis', ...(triple ? [`-mtriple=${triple}`] : []), file];
    const r = await ev.run('llvm-mca', mca.path, args, { timeoutMs: input.timeout_s * 1000 });
    if (r.exitCode !== 0) {
      throw new CeaError('TOOL_FAILED', `llvm-mca failed: ${preview(r.stderr, 6)}`, 'Check that the CPU name is valid for the target (llc -mcpu=help) and that the assembly parses for this triple.');
    }
    const s = parseMcaSummary(r.stdout);
    const insns = normalizeNewlines(region).split('\n').filter((l) => l.trim() && !/:\s*$/.test(l.trim()) && !l.trim().startsWith('#')).length;
    const bIdx = r.stdout.indexOf('Cycles with backend pressure increase');
    const bottleneck = bIdx >= 0 ? preview(r.stdout.slice(bIdx).split(/\n\s*\n\s*\n/)[0]!, 25, 2000) : null;
    if (/No resource or data dependency bottlenecks discovered/.test(r.stdout)) ev.observe('llvm-mca reports no resource or data-dependency bottleneck.');
    ev.observe(`llvm-mca (${input.cpu}): ${s.instructions} instructions in ${s.total_cycles} cycles over ${s.iterations} iterations; IPC ${s.ipc}; block reciprocal throughput ${s.block_rthroughput} cycles`);
    ev.infer(`If this block were a hot loop body with no cache misses or mispredictions, one iteration would cost about ${s.block_rthroughput} cycles on ${input.cpu}.`);
    ev.unknown('Actual run time on real hardware: measure with benchmark.');
    ev.setTarget(triple);
    ev.cover('region', regionDesc);
    ev.cover('cpu', input.cpu);
    return {
      status: 'ok',
      summary: `${regionDesc} on ${input.cpu}: IPC ${s.ipc}, RThroughput ${s.block_rthroughput} (static model; ignores caches and branch misses)`,
      result: { success: true, cpu: input.cpu, triple, region: regionDesc, instructions_in_region: insns, summary: s, bottleneck, report_preview: preview(r.stdout, 40), limitation: MCA_LIMITATION },
    };
  },
});
