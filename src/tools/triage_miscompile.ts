import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_RUN, FlagsSchema, materialize, RunSpecSchema, SourceSchema, TimeoutSchema } from '../core/build.js';
import { defineTool, invokeTool, type Ctx, type EvidenceBuilder } from '../core/context.js';
import { unifiedDiff } from '../core/diff.js';
import type { Evidence } from '../core/types.js';
import { preview } from '../core/util.js';
import { bisectPasses } from './bisect_passes.js';
import { checkUb, type UbFinding } from './check_ub.js';
import { compile } from './compile.js';
import { differentialRun } from './differential_run.js';
import { environmentReport } from './environment_report.js';
import { extractIrFunction, passTimeline } from './pass_timeline.js';
import { reduceTestcase } from './reduce_testcase.js';
import { validateTransform } from './validate_transform.js';

export type TriageVerdict =
  | 'undefined_behavior'
  | 'not_reproduced'
  | 'nondeterministic_program'
  | 'suspected_undetected_ub'
  | 'transformation_refuted'
  | 'transformation_verified'
  | 'unresolved';

interface StepLog {
  step: string;
  evidence_id: string | null;
  status: string;
  summary: string;
}

const SEMANTIC_PROBE = ['-fwrapv', '-fno-strict-aliasing', '-fno-delete-null-pointer-checks'];
const norm = (s: string) => s.toLowerCase().replace(/pass$/, '').replace(/[^a-z0-9]/g, '');

async function step(ctx: Ctx, ev: EvidenceBuilder, log: StepLog[], name: string, run: () => Promise<Evidence>): Promise<Evidence> {
  const e = await run();
  ev.derive(e.evidence_id);
  log.push({ step: name, evidence_id: e.evidence_id, status: e.status, summary: e.summary });
  return e;
}

