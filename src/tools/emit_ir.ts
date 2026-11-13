import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { checkFlags, compileTo, driverFor, FlagsSchema, materialize, OptLevelSchema, optFlags, parseDiagnostics, SourceSchema, TimeoutSchema } from '../core/build.js';
import { defineTool } from '../core/context.js';
import { CeaError } from '../core/errors.js';
import { preview } from '../core/util.js';

export const emitIr = defineTool({
  name: 'emit_ir',
  family: 'compile',
  title: 'Emit frontend IR',
  description:
    'Emit the IR the frontend produced, before any optimisation pass ran: clang with -Xclang -disable-llvm-passes, rustc --emit=llvm-ir,mir with no passes, GCC -fdump-tree-gimple. ' +
    'Use it to separate "the frontend generated this" from "a pass did this".',
  input: z.strictObject({
    source: SourceSchema,
    compiler: z.string().min(1).default('clang'),
    flags: FlagsSchema.default([]),
    opt_level: OptLevelSchema.default('O1').describe('Level the frontend is told about. At O0 clang marks every function optnone, which hides what later passes would see; O1 or higher is usually what you want.'),
    timeout_s: TimeoutSchema.default(120),
  }),
  async run(input, ev) {
    const base = await ev.compiler(input.compiler);
    const source = materialize(ev, input.source);
    const compiler = await driverFor(ev, base, source.language);
    checkFlags(input.flags, ev.ctx.config.allowUnsafeFlags);
    const result: Record<string, unknown> = { compiler: { path: compiler.path, version: compiler.version, target: compiler.target }, opt_level: input.opt_level };
    const timeoutMs = input.timeout_s * 1000;

    if (compiler.family === 'clang') {
      const flags = [...optFlags('clang', input.opt_level), ...input.flags, '-Xclang', '-disable-llvm-passes'];
      const r = await compileTo(ev, { compiler, source, flags, kind: 'ir', outBase: 'frontend', purpose: 'emit unoptimised LLVM IR', timeoutMs });
      result['diagnostics'] = r.diagnostics.slice(0, 50);
      if (!r.ok) {
        result['stderr_preview'] = preview(r.exec.stderr, 30);
        return { status: 'ok', summary: 'frontend did not produce IR (compilation failed)', result: { ...result, success: false } };
      }
      const text = fs.readFileSync(r.outPath, 'utf8');
      const v = ev.view('frontend.ll', text, 'LLVM IR as emitted by the clang frontend, no passes run');
      const functions = [...text.matchAll(/^define [^@]*@"?([^"(\s]+)"?\(/gm)].map((m) => m[1]!);
      ev.observe(`clang emitted ${v.lines} lines of IR defining ${functions.length} function(s) with no LLVM passes run`);
      if (input.opt_level === 'O0') ev.limit('At O0 clang adds optnone/noinline to every function; this IR is not what the -O2 pipeline starts from.');
      ev.limit('Frontend IR depends on the optimisation level passed to the frontend (lifetime markers, TBAA metadata, attributes).');
      return { status: 'ok', summary: `frontend LLVM IR: ${v.lines} lines, ${functions.length} function(s)`, result: { ...result, success: true, ir_view: v.name, functions, ir_preview: preview(text, 60) } };
    }

    if (compiler.family === 'rustc') {
      const outDir = ev.workDir;
      const argv = [source.file, '--crate-type=lib', '--emit=llvm-ir,mir', ...optFlags('rustc', input.opt_level), '-C', 'no-prepopulate-passes', '--out-dir', outDir, '--crate-name', 'input', ...input.flags];
      const r = await ev.run('emit rustc MIR and unoptimised LLVM IR', compiler.path, argv, { timeoutMs, keep: 'stderr' });
      result['diagnostics'] = parseDiagnostics(r.stderr).slice(0, 50);
      const ll = path.join(outDir, 'input.ll');
      const mir = path.join(outDir, 'input.mir');
      if (r.exitCode !== 0 || !fs.existsSync(ll)) {
        result['stderr_preview'] = preview(r.stderr, 30);
        return { status: 'ok', summary: 'rustc did not produce IR (compilation failed)', result: { ...result, success: false } };
      }
      const llText = fs.readFileSync(ll, 'utf8');
      const v = ev.view('frontend.ll', llText, 'LLVM IR from rustc with no LLVM passes prepopulated');
      result['ir_view'] = v.name;
      result['ir_preview'] = preview(llText, 60);
      if (fs.existsSync(mir)) {
        const mirText = fs.readFileSync(mir, 'utf8');
        result['mir_view'] = ev.view('frontend.mir', mirText, 'rustc MIR').name;
        result['mir_preview'] = preview(mirText, 40);
      }
      ev.observe(`rustc emitted ${v.lines} lines of LLVM IR`);
      ev.limit('rustc MIR optimisations still run according to the opt level; "no-prepopulate-passes" only removes LLVM passes.');
      return { status: 'ok', summary: `rustc frontend IR: ${v.lines} lines of LLVM IR plus MIR`, result: { ...result, success: true } };
    }

    if (compiler.family === 'gcc') {
      const flags = [...optFlags('gcc', input.opt_level), ...input.flags, '-fdump-tree-gimple'];
      const r = await compileTo(ev, { compiler, source, flags, kind: 'obj', outBase: 'frontend', purpose: 'emit GIMPLE (frontend IR)', timeoutMs });
      result['diagnostics'] = r.diagnostics.slice(0, 50);
      const dump = fs.readdirSync(ev.workDir).find((f) => /\.\d{3}t\.gimple$/.test(f));
      if (!r.ok || !dump) {
        result['stderr_preview'] = preview(r.exec.stderr, 30);
        return { status: 'ok', summary: 'GCC did not produce a GIMPLE dump', result: { ...result, success: false } };
      }
      const text = fs.readFileSync(path.join(ev.workDir, dump), 'utf8');
      const v = ev.view('frontend.gimple', text, 'GIMPLE after gimplification (-fdump-tree-gimple)');
      ev.observe(`GCC emitted ${v.lines} lines of GIMPLE`);
      ev.limit('GIMPLE is GCC\'s IR, not LLVM IR; validate_transform (Alive2) cannot check it.');
      return { status: 'ok', summary: `GCC GIMPLE dump: ${v.lines} lines`, result: { ...result, success: true, ir_view: v.name, ir_kind: 'gimple', ir_preview: preview(text, 60) } };
    }
    throw new CeaError('UNSUPPORTED', `emit_ir does not know the compiler family of ${compiler.path}`, 'Use clang, gcc or rustc.');
  },
});
