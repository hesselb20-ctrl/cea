# Miscompile triage

**When to read this.** Read this when a program prints different output, crashes, or hangs only at some optimisation level (`-O0` works, `-O2` fails), only with one compiler, or only after a compiler upgrade. The default assumption is that the program has undefined behaviour, not that the compiler is wrong. Most "compiler bugs" are UB that a newer or more aggressive optimiser started to exploit. This guide gives the order of steps, the plain command for each, and the cea tool that runs the same step and records evidence. Back to the [skill overview](../SKILL.md).

## Rules that apply throughout

- **Semantics before speed, evidence before claims, small before large.**
- Before any conclusion, write down: exact compiler version line, full flag list, target triple, and the input that triggers the failure. A finding without these cannot be reproduced.
- Cite evidence IDs (`ev_<operation>_<8 hex>`) for every statement. Keep three lists: **observed** (read from tool output), **inferred** (your reasoning from observations), **unknown** (not settled). Use `record_unknown` for open questions so they are not lost.
- "No sanitizer report" is an observation about the paths that ran, not proof that the program is UB-free.

## Step 1: Pin the environment

```sh
clang --version; clang -O2 -### -c t.c 2>&1 | tail -1   # driver expands the real cc1 flags
clang -print-target-triple
```

Check that `clang`, `opt`, `llc` and `alive-tv` come from the same LLVM build; mixing versions produces bitcode/IR mismatches that look like bugs. cea: `environment_report` records paths and versions of every provider and flags mixed LLVM versions. Cite it in the final report.

## Step 2: Reproduce and reduce the trigger to a command line

Get one deterministic command pair: the good build and the bad build, differing in as few flags as possible (ideally only `-O0` vs `-O2`, or `-O1` vs `-O2`). Remove inputs, environment variables, threads and timing dependence. If the failure is intermittent, it is probably a data race or uninitialised memory, not a deterministic miscompile.

## Step 3: Rule out undefined behaviour first

Run sanitizers at `-O0` and `-O1` (higher levels can optimise the UB away before the check runs):

```sh
clang -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=all t.c && ./a.out
clang -O1 -g -fsanitize=memory -fsanitize-memory-track-origins t.c && ./a.out   # Linux, clang only
clang -O1 -g -fsanitize=thread t.c && ./a.out                                  # if threads exist
```

cea: `check_ub` runs the sanitizer builds and lists, in `limitations` and `unknowns`, what they cannot see. `triage_miscompile` runs it first and stops if UB is found.

What sanitizers do **not** see, and what to do instead:

| Blind spot | Why | Extra check |
|---|---|---|
| Strict aliasing violations | ASan/UBSan do not track effective types | `-fno-strict-aliasing` probe (below); read the code for type-punning through pointers; recent clang has an experimental `-fsanitize=type`, check your version |
| Unsequenced side effects (`i = i++ + 1`) | resolved at compile time, no runtime check | `-Wall` (`-Wunsequenced` in clang, `-Wsequence-point` in GCC) |
| Uninitialised reads | ASan/UBSan do not track definedness | MSan (Linux), Valgrind memcheck, `-ftrivial-auto-var-init=pattern` probe |
| Data races | only TSan sees them | TSan; race-free proof by design |
| Paths not executed | sanitizers are dynamic | run every input that matters; record uncovered paths in `coverage` |
| Library or inline-asm UB | uninstrumented code | rebuild dependencies with sanitizers or isolate them |

**Semantic probes.** Rebuild the failing configuration with one extra flag at a time:

```sh
clang -O2 -fwrapv t.c                         # signed overflow defined as wrapping
clang -O2 -fno-strict-aliasing t.c            # type-based alias analysis off
clang -O2 -fno-delete-null-pointer-checks t.c # null checks after dereference kept
clang -O2 -ftrivial-auto-var-init=pattern t.c # uninitialised locals get a fixed pattern
```

