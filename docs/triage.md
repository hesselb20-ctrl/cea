# Triage: triage_miscompile

`triage_miscompile` answers the question "my program behaves differently at `-O2`; is that a compiler bug?" in one call. It runs the whole chain of checks, stops as soon as the question is answered, and returns a verdict, the evidence ID of every step, and a draft report in Markdown.

It is built from the tools described in the other pages: [environment](tools-environment.md), [compile and inspect](tools-compile.md), [correctness](tools-correctness.md) and [the ledger](tools-ledger.md). Each step is a normal tool call that leaves its own Evidence record, so every claim in the report can be traced back. The triage record lists all of them in `derived_from`. For the workflow an agent should follow around this tool, see [../skills/compiler-engineering/SKILL.md](../skills/compiler-engineering/SKILL.md).

A triage verdict is a lead with its evidence, not a proof. Read what each verdict means below before you act on it.

## Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `source` | object | required | The program. See [tools-compile.md](tools-compile.md). |
| `compiler` | string | `"clang"` | The compiler under suspicion. |
| `flags` | string[] | `["-O2"]` | The configuration that gives the unexpected result. |
| `reference_flags` | string[] | `["-O0"]` | The configuration that gives the expected result. |
| `function` | string | none | Function to follow in the pass timeline. Default: the function the culprit pass ran on. |
| `run` | object | `{"args":[],"timeout_s":10}` | How to run the test program; used by every step that runs it. |
| `reduce` | boolean | `true` | Whether to run test-case reduction. |
| `reduce_timeout_s` | integer | `120` | Budget for reduction in seconds, 1 to 3600. |
| `validate` | boolean | `true` | Run Alive2 on the IR before and after the culprit pass when a provider is available. |

## The chain, step by step

The step names below are the values of `step` in the result's `steps` list.

1. **`environment`.** Runs `environment_report` without the sanitizer probe, then resolves `compiler` and records its version and target. If the compiler cannot be found, triage ends here with status `unavailable`.
2. **`check_ub`.** Runs `check_ub` on the source with your flags, minus any `-O` level and any of `-fwrapv`, `-fno-wrapv`, `-fstrict-aliasing` and `-fno-strict-aliasing` (so that those flags do not change the sanitizer builds). If it reports any finding, triage stops with `undefined_behavior`. If it could not build with any sanitizer, or its result is not clean, triage continues but marks the UB status as unknown.
3. **`differential_run`.** Runs `differential_run` with three exact configurations: the reference flags, the suspect flags, and the suspect flags plus the semantic probe `-fwrapv -fno-strict-aliasing -fno-delete-null-pointer-checks`. The tool also runs its default grid of compilers and optimisation levels, which you will see in that step's record. Then it decides:
   - if the reference or suspect build is not stable across two runs of the same binary, triage stops with `nondeterministic_program`;
   - if either did not build, or both behave identically, triage stops with `not_reproduced`;
   - otherwise the difference is reproduced, and triage notes whether the probe makes the suspect behave like the reference (see below).
4. **`bisect_passes`.** Runs `bisect_passes` in `behavior` mode with your flags and reference flags to find the first pass that flips the behaviour. If no culprit is found, an unknown is recorded and the later pass-specific steps are skipped.
5. **`reduce_testcase`.** If `reduce` is true, runs `reduce_testcase` with kind `miscompile`. If the reduction is not verified, an unknown says the case was not reduced and the report uses the original source.
6. **`pass_timeline`, `ir_before_culprit`, `ir_after_culprit`.** If a culprit was found, triage works out which function to look at (your `function`, or the unit the culprit ran on, when that is a function). If it knows one, it runs `pass_timeline` on it, filtered to the culprit pass. In any case it compiles the module to IR twice with `-mllvm -opt-bisect-limit=N`, once at the last good limit and once at the first bad limit. The difference between those two IRs, restricted to the function if known, is the transformation of the culprit pass. It is stored as the view `culprit.diff`.
7. **`validate_transform`.** If `validate` is true and the IR really differs between the two limits, runs `validate_transform` on the before and after IR. If the IR is identical on both sides, the culprit is a code generation (backend) pass, which Alive2 cannot check, and no validation is run.

Then the verdict is chosen (below) and the report is written.

## Stop conditions

Triage ends early in exactly these cases:

| When | Verdict |
|---|---|
| `check_ub` reports one or more findings. | `undefined_behavior` |
| The same binary gives different output on consecutive runs, for the reference or the suspect configuration. | `nondeterministic_program` |
| The reference or suspect configuration did not build, or the two behave identically. | `not_reproduced` |