export const triageMiscompile = defineTool({
  name: 'triage_miscompile',
  family: 'composite',
  title: 'Triage a suspected miscompile',
  description:
    'One call that runs the whole triage chain and stops as soon as the question is answered: pin the environment, check_ub, differential_run, bisect_passes, reduce_testcase, pass_timeline around the culprit, validate_transform. ' +
    'It stops early and says why (for example "UB found at foo.c:42, not a compiler bug"). Output: a verdict, the evidence IDs of every step, and a draft upstream bug report in Markdown.',
  input: z.strictObject({
    source: SourceSchema,
    compiler: z.string().min(1).default('clang').describe('The compiler under suspicion.'),
    flags: FlagsSchema.default(['-O2']).describe('The configuration that gives the unexpected result.'),
    reference_flags: FlagsSchema.default(['-O0']).describe('The configuration that gives the expected result.'),
    function: z.string().max(200).optional().describe('Function to follow in the pass timeline. Default: the function the culprit pass ran on.'),
    run: RunSpecSchema.default(DEFAULT_RUN),
    reduce: z.boolean().default(true),
    reduce_timeout_s: TimeoutSchema.default(120),
    validate: z.boolean().default(true).describe('Run Alive2 on the IR before and after the culprit pass when a provider is available.'),
  }),
  async run(input, ev, ctx) {
    const log: StepLog[] = [];
    const src = materialize(ev, input.source);
    const fileLabel = input.source.path ? path.basename(input.source.path) : `input${path.extname(src.file)}`;
    // Sub-steps get the same bytes, by path, so every record hashes the same file.
    const source = { path: src.file };
    const base = { source, compiler: input.compiler };
    const finish = (verdict: TriageVerdict, headline: string, extra: Record<string, unknown>, report: string) => {
      const v = ev.view('report.md', report, 'draft report (Markdown)');
      return {
        status: verdict === 'unresolved' ? 'inconclusive' as const : 'ok' as const,
        summary: headline,
        result: { verdict, headline, is_compiler_bug: verdict === 'transformation_refuted' ? 'likely' : verdict === 'undefined_behavior' || verdict === 'nondeterministic_program' ? 'no' : verdict === 'suspected_undetected_ub' ? 'unlikely' : 'not established', steps: log, ...extra, report_view: v.name, report_markdown: preview(report, 200, 9000) },
      };
    };

    // 1. Pin the environment.
    await step(ctx, ev, log, 'environment', () => invokeTool(ctx, environmentReport, { probe_sanitizers: false }));
    const compilerInfo = await ev.compiler(input.compiler);
    const envLine = `${compilerInfo.version.replace(/ \(https?:[^)]*\)/, '')}, target ${compilerInfo.target ?? 'unknown'}`;
    ev.observe(`Compiler under test: ${envLine}; flags ${input.flags.join(' ')} vs reference ${input.reference_flags.join(' ')}`);

    // 2. Undefined behaviour first.
    const ub = await step(ctx, ev, log, 'check_ub', () => invokeTool(ctx, checkUb, { ...base, flags: input.flags.filter((f) => !/^-O/.test(f) && !/^-f(no-)?(wrapv|strict-aliasing)/.test(f)), run: input.run }));
    const findings = (ub.result['findings'] as UbFinding[] | undefined) ?? [];
    if (findings.length > 0) {
      const f = findings[0]!;
      const loc = f.file ? `${fileLabel}:${f.line}${f.column !== null ? `:${f.column}` : ''}` : 'unknown location';
      const headline = `UB found at ${loc} (${f.message}), not a compiler bug`;
      ev.observe(`check_ub reported ${findings.length} finding(s); first: ${f.message} at ${loc}`);
      ev.infer('The program has undefined behaviour, so the compiler may produce any result at any optimisation level. Triage stops here.');
      return finish('undefined_behavior', headline, { ub_findings: findings.slice(0, 10) }, [
        `# Triage: ${fileLabel} is not a compiler bug`,
        '',
        `**Verdict:** undefined behaviour in the program. ${f.message} at \`${loc}\`.`,
        '',
        `- Compiler: ${envLine}`,
        `- Flags compared: \`${input.reference_flags.join(' ')}\` vs \`${input.flags.join(' ')}\``,
        '',
        '## Findings',
        '',
        ...findings.slice(0, 10).map((x) => `- \`${x.file ? path.basename(x.file) : '?'}:${x.line ?? '?'}:${x.column ?? '?'}\` ${x.sanitizer}: ${x.message} (-${x.opt_level})`),
        '',
        '## What this means',
        '',
        'The C and C++ standards place no requirement on a program that executes undefined behaviour. An optimiser that assumes it does not happen is behaving correctly, and different output at different optimisation levels is expected. Fix the program; do not file a compiler bug.',
        '',
        '## Evidence',
        '',
        ...log.map((s) => `- ${s.step}: \`${s.evidence_id}\` ${s.summary}`),
        '',
      ].join('\n'));
    }
    const ubUnknown = ub.status !== 'ok' || ub.result['clean'] !== true;
    if (ubUnknown) ev.unknown('UB status is unknown: no sanitizer build could be run. Everything below assumes the program is well-defined, which is unverified.');
    else ev.observe('check_ub: no sanitizer findings at -O0 and -O1.');

    // 3. Does it reproduce, and against whom?
    const diff = await step(ctx, ev, log, 'differential_run', () => invokeTool(ctx, differentialRun, {
      source, run: input.run,
      extra_configs: [
        { compiler: input.compiler, flags: input.reference_flags },
        { compiler: input.compiler, flags: input.flags },
        { compiler: input.compiler, flags: [...input.flags, ...SEMANTIC_PROBE] },
      ],
    }));
    const rows = (diff.result['configs'] as Record<string, unknown>[] | undefined) ?? [];
    const row = (n: number) => rows.find((r) => String(r['id']).startsWith(`extra${n}-`));
    const key = (r: Record<string, unknown> | undefined) => (r && r['built'] ? `${String(r['outcome'])}|${String(r['stdout_sha256'])}` : null);
    const refKey = key(row(1));
    const badKey = key(row(2));
    const probeKey = key(row(3));
    const nondet = (diff.result['nondeterministic'] as string[] | undefined) ?? [];
    if (nondet.some((id) => /^extra[12]-/.test(id))) {
      ev.infer('The same binary gives different output on consecutive runs, so the difference between configurations cannot be attributed to the compiler.');
      return finish('nondeterministic_program', 'program output is not deterministic; not attributable to the compiler', {}, [
        `# Triage: ${fileLabel}`, '', '**Verdict:** the program is non-deterministic by itself (two runs of one binary differ). Remove the non-determinism (uninitialised memory, addresses, time, threads) before comparing compilers.', '', '## Evidence', '', ...log.map((s) => `- ${s.step}: \`${s.evidence_id}\` ${s.summary}`), '',
      ].join('\n'));
    }
    if (refKey === null || badKey === null || refKey === badKey) {
      const why = refKey === null || badKey === null ? 'one of the two configurations did not build' : 'both configurations behave identically';
      ev.observe(`Not reproduced: ${why}.`);
      return finish('not_reproduced', `not reproduced: ${why}`, {}, [
        `# Triage: ${fileLabel}`, '', `**Verdict:** not reproduced. With ${envLine}, \`${input.reference_flags.join(' ')}\` and \`${input.flags.join(' ')}\`: ${why}.`, '', 'Check the exact compiler version, flags, target and program input of the original report.', '', '## Evidence', '', ...log.map((s) => `- ${s.step}: \`${s.evidence_id}\` ${s.summary}`), '',
      ].join('\n'));
    }
    ev.observe(`Reproduced: reference behaves as ${refKey}, suspect configuration as ${badKey}.`);
    const probeHides = probeKey !== null && probeKey === refKey;
    if (probeHides) {
      ev.observe(`With ${SEMANTIC_PROBE.join(' ')} added, the suspect configuration behaves like the reference.`);
      ev.infer('The difference depends on an optimisation that exploits signed overflow, strict aliasing or null-pointer assumptions. That pattern usually means undefined behaviour that the sanitizers did not catch, not a compiler bug.');
      ev.unknown('Whether the program violates strict aliasing or relies on overflow in a way UBSan does not instrument.');
    }

    // 4. Which pass?
    const bis = await step(ctx, ev, log, 'bisect_passes', () => invokeTool(ctx, bisectPasses, { ...base, flags: input.flags, reference_flags: input.reference_flags, run: input.run }));
    const culprit = bis.result['culprit'] as { n: number; pass: string; unit: string } | null | undefined;
    const lastGood = bis.result['last_good_limit'] as number | undefined;
    const firstBad = bis.result['first_bad_limit'] as number | undefined;
    if (culprit) ev.observe(`Bisection: behaviour flips when ${culprit.pass} runs on ${culprit.unit} (pass ${culprit.n}).`);
    else ev.unknown(`No culprit pass identified (${bis.summary}).`);

    // 5. Make it small.
    let reduced: Evidence | null = null;
    if (input.reduce) {
      reduced = await step(ctx, ev, log, 'reduce_testcase', () => invokeTool(ctx, reduceTestcase, { ...base, kind: 'miscompile', flags: input.flags, reference_flags: input.reference_flags, run: input.run, timeout_s: input.reduce_timeout_s }));
      if (reduced.result['verified'] !== true) ev.unknown(`The test case was not reduced (${reduced.summary}).`);
    }

    // 6. What did the culprit pass do? 7. Is that transformation valid?
    let irDiff: string | null = null;
    let validation: Evidence | null = null;
    const fn = input.function ?? (culprit && !/^\[/.test(culprit.unit) ? culprit.unit : undefined);
    if (culprit && lastGood !== undefined && firstBad !== undefined) {
      if (fn) {
        await step(ctx, ev, log, 'pass_timeline', () => invokeTool(ctx, passTimeline, { ...base, function: fn, flags: input.flags, only_passes: [norm(culprit.pass)], limit: 4 }));
      }
      const lim = (n: number) => [...input.flags, '-mllvm', `-opt-bisect-limit=${n}`];
      const before = await step(ctx, ev, log, 'ir_before_culprit', () => invokeTool(ctx, compile, { ...base, flags: lim(lastGood), output: 'ir' }));
      const after = await step(ctx, ev, log, 'ir_after_culprit', () => invokeTool(ctx, compile, { ...base, flags: lim(firstBad), output: 'ir' }));
      if (before.result['success'] === true && after.result['success'] === true) {
        const b = ctx.ledger.readView(before.evidence_id, 'output.ll');
        const a = ctx.ledger.readView(after.evidence_id, 'output.ll');
        const fb = fn ? extractIrFunction(b, fn) : null;
        const fa = fn ? extractIrFunction(a, fn) : null;
        const d = unifiedDiff(fb ?? b, fa ?? a);
        irDiff = d.text;
        ev.view('culprit.diff', d.text + '\n', `IR difference between -opt-bisect-limit=${lastGood} and ${firstBad}`);
        if (d.added + d.removed === 0) {
          ev.observe('The IR is identical on both sides of the culprit pass: the pass is a code generation (backend) pass, which Alive2 cannot check.');
        } else if (input.validate) {
          validation = await step(ctx, ev, log, 'validate_transform', () => invokeTool(ctx, validateTransform, { before: { code: b, language: 'llvm-ir' }, after: { code: a, language: 'llvm-ir' }, ...(fn ? { function: fn } : {}) }));
        }
      }
    }

    // Verdict.
    const vraw = validation?.result['verdict'] as string | undefined;
    const vv = vraw === 'correct' || vraw === 'incorrect' ? vraw : undefined;
    const tbaa = validation?.result['uses_tbaa'] === true;
    let verdict: TriageVerdict = 'unresolved';
    let headline: string;
    if (probeHides) {
      // The semantic-flag probe outranks Alive2 here: Alive2 ignores TBAA, so it "refutes"
      // transformations that strict aliasing permits. Never turn that into a bug claim.
      verdict = 'suspected_undetected_ub';
      const alive = vv === 'incorrect'
        ? 'Alive2 does not verify the transformation, but Alive2 ignores type-based aliasing, so that does not implicate the pass'
        : vv === 'correct' ? 'Alive2 verifies the transformation' : tbaa ? 'the transformation relies on !tbaa (strict aliasing), which Alive2 cannot check' : 'the transformation was not validated';
      headline = `suspected undefined behaviour that sanitizers cannot see: the difference disappears with ${SEMANTIC_PROBE.join(' ')}${culprit ? `; behaviour flips at ${culprit.pass}` : ''}; ${alive}`;
      ev.infer('The compiler is using an assumption the language standard grants it (no signed overflow, strict aliasing, or non-null dereferenced pointers). The likeliest explanation is that the program breaks that assumption.');
    } else if (vv === 'incorrect') {
      verdict = 'transformation_refuted';
      headline = `likely compiler bug: Alive2 refutes the transformation made by ${culprit!.pass}`;
      ev.infer(`Alive2 found an input for which the IR after ${culprit!.pass} does not refine the IR before it. That is evidence of an incorrect transformation.`);
    } else if (vv === 'correct') {
      verdict = 'transformation_verified';
      headline = `${culprit!.pass} flips the behaviour, but Alive2 verifies its transformation: suspect undefined behaviour the sanitizers missed, or a later stage`;
      ev.infer('The culprit pass made a valid refinement. A valid refinement can only change observable behaviour if the program has undefined or unspecified behaviour, or if a later stage is at fault.');
    } else {
      headline = culprit
        ? `unresolved: behaviour flips at ${culprit.pass}, but the transformation was not validated${validation ? ` (${validation.summary})` : ''}`
        : 'unresolved: the difference reproduces but no culprit pass was isolated';
      if (culprit && !validation) ev.unknown('Whether the culprit pass\'s transformation is valid: no Alive2 run was possible.');
    }
    if (ubUnknown) headline += ' (UB status unverified)';

    const reducedOk = reduced?.result['verified'] === true;
    const repro = reducedOk ? ctx.ledger.readView(reduced!.evidence_id, String(reduced!.result['reduced_view'])) : src.text;
    const lang = src.language === 'c++' ? 'cpp' : src.language === 'llvm-ir' ? 'llvm' : src.language;
    const cc = path.basename(compilerInfo.path).replace(/\.exe$/i, '');
    const pairs = (validation?.result['pairs'] as { function: string | null; verdict: string; error: string | null; counterexample: string | null }[] | undefined) ?? [];
    const bad = pairs.find((p) => p.verdict === 'incorrect');
    const report = [
      `# ${verdict === 'transformation_refuted' ? `[${culprit!.pass}] wrong code at ${input.flags.join(' ')}` : `Triage: ${fileLabel}`}`,
      '',
      `**Status:** ${headline}.`,
      '',
      verdict === 'transformation_refuted'
        ? '> Draft upstream report. Before filing: re-check on the compiler\'s main branch, search for duplicates, and confirm the reproducer is free of undefined behaviour beyond what sanitizers see.'
        : '> This is a triage record, not a bug report. The evidence does not establish a compiler bug.',
      '',
      '## Environment',
      '',
      `- Compiler: ${compilerInfo.version}`,
      `- Target: ${compilerInfo.target ?? 'unknown'}`,
      `- Expected behaviour with: \`${input.reference_flags.join(' ')}\``,
      `- Unexpected behaviour with: \`${input.flags.join(' ')}\``,
      '',
      `## Reproducer${reducedOk ? ` (reduced from ${(reduced!.result['before'] as { lines: number }).lines} to ${(reduced!.result['after'] as { lines: number }).lines} lines)` : ' (not reduced)'}`,
      '',
      '```' + lang,
      repro.trimEnd(),
      '```',
      '',
      '```sh',
      `${cc} ${input.reference_flags.join(' ')} repro${path.extname(src.file)} -o good && ./good   # ${refKey.split('|')[0] === '0' ? 'expected output' : `exit ${refKey.split('|')[0]}`}`,
      `${cc} ${input.flags.join(' ')} repro${path.extname(src.file)} -o bad && ./bad     # differs`,
      ...(culprit && lastGood !== undefined ? [`${cc} ${input.flags.join(' ')} -mllvm -opt-bisect-limit=${lastGood} repro${path.extname(src.file)} -o ok   # last good limit; ${firstBad} is the first bad`] : []),
      '```',
      '',
      '## Observed',
      '',
      `- Sanitizers (UBSan, ASan at -O0/-O1): ${ubUnknown ? 'could not be run' : 'no findings'}`,
      `- Reference output hash ${refKey.split('|')[1]} (exit ${refKey.split('|')[0]}); suspect output hash ${badKey.split('|')[1]} (exit ${badKey.split('|')[0]})`,
      `- With \`${SEMANTIC_PROBE.join(' ')}\`: ${probeKey === null ? 'did not build' : probeHides ? 'behaves like the reference' : 'still differs'}`,
      ...(culprit ? [`- Responsible pass by bisection: **${culprit.pass}** on \`${culprit.unit}\` (pass ${culprit.n} of ${String(bis.result['total_passes'])})`] : ['- Responsible pass: not isolated']),
      '',
      ...(irDiff ? ['## What the pass changed', '', '```diff', preview(irDiff, 60, 4000), '```', ''] : []),
      '## Violated invariant',
      '',
      ...(bad
        ? [`Alive2: \`${bad.function ?? fn ?? '?'}\` does not verify: **${bad.error ?? 'refinement failure'}**.`, '', '```', bad.counterexample ?? '(no counterexample text)', '```']
        : vv === 'correct'
          ? ['None found: Alive2 verifies the transformation within its bounds.']
          : [`Not established: ${validation ? validation.summary : 'the transformation was not checked by Alive2'}.`, ...(tbaa ? ['', 'The transformation relies on `!tbaa` metadata, i.e. on the strict aliasing rule. It is valid exactly when the program obeys that rule.'] : [])]),
      '',
      '## Inferred (weaker than the observations above)',
      '',
      ...(verdict === 'transformation_refuted' ? [`- ${culprit!.pass} performs a transformation that is not a refinement for the counterexample input.`] : []),
      ...(verdict === 'transformation_verified' ? ['- The pass is correct on this input; the program most likely has undefined behaviour that sanitizers cannot detect.'] : []),
      ...(probeHides ? ['- Sensitivity to -fwrapv / -fno-strict-aliasing suggests reliance on signed overflow or type punning.'] : []),
      ...(verdict === 'unresolved' ? ['- Nothing beyond the observations.'] : []),
      '',
      '## Unknown',
      '',
      '- Whether the program has undefined behaviour that UBSan/ASan cannot see (strict aliasing, unsequenced modification, uninitialised reads).',
      ...(vv === undefined && culprit ? [`- Whether the culprit transformation is valid: ${validation ? validation.summary : 'no Alive2 run was possible'}.`] : []),
      ...(vv !== undefined ? ['- Validity beyond Alive2\'s loop bound and memory model.'] : []),
      '- Whether the issue reproduces on the compiler\'s current main branch.',
      '',
      '## Evidence',
      '',
      '| Step | Evidence ID | Result |',
      '|---|---|---|',
      ...log.map((s) => `| ${s.step} | \`${s.evidence_id}\` | ${s.summary.replace(/\|/g, '\\|')} |`),
      '',
    ].join('\n');
    return finish(verdict, headline, {
      culprit: culprit ?? null,
      reduced: reducedOk ? { evidence_id: reduced!.evidence_id, lines: (reduced!.result['after'] as { lines: number }).lines } : null,
      validation: validation ? { evidence_id: validation.evidence_id, verdict: vv } : null,
      semantic_probe_hides_difference: probeHides,
      ub_status: ubUnknown ? 'unknown' : 'no sanitizer findings',
    }, report);
  },
});