If the behaviour returns to the `-O0` result under a probe, that is strong evidence (inferred, not proven) that the program relies on the corresponding UB: signed overflow, aliasing through incompatible types, dereference-before-null-check, or uninitialised reads. Fix the program, not the compiler. If no probe changes anything, UB is less likely but still possible (out-of-bounds access that happens not to crash, lifetime bugs, races).

## Step 4: Differential testing

Compare across levels and compilers. One compiler disagreeing with all others at the same level is a signal; all `-O2` builds disagreeing with all `-O0` builds points back at UB.

```sh
for cc in clang gcc; do for o in -O0 -O1 -O2 -O3; do
  $cc $o t.c -o t.$cc$o && ./t.$cc$o > out.$cc$o; done; done
md5sum out.*
```

cea: `differential_run` builds and runs each configuration, normalises output, and records which configurations agree. Godbolt (godbolt.org) is useful for quick cross-version checks, but it sends code to a third party; ask before using it on private code.

## Step 5: Pass bisection

LLVM numbers each pass execution; `-opt-bisect-limit=N` runs only the first N and skips the rest (passes that are required for correctness are never skipped).

```sh
clang -O2 -mllvm -opt-bisect-limit=-1 t.c 2>&1 | grep BISECT | wc -l   # count executions
clang -O2 -mllvm -opt-bisect-limit=500 t.c && ./a.out                    # then binary search on N
opt -O2 -opt-bisect-limit=500 t.ll -S -o t.opt.ll                        # same on IR
```

For Rust, pass the flag with `-C llvm-args=-opt-bisect-limit=N`. GCC has no direct equivalent; `-fdisable-tree-<pass>`, `-fdisable-rtl-<pass>` and debug counters (`-fdbg-cnt=`) serve similar purposes. cea: `bisect_passes` automates the search and records the first N where the output flips and the pass named at N.

Caveats, all of which `bisect_passes` repeats in its result:

- The first pass that flips the output may only **expose** a fault: an earlier pass may have produced IR with a wrong flag (`nsw`, `inbounds`, metadata) that the flipping pass trusted correctly; or the flipping pass is fine and a later pass or the backend mis-handles what it produced.
- Bisection skips code generator passes only partially; a backend fault can show up as "all IR passes run, still fails".
- Skipping passes changes the pipeline the remaining passes see. The result is a hypothesis about where to look, not a verdict.

## Step 6: Reduce with a strict interestingness test

Reduce source with `cvise`/`creduce`, or IR with `llvm-reduce`. The interestingness test decides everything. A loose test ("output differs") lets the reducer drift into a different bug, usually into fresh UB, because UB is the easiest way to make outputs differ. A strict test checks all of:

1. The bad build reproduces the **same** failure (same wrong output or same crash signature).
2. The good build (`-O0`) still gives the **original** good output.
3. The candidate is still UB-free: sanitizer build clean, `-Wall -Werror=uninitialized` or similar warnings clean, and preferably the `-fwrapv` / `-fno-strict-aliasing` probes still fail.
4. It compiles with both compilers without new warnings that signal UB.

```sh
#!/bin/sh   # interesting.sh, exit 0 = keep
clang -O0 -w t.c -o g && ./g > g.out 2>&1 || exit 1
grep -qx 'result: 42' g.out || exit 1          # original good output
clang -O1 -fsanitize=address,undefined -fno-sanitize-recover=all t.c -o s && ./s >/dev/null 2>&1 || exit 1
clang -O2 -w t.c -o b && ./b > b.out 2>&1
grep -qx 'result: 41' b.out                     # original bad output
```

Add timeouts to every run so infinite loops created by the reducer are rejected. cea: `reduce_testcase` builds the test from the pinned good and bad outputs or crash signature and keeps a UB check inside it.

## Step 7: Read the IR around the culprit pass