It can also end with status `error` or `unavailable` before any verdict, for example when the source file is not found, a flag is rejected as unsafe, or the compiler is missing. All other cases run to the end and are decided by the verdict rules.

## Verdicts

The `verdict` field of the result is one of the following. `is_compiler_bug` is a second field in the result that says what the verdict means for the question that matters.

| Verdict | Meaning | `is_compiler_bug` |
|---|---|---|
| `undefined_behavior` | The sanitizers found undefined behaviour in the program. The compiler may produce any result at any level. The headline gives the location, for example "UB found at foo.c:42 (...), not a compiler bug". | `no` |
| `not_reproduced` | The two configurations behave the same, or one did not build. Check the exact compiler version, flags, target and program input of the original report. | `not established` |
| `nondeterministic_program` | The program is non-deterministic by itself (uninitialised memory, addresses, time, threads). Differences cannot be attributed to the compiler until that is fixed. | `no` |
| `suspected_undetected_ub` | The difference disappears when `-fwrapv -fno-strict-aliasing -fno-delete-null-pointer-checks` is added. That pattern usually means the program relies on signed overflow, strict aliasing or null-pointer assumptions that the sanitizers did not catch. | `unlikely` |
| `transformation_refuted` | Alive2 found an input for which the IR after the culprit pass does not refine the IR before it. This is evidence of an incorrect transformation, and the only verdict that supports a bug report. | `likely` |
| `transformation_verified` | A pass flips the behaviour, but Alive2 verifies that pass's transformation. A valid refinement can only change observable behaviour if the program has undefined or unspecified behaviour, or if a later stage is at fault. | `not established` |
| `unresolved` | The difference reproduces, but the evidence does not decide: no culprit pass was isolated, or the transformation could not be validated (no Alive2, a backend pass, a timeout or an unsupported feature). The record's status is `inconclusive`. | `not established` |

`undefined_behavior`, `nondeterministic_program` and `not_reproduced` come from the early stops. The other four are decided at the end, in this order:

1. If the semantic probe made the suspect behave like the reference: `suspected_undetected_ub`. This outranks Alive2, because Alive2 ignores type-based aliasing and so can "refute" a transformation that strict aliasing permits. The headline then says whether Alive2 verified the transformation, refuted it (and why that does not implicate the pass), or could not check it because it relies on `!tbaa`.
2. Else if Alive2 says the transformation is incorrect: `transformation_refuted`.
3. Else if Alive2 says it is correct: `transformation_verified`.
4. Else `unresolved`.

If the UB status is unknown (no sanitizer build could be made), " (UB status unverified)" is appended to the headline. Whatever the verdict, the report lists as unknown that the sanitizers cannot see strict aliasing, unsequenced modification or uninitialised reads, and that the issue should be re-checked on the compiler's main branch.

### The semantic probe

The probe re-runs the suspect configuration with `-fwrapv`, `-fno-strict-aliasing` and `-fno-delete-null-pointer-checks`. These flags give signed overflow, type punning through pointers and null-pointer dereference a defined meaning. If adding them makes the difference go away, the optimiser was relying on an assumption the language grants it, and the likeliest explanation is that the program breaks that assumption. It is cheap and catches the kinds of undefined behaviour that UBSan and ASan do not instrument. The example [../examples/05-ub-sanitizers-cannot-see/](../examples/05-ub-sanitizers-cannot-see/) is described in its own comment as a strict-aliasing violation that both sanitizers miss.

## Result fields

| Field | Meaning |
|---|---|
| `verdict` | One of the seven verdicts. |
| `headline` | One sentence stating the verdict and the key fact. Also the record's `summary`. |
| `is_compiler_bug` | `no`, `unlikely`, `likely` or `not established`, per the table above. |
| `steps` | One entry per step run: `step`, `evidence_id`, `status`, `summary`. |
| `report_view` | `report.md`, the full Markdown report. |
| `report_markdown` | A preview of the report (up to 200 lines). |
| `ub_findings` | With `undefined_behavior`: up to 10 findings. |
| `culprit` | Final verdicts only: the culprit pass as `n`, `pass`, `unit`, or `null`. |
| `reduced` | Final verdicts only: `evidence_id` and `lines` of the verified reduced case, or `null`. |
| `validation` | Final verdicts only: `evidence_id` and the Alive2 `verdict` of the validation step, or `null`. |
| `semantic_probe_hides_difference` | Final verdicts only: whether the probe made the difference disappear. |
| `ub_status` | Final verdicts only: "no sanitizer findings" or "unknown". |

