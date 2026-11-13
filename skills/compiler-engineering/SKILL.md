---
name: compiler-engineering
description: Do compiler engineering with evidence instead of guesses. Use when a program behaves differently across optimisation levels or compilers, when someone suspects a compiler bug or miscompile, when a compiler crashes, when writing or reviewing an optimisation pass or IR rewrite, when asking why a loop was not vectorised or inlined, when comparing generated assembly or making a "this is faster" claim, and when building a parser, type checker, code generator or JIT. Works with the cea MCP server or CLI when present and with plain clang/gcc/opt/alive-tv commands when not.
version: 0.1.0
---

# Compiler engineering

One wrong compiler rewrite breaks every program that passes through it, and one wrong "it's a compiler bug" wastes a maintainer's day. This skill exists so that neither happens on a guess.

## Three rules

1. **Semantics before speed.** A faster program that prints a different answer is a bug. Check output before timing anything.
2. **Evidence before claims.** "Compiler bug", "this pass is correct" and "this is faster" are conclusions. State one only with the evidence that supports it.
3. **Small before large.** Reduce the test case, then reason about it. Nobody can audit 4,000 lines of IR.

## Non-negotiables

Follow these in every task this skill covers. They are not style preferences; each one prevents a specific, common, expensive mistake.

- **Pin the environment first.** No conclusion without the exact compiler version, the exact flags and the target triple. Run `environment_report` (or `clang --version` and `clang -dumpmachine`) before anything else and repeat the three facts in your answer.
- **Rule out undefined behaviour before blaming a compiler.** Run `check_ub` at -O0 and -O1. If it finds anything, stop: the answer is "UB at file:line, not a compiler bug". If it is clean, say "no sanitizer findings", never "no UB": sanitizers cannot see strict-aliasing violations, unsequenced modifications, most uninitialised reads, or paths the input did not execute.
- **Never disable a verifier to make something pass.** Do not remove `-verify`, `-verify-machineinstrs`, assertions, `opt -passes=verify`, sanitizer flags or a failing test. A verifier failure is the finding.
- **No speed claim without variance.** A number from one run is an anecdote. Use `benchmark`: warm-up, at least five runs, median and spread, same output checked. If the run-time ranges overlap, the honest result is "not distinguishable".
- **Cite evidence IDs.** Every tool returns an Evidence record with an `evidence_id` (for example `ev_check_ub_1a2b3c4d`). Put the ID next to each claim it supports.
- **Separate observed, inferred and unknown.** Observed is what a tool printed. Inferred is what you conclude from it, and is weaker. Unknown is what the evidence does not settle. Write all three, in that order, in every conclusion. Record open questions with `record_unknown` instead of resolving them by assumption.
- **A model is not a measurement.** llvm-mca output, optimisation remarks and reading assembly tell you what might matter. Only a benchmark tells you what does.

## Route by task

| The task | Read | Start with |
|---|---|---|
| "Works at -O0, wrong at -O2", "compiler bug?", different output on another compiler | [miscompile-triage](references/miscompile-triage.md) | `triage_miscompile`, or `check_ub` then `differential_run` |
| The compiler crashes or asserts | [miscompile-triage](references/miscompile-triage.md), [verification-and-testing](references/verification-and-testing.md) | `compile` to capture the crash, then `reduce_testcase` with kind `crash` |
| Writing, reviewing or debugging an IR transformation, peephole or pass | [ir-and-optimization](references/ir-and-optimization.md) | `validate_transform`, `pass_timeline` |
| "Why wasn't this vectorised / inlined / hoisted?", comparing codegen | [performance-and-codegen](references/performance-and-codegen.md) | `opt_remarks`, then `compile` to read the assembly |
| "Is this faster?" | [performance-and-codegen](references/performance-and-codegen.md) | `benchmark` (after confirming the output is the same) |
| Lexer, parser, AST, type checker, diagnostics | [frontend-and-types](references/frontend-and-types.md) | tests first; `compile` and `emit_ir` to see what the frontend produced |
| Instruction selection, register allocation, ABI, unwind info, JIT, a new target | [backend-and-hardware](references/backend-and-hardware.md) | `compile` to asm or object, `differential_run` |
| Test strategy, lit/FileCheck, fuzzing, translation validation | [verification-and-testing](references/verification-and-testing.md) | `fuzz_compiler`, `validate_transform` |
| The tools are missing, a provider is unavailable, the server will not connect | [connection-and-recovery](references/connection-and-recovery.md) | `environment_report` |

Read the reference before the work, not after it fails.

## The tools