```sh
clang -O2 -Xclang -disable-llvm-passes -S -emit-llvm t.c -o t.ll   # unoptimised but not optnone
opt -O2 -print-before=<pass> -print-after=<pass> -filter-print-funcs=f t.ll -disable-output 2>&1
opt -O2 -print-changed t.ll -disable-output 2>&1 | less
```

Do not use `-O0` IR directly with `opt`: it carries `optnone` and most passes skip it. Use `-O0 -Xclang -disable-O0-optnone` or the `-disable-llvm-passes` form above. cea: `pass_timeline` records which passes changed which function, with the IR before and after as views; `emit_ir` captures the input IR.

Look for: a flag added without justification, a load moved across a store that may alias, a loop trip count computed wrongly, a `select`/`and` swap that introduces poison. See the [IR guide](ir-and-optimization.md).

## Step 8: Validate the transformation

Extract the function before and after the suspect pass and check refinement:

```sh
alive-tv before.ll after.ll
```

A counterexample from Alive2 for a single pass on UB-free input is the strongest evidence of a compiler bug that this workflow can produce. "Transformation seems to be correct" is bounded: loops are unrolled only a few times, calls are abstract, and timeouts are reported as such, not as success. cea: `validate_transform` records the verdict and any counterexample. The online instance at alive2.llvm.org needs no install but sends the IR to a server.

## Step 9: When the compiler changed between versions

If version A works and version B fails, bisect the compiler's history: `git bisect run ./build-and-test.sh`, where the script builds the compiler, runs the strict interestingness test, and exits 125 when the build itself fails. cea: `bisect_compiler_history` runs the bisection with the build command you pass and records each step.

## The composite

`triage_miscompile` chains `environment_report` → `check_ub` → `differential_run` → `bisect_passes` → `reduce_testcase` → `pass_timeline` → `validate_transform`, and stops at the first step that ends the investigation (UB found, no difference reproduced, tool unavailable). Read every intermediate evidence record; the composite summary is never stronger than its weakest step.

## Is it really a compiler bug?

Call it a compiler bug only when all hold: the reduced program is UB-free by sanitizers, warnings and the probes; two or more compilers or levels agree on the correct output; a specific pass or commit is implicated; and ideally Alive2 gives a counterexample or the IR diff shows an unjustified change. An upstream report must contain:

- the reduced test (source and, for LLVM, the `.ll` that reproduces with `opt` or `llc` alone);
- exact compiler version (including commit), full command line, target triple;
- expected output, actual output, and why the expected one is correct;
- what was done to rule out UB;
- the bisected pass and/or commit, and the Alive2 output if available.

Search the tracker for duplicates first. Do not file reports for unreduced or unverified cases.

## Stop conditions

- UB found: stop, fix the program, report the UB with its evidence ID.
- The difference does not reproduce deterministically: stop, investigate races and uninitialised memory.
- Reduction drifts (good output changes, sanitizer fires): tighten the test and restart from the last good candidate.
- A required tool is `unavailable`: record the gap with `record_unknown` and say which conclusion it blocks.
- Time budget spent: report what is observed, what is inferred, and what is unknown. Do not upgrade "suspected" to "confirmed".

## Checklist before you conclude

- [ ] Version, flags and target are stated and backed by an `environment_report` evidence ID.
- [ ] `check_ub` ran on the original and on the reduced case; its limitations are quoted, not ignored.
- [ ] Semantic probes (`-fwrapv`, `-fno-strict-aliasing`, `-fno-delete-null-pointer-checks`, `-ftrivial-auto-var-init=pattern`) were tried and their outcomes recorded.
- [ ] The interestingness test pins good output, bad output and UB-freedom.
- [ ] Pass bisection is presented as "first flipping pass", not "buggy pass", unless Alive2 or the IR diff confirms it.
- [ ] Observed, inferred and unknown are listed separately, each item with an evidence ID.
- [ ] No claim of "compiler bug" without a reduced, UB-free, independently reproducible case.
