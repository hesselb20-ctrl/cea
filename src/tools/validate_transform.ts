import path from 'node:path';
import { z } from 'zod';
import { materialize, SourceSchema, TimeoutSchema } from '../core/build.js';
import { defineTool } from '../core/context.js';
import { CeaError } from '../core/errors.js';
import { normalizeNewlines, preview } from '../core/util.js';
import { ALIVE2_CE_URL, ceCompile, REMOTE_ID } from '../providers/compiler_explorer.js';
import { extractIrFunction } from './pass_timeline.js';

export interface AlivePair {
  function: string | null;
  verdict: 'correct' | 'incorrect' | 'unproven';
  error: string | null;
  counterexample: string | null;
}

export interface AliveReport {
  pairs: AlivePair[];
  summary: { correct: number; incorrect: number; failed_to_prove: number; errors: number } | null;
}

/** Parse alive-tv's textual report. */
export function parseAliveOutput(text: string): AliveReport {
  const t = normalizeNewlines(text);
  const pairs: AlivePair[] = [];
  for (const block of t.split(/^-{20,}\s*$/m)) {
    if (!/Transformation (seems to be correct|doesn't verify)|ERROR:/.test(block)) continue;
    const name = /^define\b[^@]*@"?([^"(\s]+)"?\(/m.exec(block)?.[1] ?? null;
    if (/Transformation seems to be correct/.test(block)) {
      pairs.push({ function: name, verdict: 'correct', error: null, counterexample: null });
      continue;
    }
    const err = /^ERROR: (.*)$/m.exec(block)?.[1] ?? null;
    const exIdx = block.indexOf('Example:');
    let example: string | null = null;
    if (exIdx >= 0) {
      const rest = block.slice(exIdx);
      const end = rest.search(/\n\s*\nSummary:|\nSummary:/);
      example = (end >= 0 ? rest.slice(0, end) : rest).trim();
    }
    const unproven = err !== null && /timeout|out of memory|SMT Error|couldn't prove|Unsupported|not supported/i.test(err);
    pairs.push({ function: name, verdict: /doesn't verify/.test(block) && !unproven ? 'incorrect' : 'unproven', error: err, counterexample: example });
  }
  const num = (re: RegExp) => {
    const m = re.exec(t);
    return m ? Number(m[1]) : null;
  };
  const c = num(/(\d+) correct transformations/);
  const i = num(/(\d+) incorrect transformations/);
  const f = num(/(\d+) failed-to-prove transformations/);
  const e = num(/(\d+) Alive2 errors/);
  return { pairs, summary: c === null || i === null ? null : { correct: c, incorrect: i, failed_to_prove: f ?? 0, errors: e ?? 0 } };
}

function stripForCombine(fn: string): string {
  return fn
    .replace(/,? ![A-Za-z_.]+ !\d+/g, '')
    .replace(/ #\d+/g, '')
    .replace(/^(define\b[^@]*)(dso_local |local_unnamed_addr |hidden |internal |private )+/m, '$1');
}

/**
 * Build a single module with @src and @tgt from a before/after pair, for alive-tv's
 * one-file mode (used by the remote provider, which accepts one source text).
 */
export function combineForAlive(before: string, after: string, fn: string): string {
  const a = extractIrFunction(before, fn);
  const b = extractIrFunction(after, fn);
  if (!a || !b) throw new CeaError('NOT_FOUND', `function "${fn}" is not defined in both before and after IR`, 'Pass the IR symbol name that exists in both modules.');
  const esc = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rename = (text: string, to: string) => stripForCombine(text).replace(new RegExp(`@"?${esc}"?\\(`), `@${to}(`);
  const header = new Map<string, string>();
  for (const line of [...normalizeNewlines(before).split('\n'), ...normalizeNewlines(after).split('\n')]) {
    if (/^(target (datalayout|triple) = |%[\w.]+ = type )/.test(line)) header.set(line, line);
    const g = /^(@[\w.$"]+) = /.exec(line);
    if (g && !header.has(g[1]!)) header.set(g[1]!, stripForCombine(line));
    const d = /^declare\b[^@]*(@[\w.$"]+)\(/.exec(line);
    if (d && !header.has(d[1]!)) header.set(d[1]!, stripForCombine(line));
  }
  return [...header.values(), '', rename(a, 'src'), '', rename(b, 'tgt'), ''].join('\n');
}

const UNSOUND_NOTE = [
  'Alive2 is bounded: loops are unrolled a fixed number of times, so a counterexample needing more iterations is missed.',
  'Alive2 checks one function at a time (no interprocedural reasoning) and approximates memory, function calls and some intrinsics; "correct" means no counterexample within those limits.',
];

export const validateTransform = defineTool({
  name: 'validate_transform',
  family: 'correctness',
  title: 'Validate transform (Alive2)',
  description:
    'Check with Alive2 (alive-tv) that the "after" IR refines the "before" IR, and return pass/fail with the counterexample. ' +
    'This is the only tool here that can show a rewrite is wrong for some input rather than just different on one input. ' +
    'Uses a local alive-tv, or the Alive2 project\'s Compiler Explorer instance if the remote provider is explicitly enabled.',
  input: z.strictObject({
    before: SourceSchema.optional().describe('IR before the transformation.'),
    after: SourceSchema.optional().describe('IR after the transformation.'),
    pair: SourceSchema.optional().describe('Alternative: one IR module containing @src and @tgt (alive-tv single-file mode).'),
    function: z.string().max(200).optional().describe('Function to compare when the modules define several. Required for the remote provider with before/after.'),
    provider: z.enum(['auto', 'local', 'remote']).default('auto'),
    smt_timeout_s: TimeoutSchema.max(600).default(60).describe('SMT solver timeout per query.'),
    extra_args: z.array(z.string().max(100).regex(/^--?[A-Za-z0-9][\w=.:,-]*$/, 'must be an option, not a path')).max(10).default([]).describe('Extra alive-tv options, e.g. "--disable-undef-input".'),
  }),
  async run(input, ev, ctx) {
    for (const l of UNSOUND_NOTE) ev.limit(l);
    const hasPair = input.pair !== undefined;
    const valid = hasPair ? !input.before && !input.after : !!input.before && !!input.after;
    if (!valid) {
      throw new CeaError('INVALID_INPUT', 'pass either `pair`, or both `before` and `after`', 'Use {"before": {...}, "after": {...}} or {"pair": {...}} with @src/@tgt functions.');
    }
    const fix = (s: z.infer<typeof SourceSchema>) => ({ ...s, language: s.language ?? (s.code !== undefined ? 'llvm-ir' as const : undefined) });
    const localAvailable = await ctx.toolbox.has('alive-tv');
    const remoteEnabled = ctx.config.remoteProviders.has(REMOTE_ID);
    let provider = input.provider;
    if (provider === 'auto') provider = localAvailable ? 'local' : 'remote';
    if (provider === 'remote' && !remoteEnabled && input.provider === 'auto') {
      // Surface the local provider's remediation, which also explains the remote option.
      await ev.tool('alive-tv');
    }

    let output: string;
    let where: string;
    const smtMs = String(input.smt_timeout_s * 1000);
    if (provider === 'local') {
      const alive = await ev.tool('alive-tv');
      const args: string[] = [];
      if (hasPair) {
        args.push(materialize(ev, fix(input.pair!), 'pair').file);
      } else {
        args.push(materialize(ev, fix(input.before!), 'before').file, materialize(ev, fix(input.after!), 'after').file);
      }
      const r = await ev.run('alive-tv', alive.path, [...args, `--smt-to=${smtMs}`, ...input.extra_args], { timeoutMs: (input.smt_timeout_s * 4 + 60) * 1000 });
      if (r.timedOut) throw new CeaError('TIMEOUT', 'alive-tv timed out', 'Raise smt_timeout_s, or reduce the function first.');
      output = `${r.stdout}\n${r.stderr}`;
      where = `local alive-tv (${alive.version})`;
    } else {
      let text: string;
      if (hasPair) {
        text = materialize(ev, fix(input.pair!), 'pair').text;
      } else {
        const b = materialize(ev, fix(input.before!), 'before').text;
        const a = materialize(ev, fix(input.after!), 'after').text;
        let fn = input.function;
        if (!fn) {
          const names = [...b.matchAll(/^define\b[^@]*@"?([^"(\s]+)"?\(/gm)].map((m) => m[1]!);
          if (names.length !== 1) throw new CeaError('INVALID_INPUT', 'the before module defines several functions; `function` is required for the remote provider', `Pass function: one of ${names.slice(0, 10).join(', ')}.`);
          fn = names[0]!;
        }
        text = combineForAlive(b, a, fn);
        ev.limit('Remote mode sends one combined module: attribute groups and metadata (!tbaa, !range, !dbg, function attributes) were stripped, so facts they carry are not used in the proof.');
      }
      ev.view('alive-input.ll', text, 'module sent to the Alive2 Compiler Explorer instance');
      const url = process.env['CEA_ALIVE2_CE_URL'] ?? ALIVE2_CE_URL;
      const r = await ceCompile(ctx, url, 'alive', text, [`--smt-to=${smtMs}`, ...input.extra_args].join(' '), (input.smt_timeout_s + 60) * 1000);
      output = [r.asm, r.stdout, r.stderr].filter(Boolean).join('\n');
      ev.view('alive-output.txt', output, `alive-tv output from ${r.url}`);
      ev.observe(`IR was sent to ${r.url} (remote provider explicitly enabled).`);
      const ver = /LLVM version \S+/.exec(output)?.[0];
      where = `remote alive-tv at ${new URL(url).host}${ver ? ` (${ver})` : ''}`;
      ev.limit('The remote alive-tv is built against LLVM trunk, which may differ from your local LLVM in IR semantics details.');
    }

    const report = parseAliveOutput(output);
    let pairs = report.pairs;
    if (input.function && provider === 'local' && !hasPair) pairs = pairs.filter((p) => p.function === input.function);
    const incorrect = pairs.filter((p) => p.verdict === 'incorrect');
    const unproven = pairs.filter((p) => p.verdict === 'unproven');
    const correct = pairs.filter((p) => p.verdict === 'correct');
    const verdict = incorrect.length > 0 ? 'incorrect' : pairs.length === 0 || unproven.length > 0 ? 'inconclusive' : 'correct';
    for (const p of pairs) {
      ev.observe(`${p.function ?? '(function)'}: ${p.verdict}${p.error ? ` (${p.error})` : ''}`);
    }
    if (verdict === 'incorrect') {
      ev.infer('The after IR does not refine the before IR: for the counterexample input the source is defined and the target produces a different value, poison, or UB. If a pass produced this, the pass (or its preconditions) is wrong.');
    } else if (verdict === 'correct') {
      ev.infer('No refinement violation exists within Alive2\'s bounds for the compared functions.');
      ev.unknown('Correctness beyond Alive2\'s loop bound and memory model, and for functions that were not compared.');
    } else {
      ev.unknown(pairs.length === 0 ? 'alive-tv produced no verdict (parse error, no matching function pair, or unsupported IR); see the output view.' : 'Alive2 could not prove or refute the transformation (timeout or unsupported feature).');
    }
    ev.cover('functions_compared', pairs.map((p) => p.function));
    ev.cover('provider', where);
    const first = incorrect[0];
    return {
      status: verdict === 'inconclusive' ? 'inconclusive' : 'ok',
      summary: verdict === 'incorrect'
        ? `INCORRECT: ${first!.function ?? 'transform'}: ${first!.error ?? 'does not verify'}`
        : verdict === 'correct' ? `correct within Alive2 bounds (${correct.length} function pair(s))` : 'Alive2 gave no verdict',
      result: {
        verdict,
        provider: where,
        pairs: pairs.slice(0, 30).map((p) => ({ ...p, counterexample: p.counterexample ? preview(p.counterexample, 40, 3000) : null })),
        counts: { correct: correct.length, incorrect: incorrect.length, unproven: unproven.length },
        alive_summary: report.summary,
        output_preview: pairs.length === 0 ? preview(output, 30) : undefined,
        work_dir: path.basename(ev.workDir),
      },
    };
  },
});