The record's status is `ok` for every verdict except `unresolved`, which is `inconclusive`. The triage record's own `observed`, `inferred` and `unknowns` summarise the chain; its `limitations` list is empty, and the limitations of each method are in the records of the individual steps. The report always lists the open unknowns, including whether the program has undefined behaviour that sanitizers cannot see.

## The Markdown report

The report is stored as the view `report.md` and previewed in the result. The early stops give a short report: a title, the verdict, and (for `undefined_behavior`) the findings, an explanation, and the evidence table. A report for a final verdict has these sections:

1. **Title.** For `transformation_refuted`: the pass and the flags, in the form "[pass] wrong code at flags". Otherwise "Triage: file".
2. **Status.** The headline, followed by a note. For `transformation_refuted` the note says this is a draft upstream report and lists what to do before filing: re-check on the compiler's main branch, search for duplicates, and confirm the reproducer is free of undefined behaviour beyond what sanitizers see. For every other verdict the note says it is a triage record, not a bug report.
3. **Environment.** The compiler version, the target, and the expected and unexpected flags.
4. **Reproducer.** The reduced source when reduction was verified (with the line counts), otherwise the original. Followed by shell commands that build and run the good and bad configurations, and the last good bisect limit when there is a culprit.
5. **Observed.** Whether the sanitizers ran, the reference and suspect output hashes and exit codes, the result of the semantic probe, and the culprit pass by bisection.
6. **What the pass changed.** A diff of the IR across the culprit pass, when there is one.
7. **Violated invariant.** The Alive2 counterexample when there is one. Otherwise "None found" (verified) or "Not established" with the reason, plus a note when the transformation relies on `!tbaa`.
8. **Inferred.** Conclusions that are weaker than the observations.
9. **Unknown.** What is still open: undefined behaviour sanitizers cannot see, validity of the transformation when Alive2 did not decide, validity beyond Alive2's bounds, and whether the issue reproduces on the compiler's main branch.
10. **Evidence.** A table of every step with its evidence ID and one-line result.

## Example

```json
{
  "source": { "path": "examples/05-ub-sanitizers-cannot-see/alias.c" },
  "compiler": "clang",
  "flags": ["-O2"],
  "reference_flags": ["-O0"],
  "reduce": true,
  "reduce_timeout_s": 120,
  "validate": true
}
```

```sh
cea triage_miscompile --input input.json
```

The read-out of the report is then one call away:

```json
{ "evidence_id": "ev_triage_miscompile_1a2b3c4d", "view": "report.md" }
```

```sh
cea inspect_evidence_view --input report-input.json
```

## The human form: cea triage

`cea triage` runs the same tool and prints the chain as it happened, for a person at a terminal.

```
cea triage <file> [--compiler <name>] [--flags "<flags>"] [--ref "<flags>"] [--no-reduce] [--report <file>]
```

| Option | Default | Meaning |
|---|---|---|
| `<file>` | required | Path to the source file. Becomes `source.path`. |
| `--compiler <name>` | `clang` | The compiler under suspicion. |
| `--flags "<flags>"` | `-O2` | The suspect configuration. Split on whitespace into separate arguments. |
| `--ref "<flags>"` | `-O0` | The reference configuration. Split on whitespace. |
| `--no-reduce` | reduction on | Skip test-case reduction (`reduce` is false). |
| `--report <file>` | none | Also write the Markdown report to this file. |

`--session` and `--home` apply as for every command. The CLI form cannot take inline code, a `function`, a `run` object, `validate` or a reduction budget; use `cea triage_miscompile --input file.json` for those.

The output has one line per step with a mark (`ok`, `??` for inconclusive, `--` for anything else), then the verdict, the headline, `compiler bug?` with the `is_compiler_bug` value, the observed, inferred and unknown lists, and a final line `triage evidence <id>` that says the report is the view "report.md", or can be written with `--report <file>`. Step summaries are word-wrapped and show your file name, not the private copy cea works on. The exit code is 0 for every verdict, including `unresolved`, and 2 if the file argument is missing or the call ended with status `error` or `unavailable`.

```sh
cea triage examples/01-ub-not-a-compiler-bug/overflow.c --flags "-O2" --ref "-O0" --report triage.md
```

See [cli.md](cli.md) for all commands.

## What it does not tell you

A verdict other than `transformation_refuted` does not show that the compiler is correct, only that this chain did not find a bug. `transformation_refuted` does not show the bug is new, present on the compiler's main branch, or free of undefined behaviour the sanitizers cannot see; the report says so under "Unknown". Triage works on one input and one pair of configurations, and bisection can name a pass that only exposes a fault elsewhere.