When the cea MCP server is connected, use its tools. Each call returns one Evidence record; large output (IR, assembly, diffs) stays on disk as a view that you page through with `inspect_evidence_view` instead of pulling it into context.

| Tool | Use it to |
|---|---|
| `environment_report` | pin compilers, versions, targets; see which providers are missing and why |
| `compile` | get asm, IR, an object or an executable with exact flags and parsed diagnostics |
| `emit_ir` | see what the frontend generated before any pass ran |
| `pass_timeline` | see what each pass did to one function, as diffs |
| `opt_remarks` | read why an optimisation was missed |
| `check_ub` | run UBSan/ASan (MSan, Miri) and get findings with source locations |
| `differential_run` | compare output across compilers and optimisation levels |
| `bisect_passes` | find the first pass that flips the behaviour |
| `reduce_testcase` | shrink a failing case under a strict interestingness test |
| `validate_transform` | ask Alive2 whether a rewrite is a refinement, with a counterexample if not |
| `analyze_throughput` | llvm-mca on a loop or function for a named CPU |
| `benchmark` | timed runs with median, spread and an output check |
| `fuzz_compiler` | time-boxed Csmith/YARPGen differential campaign |
| `bisect_compiler_history` | `git bisect` a compiler checkout with a reduced test |
| `triage_miscompile` | the whole miscompile chain in one call, with early stops and a draft report |
| `list_evidence`, `inspect_evidence_view` | find IDs, read records and raw output |
| `record_unknown`, `update_unknown` | track open questions with supporting and contradicting evidence |
| `export_evidence_bundle` | write the session to one file for a bug report |

The same tools exist on the command line as `cea <tool> --input input.json`.

Without the server, do the same steps by hand and keep the same discipline: paste the exact command and the relevant output next to each claim. The references give the plain commands (`clang -fsanitize=undefined,address`, `-mllvm -opt-bisect-limit=N`, `opt -passes=... -print-changed`, `alive-tv before.ll after.ll`, `llvm-mca -mcpu=...`).

## Working method

1. **State the question as something a tool can answer.** Not "is the compiler broken" but "does `clang 18.1.3 -O2` on `x86_64-pc-linux-gnu` produce output different from `-O0` for this input, with no sanitizer finding".
2. **Pin the environment** (`environment_report`).
3. **Take the cheapest step that could end the investigation.** For a suspected miscompile that is `check_ub`. For a speed question it is checking that the outputs match.
4. **Shrink** (`reduce_testcase`) before reading IR.
5. **Explain, then validate.** `pass_timeline` shows what changed; `validate_transform` says whether the change is legal. A diff is not a proof.
6. **Stop when the question is answered.** Say what stopped you.
7. **Write the conclusion in the format below.**

Tool results that say `unavailable` or `inconclusive` are results. "alive-tv is not installed, so the transformation was not validated" goes in the report under Unknown. Do not substitute your own judgement for a tool you could not run, and do not quietly skip the step.

## How to report

```
Question:  <the precise question>
Environment: <compiler version> | <flags> | <target triple>

Observed
- <fact read from tool output> [ev_...]
- ...

Inferred
- <conclusion, and which observations it rests on> [ev_..., ev_...]

Unknown
- <what the evidence does not settle, and what would settle it>

Verdict: <one sentence, no stronger than the evidence>
```

Words to keep honest:

| Do not write | Unless |
|---|---|
| "compiler bug" | `check_ub` is clean, the case is reduced, and `validate_transform` refutes the culprit transformation (or the compiler crashed) |
| "no undefined behaviour" | never from sanitizers alone; write "no sanitizer findings" |
| "the pass is correct" | Alive2 verified it, and then add "within Alive2's bounds" |
| "faster" | `benchmark` shows non-overlapping ranges with identical output; give the ratio, the machine and the run count |
| "the compiler vectorised/inlined X" | you read it in the assembly or a remark, with the evidence ID |

If the difference between two builds disappears with `-fwrapv`, `-fno-strict-aliasing` or `-fno-delete-null-pointer-checks`, the program is almost certainly relying on behaviour the standard leaves undefined. Say that, and do not call it a compiler bug.

## Before you finish

- [ ] Compiler version, flags and target are stated.
- [ ] UB was checked before any compiler was blamed, and the wording matches what the check can show.
- [ ] No verifier, assertion, sanitizer or test was disabled to get here.
- [ ] Every speed statement has a median, a spread, a run count and an output check.
- [ ] Every claim carries an evidence ID or the exact command and output.
- [ ] Observed, inferred and unknown are separate, and the unknowns are written down.
- [ ] The verdict is no stronger than the weakest link it depends on.
