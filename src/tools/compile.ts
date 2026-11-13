import fs from 'node:fs';
import { z } from 'zod';
import { compileTo, FlagsSchema, materialize, SourceSchema, TimeoutSchema, type OutputKind } from '../core/build.js';
import { defineTool } from '../core/context.js';
import { CeaError } from '../core/errors.js';
import { preview } from '../core/util.js';

export const compile = defineTool({
  name: 'compile',
  family: 'compile',
  title: 'Compile',
  description:
    'Compile a file or snippet with exact flags and return assembly, LLVM IR, an object file (disassembled) or an executable, plus parsed diagnostics and timing. ' +
    'The full output is stored as a view; the result holds a bounded preview.',
  input: z.strictObject({
    source: SourceSchema,
    compiler: z.string().min(1).default('clang').describe('Compiler name (clang, gcc, rustc, clang-17) or absolute path.'),
    flags: FlagsSchema.default([]),
    output: z.enum(['asm', 'ir', 'object', 'executable']).default('asm'),
    function: z.string().max(200).optional().describe('For asm output: also return only this function\'s assembly.'),
    timeout_s: TimeoutSchema.default(120),
  }),
  async run(input, ev) {
    const compiler = await ev.compiler(input.compiler);
    const source = materialize(ev, input.source);
    if (source.language === 'llvm-ir' && compiler.family !== 'clang') {
      throw new CeaError('UNSUPPORTED', 'LLVM IR input needs clang as the driver', 'Use compiler "clang" for .ll input.');
    }
    const kind: OutputKind = input.output === 'object' ? 'obj' : input.output === 'executable' ? 'exe' : input.output;
    const r = await compileTo(ev, { compiler, source, flags: input.flags, kind, outBase: 'out', purpose: `compile to ${input.output}`, timeoutMs: input.timeout_s * 1000 });

    const errors = r.diagnostics.filter((d) => d.severity === 'error' || d.severity === 'fatal error').length;
    const warnings = r.diagnostics.filter((d) => d.severity === 'warning').length;
    const result: Record<string, unknown> = {
      success: r.ok,
      compiler: { path: compiler.path, version: compiler.version, target: compiler.target },
      flags: input.flags,
      output_kind: input.output,
      exit_code: r.exec.exitCode,
      timed_out: r.exec.timedOut,
      compiler_crashed: r.crashed,
      compile_time_ms: r.exec.durationMs,
      diagnostics: r.diagnostics.slice(0, 50),
      diagnostic_counts: { errors, warnings, total: r.diagnostics.length },
    };
    ev.observe(`${compiler.version} exited with ${r.exec.timedOut ? 'timeout' : r.exec.exitCode} in ${r.exec.durationMs} ms; ${errors} error(s), ${warnings} warning(s)`);
    ev.limit('Compile time is a single wall-clock sample, not a measurement.');

    if (!r.ok) {
      if (r.crashed) ev.observe('The compiler itself crashed (stack dump / internal error text in stderr).');
      result['stderr_preview'] = preview(r.exec.stderr, 30);
      return {
        status: 'ok',
        summary: r.crashed ? 'compiler crashed' : r.exec.timedOut ? 'compilation timed out' : `compilation failed with ${errors} error(s)`,
        result,
      };
    }

    if (kind === 'asm' || kind === 'ir') {
      const text = fs.readFileSync(r.outPath, 'utf8');
      const v = ev.view(kind === 'asm' ? 'output.s' : 'output.ll', text, kind === 'asm' ? 'assembly output' : 'LLVM IR output');
      result['output_view'] = v.name;
      result['output_lines'] = v.lines;
      result['output_preview'] = preview(text, 60);
      if (kind === 'asm' && input.function) {
        const fn = extractAsmFunction(text, input.function);
        if (fn) {
          result['function_view'] = ev.view('function.s', fn, `assembly of ${input.function}`).name;
          result['function_asm'] = preview(fn, 120, 8000);
        } else {
          ev.unknown(`No assembly label for function "${input.function}" was found; it may have been inlined, renamed (C++ mangling) or removed.`);
        }
      }
    } else if (kind === 'obj') {
      result['object_bytes'] = fs.statSync(r.outPath).size;
      if (await ev.ctx.toolbox.has('llvm-objdump')) {
        const objdump = await ev.tool('llvm-objdump');
        const d = await ev.run('disassemble object', objdump.path, ['-d', '--no-show-raw-insn', r.outPath], { keep: 'none' });
        if (d.exitCode === 0) {
          result['output_view'] = ev.view('disassembly.txt', d.stdout, 'llvm-objdump -d of the object file').name;
          result['output_preview'] = preview(d.stdout, 60);
        }
      } else {
        ev.unknown('Object file was not disassembled: llvm-objdump is unavailable.');
      }
    } else {
      result['executable_path'] = r.outPath;
      result['executable_bytes'] = fs.statSync(r.outPath).size;
    }
    return { status: 'ok', summary: `compiled to ${input.output} with ${warnings} warning(s)`, result };
  },
});

/** Slice one function out of compiler-generated assembly (ELF, Mach-O and COFF label styles). */
export function extractAsmFunction(asm: string, name: string): string | null {
  const lines = asm.replace(/\r\n/g, '\n').split('\n');
  const labels = [`${name}:`, `_${name}:`, `"${name}":`];
  const start = lines.findIndex((l) => labels.some((lab) => l.startsWith(lab)));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*\.(cfi_endproc|seh_endproc)\b/.test(l) || /^\s*\.size\s/.test(l) || /^\s*\.def\s/.test(l) || /^\s*\.globl\s/.test(l) || /^\s*\.section\s/.test(l)) {
      end = /endproc/.test(l) ? i + 1 : i;
      break;
    }
  }
  return lines.slice(start, end).join('\n') + '\n';
}
