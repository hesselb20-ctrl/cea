import { z } from 'zod';
import type { ToolDef } from './core/context.js';
import { analyzeThroughput } from './tools/analyze_throughput.js';
import { benchmark } from './tools/benchmark.js';
import { bisectCompilerHistory } from './tools/bisect_compiler_history.js';
import { bisectPasses } from './tools/bisect_passes.js';
import { checkUb } from './tools/check_ub.js';
import { compile } from './tools/compile.js';
import { differentialRun } from './tools/differential_run.js';
import { emitIr } from './tools/emit_ir.js';
import { environmentReport } from './tools/environment_report.js';
import { fuzzCompiler } from './tools/fuzz_compiler.js';
import { exportEvidenceBundle, inspectEvidenceView, listEvidence, recordUnknown, updateUnknown } from './tools/ledger_tools.js';
import { optRemarks } from './tools/opt_remarks.js';
import { passTimeline } from './tools/pass_timeline.js';
import { reduceTestcase } from './tools/reduce_testcase.js';
import { triageMiscompile } from './tools/triage_miscompile.js';
import { validateTransform } from './tools/validate_transform.js';

/** The single list of tools. The MCP server and the CLI are both generated from it. */
export const TOOLS: ToolDef[] = [
  environmentReport,
  compile,
  emitIr,
  passTimeline,
  optRemarks,
  checkUb,
  differentialRun,
  bisectPasses,
  reduceTestcase,
  validateTransform,
  analyzeThroughput,
  benchmark,
  fuzzCompiler,
  bisectCompilerHistory,
  triageMiscompile,
  inspectEvidenceView,
  listEvidence,
  recordUnknown,
  updateUnknown,
  exportEvidenceBundle,
] as unknown as ToolDef[];

export function findTool(name: string): ToolDef | undefined {
  const n = name.replace(/-/g, '_');
  return TOOLS.find((t) => t.name === n);
}

export function jsonSchemaOf(def: ToolDef): Record<string, unknown> {
  const s = z.toJSONSchema(def.input, { io: 'input' }) as Record<string, unknown>;
  delete s['$schema'];
  return s;
}
