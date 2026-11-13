# Correctness tools

These tools answer "is the compiler wrong, or is my program?": `check_ub`, `differential_run`, `bisect_passes`, `reduce_testcase`, `validate_transform`, `fuzz_compiler` and `bisect_compiler_history`. The composite tool that chains most of them is described in [triage.md](triage.md).

The usual order is: `check_ub` first (a program with undefined behaviour has no correct output for the optimiser to preserve), then `differential_run` to see which configurations disagree, then `bisect_passes`, `reduce_testcase` and `validate_transform` to narrow down and check the transformation.

The shared input objects (`source`, `flags`, `run`, optimisation levels, timeouts and the unsafe-flag rule) are defined in [tools-compile.md](tools-compile.md). Provider installation is in [tools-environment.md](tools-environment.md).

A note on status: for most tools here, "the program misbehaves" is a finding, so the record's status is `ok`. Status is `inconclusive` when the tool could not reach an answer (nothing built, nothing reproduced, no verdict), and `error` or `unavailable` when it did not run.

## check_ub

### What it does and when to use it

Builds the program with sanitizers at several optimisation levels, runs each build, and returns every finding with its source location. By default it builds with UBSan and ASan (`undefined,address`) at `O0` and `O1`; MSan (`memory`) is a separate build because it cannot be combined with ASan. For a Rust cargo project it runs `cargo miri run` instead.

Run it before you blame a compiler. If it finds undefined behaviour, a difference between optimisation levels is permitted by the language and is not evidence of a compiler bug.

Each build uses `-g -fsanitize=... -fno-sanitize-recover=all -fno-omit-frame-pointer -Wall -Wextra` plus your flags. The program runs with `UBSAN_OPTIONS`, `ASAN_OPTIONS` and `MSAN_OPTIONS` set to stop at the first error. If a sanitizer combination does not link on the toolchain, cea retries with fewer sanitizers and records the limitation. If the source does not compile, that is reported per build.

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `source` | object | required | The program. See the note on `cargo_project` below. |
| `compiler` | string | `"clang"` | clang or gcc. rustc is refused (`UNSUPPORTED`); use `cargo_project`. |
| `flags` | string[] | `[]` | Extra flags (defines, `-std=...`). Do not pass an `-O` level; use `opt_levels`. |
| `opt_levels` | array of levels | `["O0","O1"]` | One to four optimisation levels. |
| `sanitizers` | array of `undefined`, `address`, `memory` | `["undefined","address"]` | Sanitizers to use. `memory` is tried as a separate build. |
| `run` | object | `{"args":[],"timeout_s":10}` | How to run each build; see [tools-compile.md](tools-compile.md). |
| `cargo_project` | string | none | Rust only: path to a cargo project to run under Miri instead of `source`. The schema still requires `source`; it is not read when `cargo_project` is set. |

### Key result fields

| Field | Meaning |
|---|---|
| `clean` | `true` if no finding, `false` if findings, `null` if no sanitizer build could be produced. |
| `findings` | Up to 50 distinct findings. Each has `sanitizer` (ubsan, asan, msan, miri), `kind`, `message`, `file`, `line`, `column`, `opt_level`. |
| `findings_total` | Number of distinct findings before the cut at 50. |
| `builds` | One entry per build attempted: `id`, `opt_level`, `sanitizers`, `built`, `outcome`, `findings`, `stderr_preview`, and `reason` when it did not build. |
| `compiler` | `path`, `version`, `target`. |
| `compiler_warnings` | Up to 30 distinct compiler warnings from the builds (`-Wall -Wextra`), which often point at the same bug. |

For Miri the result has `clean`, `findings`, `exit_code` and `stderr_preview`. Status is `inconclusive` when no build could be produced.

### Example

```json
{
  "source": { "path": "examples/01-ub-not-a-compiler-bug/overflow.c" },
  "compiler": "clang",
  "opt_levels": ["O0", "O1"],
  "sanitizers": ["undefined", "address"]
}
```

```sh
cea check_ub --input input.json
```

See [../examples/01-ub-not-a-compiler-bug/](../examples/01-ub-not-a-compiler-bug/).

### Limitations it records

- Sanitizers only see undefined behaviour on the paths the given input executes; a clean run is not proof of UB-freedom.
- Not detected by UBSan or ASan: strict-aliasing violations, unsequenced modifications, most uninitialised reads (needs MSan), data races (needs TSan), and UB the frontend folded away before instrumentation.
- If a sanitizer combination did not link, the retry with fewer sanitizers is recorded.
- Unknowns are added when a build timed out, or exited non-zero with no sanitizer report.

### What it does not tell you

A clean result does not mean the program has no undefined behaviour. Example [../examples/05-ub-sanitizers-cannot-see/](../examples/05-ub-sanitizers-cannot-see/) prints different values at `-O0` and `-O2` while both sanitizers stay silent, because it breaks the strict aliasing rule.

## differential_run

### What it does and when to use it

Compiles the same program with several compilers and optimisation levels, runs each build, and groups configurations by observed behaviour (exit outcome plus the SHA-256 of stdout). Each build runs twice, so a program that is non-deterministic by itself is not mistaken for a compiler difference.

Use it to find which configurations disagree, and to confirm that a reported difference reproduces.

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `source` | object | required | The program. |
| `compilers` | string[] | all available | One to eight compilers. Default: every available C compiler (clang, gcc), or rustc for Rust. |
| `opt_levels` | array of levels | `["O0","O1","O2","O3","Os"]` | One to seven levels. |
| `flags` | string[] | `[]` | Flags added to every build. |
| `extra_configs` | array of `{compiler, flags}` | `[]` | Additional exact configurations, up to 16, for example `{"compiler":"clang","flags":["-O2","-fwrapv"]}`. Their flags are used as given, with no level added. |
| `run` | object | `{"args":[],"timeout_s":10}` | How to run each build. |

### Key result fields

| Field | Meaning |
|---|---|
| `divergent` | `true` if more than one distinct behaviour was seen. |
| `behaviours` | Groups: `outcome`, a 16-character prefix `stdout_sha256`, and the `configs` in the group. Largest group first. |
| `configs` | One row per configuration: `id`, `compiler`, `flags`, `built`, `outcome`, `stdout_sha256`, `stable_across_reruns`, previews of stdout and stderr; `compiler_crashed` and `stderr_preview` when it did not build. |
| `failed_builds` | Number of configurations that did not build. |
| `nondeterministic` | Ids of configurations whose output changed between the two runs of one binary. |

Status is `inconclusive` if no configuration built. Configuration ids look like `clang-O2` and `extra1-clang-...`.

### Example

```json
{
  "source": { "path": "examples/01-ub-not-a-compiler-bug/overflow.c" },
  "compilers": ["clang"],
  "opt_levels": ["O0", "O2"],
  "extra_configs": [{ "compiler": "clang", "flags": ["-O2", "-fwrapv"] }]
}
```

```sh
cea differential_run --input input.json
```

### Limitations it records

- One input only. Divergence on other inputs is not covered.
- Agreement across configurations does not show the output is correct, only that these builds agree on this input.
- If the builds disagree, an unknown records that disagreement does not show which side is right, and an inference notes that the difference is expected for programs with undefined, unspecified or implementation-defined behaviour.
- If a build is non-deterministic on its own, that is recorded and the differences are not attributable to the compiler.

### What it does not tell you

It does not tell you which behaviour is correct, or whether the program is free of undefined behaviour. Run `check_ub` for the latter.

## bisect_passes

### What it does and when to use it

Binary-searches clang's `-opt-bisect-limit` to find the first optimisation pass whose execution flips the program from the reference behaviour to the bad behaviour. In `crash` mode it finds the first pass at which the compiler itself crashes. For GCC, which has no bisect limit, it instead disables the enabled `-f` optimisation flags one at a time and reports which ones restore the reference behaviour.

Use it when you have a reproducible difference and want to know which pass to look at. The result names a pass; it does not prove the pass is wrong.

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `source` | object | required | The program. |
| `compiler` | string | `"clang"` | clang or gcc. |
| `flags` | string[] | `["-O2"]` | The configuration that misbehaves. |
| `mode` | `behavior` or `crash` | `"behavior"` | `behavior`: output differs from the reference. `crash`: the compiler itself crashes. |
| `reference_flags` | string[] | `["-O0"]` | `behavior` mode: the configuration whose output is the reference. |
| `expected_stdout` | string | none | `behavior` mode: use this as the reference output (with exit code 0) instead of running `reference_flags`. |
| `crash_signature` | string | none | `crash` mode: substring that must appear in the compiler's stderr for a crash to count as the same crash. |
| `run` | object | `{"args":[],"timeout_s":10}` | How to run each build. |
| `timeout_s` | integer | `600` | Budget for the whole bisection. Exceeding it ends the tool with `TIMEOUT`. |

### Key result fields

For clang:

| Field | Meaning |
|---|---|
| `reproduced` | Whether the bad configuration misbehaves at all. |
| `method` | `opt-bisect-limit`. |
| `total_passes` | How many numbered passes ran with all passes enabled. |
| `last_good_limit`, `first_bad_limit` | Adjacent limits: the first gives the reference behaviour, the second the bad behaviour. |
| `culprit` | The pass that runs at `first_bad_limit`: `n`, `pass`, `unit`. |
| `previous_pass` | The pass at `last_good_limit`. |
| `search` | The binary-search trail: `limit`, `bad`, `detail`. |
| `builds` | Number of builds made. |
| `repro_flags` | `good` and `bad` flag lists that reproduce each side by hand. |

For GCC: `reproduced`, `method` (`gcc-flag-scan`), `flags_scanned`, `flags_enabled`, `fixing_flags`, `builds`.

Status is `inconclusive` when the bad configuration does not misbehave, when no bisectable passes ran (an `-O0` build), or when the bad behaviour persists with every optional pass skipped (`culprit` is then null; suspect the frontend, a required pass, or the flags themselves).

### Example

```json
{
  "source": { "path": "examples/05-ub-sanitizers-cannot-see/alias.c" },
  "compiler": "clang",
  "flags": ["-O2"],
  "reference_flags": ["-O0"]
}
```

```sh
cea bisect_passes --input input.json
```

### Limitations it records

- `-opt-bisect-limit` only skips optional passes, and skipping changes what later passes see; the search assumes a single good-to-bad flip.
- The first flipping pass may only expose a fault in the program, a later pass or the backend. An unknown records that the pass itself may be a correct transformation.
- GCC: the scan tests one flag at a time, so a fault that needs two optimisations together, or one with no `-f` switch, is not found. If the time budget ran out, the flags not scanned are listed as a limitation.
- Rust is not supported (`UNSUPPORTED`).

### What it does not tell you

It does not tell you that the named pass is buggy. Use `validate_transform` on the IR before and after that pass, and `check_ub` and the semantic probe in [triage.md](triage.md) to rule out the program.

## reduce_testcase

### What it does and when to use it

Generates a strict interestingness test and shrinks the test case with cvise, creduce or llvm-reduce, or with a built-in line reducer when none of those is installed. It handles two kinds of failure: a `miscompile` (two configurations behave differently) and a `crash` (the compiler itself crashes).

Reduction is only as trustworthy as the test that guides it. A loose test lets a reducer drift: the program gets smaller, but the difference it shows is no longer your bug, or the program has gained undefined behaviour. The generated test exists to prevent that.

### The interestingness test, `interesting.mjs`

cea writes the test as a self-contained Node script, `interesting.mjs`, not as a shell script. The same file works on every platform, and no value is ever interpolated into a shell command line. It is stored as a view of the record and as a file in the work directory (`script_path`).

How to use it:

- `node interesting.mjs [candidate-file]` checks one candidate. Without an argument it checks the file named `input` plus the original extension (for example `input.c`) in the current directory.
- Exit code 0 means "still interesting" (the candidate still shows the same failure). Exit code 1 means it does not.
- Set `CEA_INTERESTING_VERBOSE=1` to print why a candidate was rejected.
- The script contains its own configuration: the list of steps, with the exact compiler argv for each. `{file}` stands for the candidate and `{out:name}` for a temporary output path.

For a miscompile, the test holds three guarantees:

1. **No drift into undefined behaviour.** The candidate must still compile at `-O0 -g` with `-fsanitize=undefined,address` (or `undefined` alone if ASan does not link), `-fno-sanitize-recover=all` and a set of hard errors (`-Werror=implicit-function-declaration`, `-Werror=implicit-int`, `-Werror=return-type`, `-Werror=int-conversion` for C; `-Werror=return-type` otherwise). Running it must print no UBSan, ASan or MSan report, must not be killed, and must exit with the same status as the original sanitized run. The original is checked first, and if it already has a sanitizer finding the tool stops with `INVALID_INPUT` and tells you to fix the program.
2. **Same reference output, same bad output.** With the default `strictness`, the reference build must still produce the exact exit status and stdout hash of the original reference run, and the bad build must still produce the exact exit status and stdout hash of the original bad run. This prevents the reducer from drifting to a different bug.
3. **Still a difference.** The reference run and the bad run must differ from each other.

If no sanitizer build links with this compiler, guarantee 1 cannot be given. The test then falls back to a strict build (`-O0` with the hard errors above and `-Werror=uninitialized`), the `ub_guard` result field is `none`, and a limitation says to treat the reduced case with suspicion and run `check_ub` on it with another compiler. With `strictness` set to "any_divergence", guarantee 2 is dropped: the reduction goes further but may land on a different bug.

For a `crash`, the test requires that the compiler crashes (a signal, or crash text such as a stack dump, an assertion failure, `LLVM ERROR` or an internal compiler error) and that the stderr still contains the crash signature. Compilation that merely fails with a normal error is not interesting.

Before reducing, cea runs the test on the original and stops with `TOOL_FAILED` if the original is not interesting (the failure is probably flaky or depends on the file path). After reducing, it runs the test again on what the reducer left behind. If that fails, the original is returned, `verified` is false and the status is `inconclusive`.

### Crash signatures

If you do not pass `crash_signature`, cea derives one from the original crash output. It prefers assertion text (`Assertion ... failed`), `LLVM ERROR: ...`, `internal compiler error: ...`, `UNREACHABLE executed` or a backend fatal error line. If there is none, it uses the innermost symbolised stack frame that is not signal-handler or libc plumbing. If even that is missing, it falls back to the generic marker "internal compiler error" or "PLEASE submit a bug report"; this is weak and a limitation records that the reduction may end on a different crash. A `crash_signature` you pass must appear in the original crash output, otherwise the tool refuses.

### Reducer choice

With `reducer` set to `auto` (the default):

- LLVM IR input: `llvm-reduce` if available.
- Anything else: `cvise` if available, otherwise `creduce`.
- Otherwise the built-in reducer, with a limitation noting that it is weaker.

You can force `cvise`, `creduce`, `llvm-reduce` or `builtin`. A forced reducer that is not installed gives `PROVIDER_UNAVAILABLE`.

The built-in reducer is delta debugging over whole lines. It has no dependencies and runs everywhere, but it cannot rewrite expressions or rename things, so the result is larger than cvise would give. It stops at `max_tests` tests or after `timeout_s` seconds, whichever comes first, and records that the result is not minimal if it ran out of budget. For cvise and creduce, cea also writes a small `interesting.sh` wrapper (a view of the record) that runs the Node test, because those reducers expect an executable.

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `source` | object | required | The test case. |
| `kind` | `miscompile` or `crash` | required | What the failure is. |
| `compiler` | string | `"clang"` | The compiler under suspicion. |
| `flags` | string[] | `["-O2"]` | The configuration that misbehaves or crashes. |
| `reference_flags` | string[] | `["-O0"]` | `miscompile`: the configuration that behaves correctly. |
| `crash_signature` | string | derived | `crash`: substring of the compiler's stderr that identifies this crash. |
| `run` | object | `{"args":[],"timeout_s":10}` | How to run the test program. |
| `strictness` | "same_outputs" or "any_divergence" | "same_outputs" | The first pins both the reference and the bad output; the second only demands that they differ. |
| `reducer` | `auto`, `cvise`, `creduce`, `llvm-reduce`, `builtin` | `"auto"` | Which reducer to use. |
| `timeout_s` | integer | `300` | Budget for the reduction itself. |
| `max_tests` | integer | `2000` | Built-in reducer: maximum number of interestingness tests, up to 100000. |

### Key result fields

| Field | Meaning |
|---|---|
| `verified` | `true` when the reduced case passes the test when re-run. |
| `reducer`, `kind` | What was used and the failure kind. |
| `before`, `after` | `bytes` and `lines` before and after. |
| `tests_run` | Number of tests the built-in reducer ran; `null` for external reducers. |
| `budget_exhausted` | The reducer stopped on its time or test budget; the result is not minimal. |
| `ub_guard` | `sanitizers`, `none`, or `not applicable` (crash kind). |
| `interestingness` | A one-sentence description of what the test demands. |
| `script_view`, `script_path` | The generated `interesting.mjs`. |
| `reduced_view`, `reduced_path`, `reduced_source` | The reduced case (view, path and a preview). |

### Example

This is the example from [../examples/04-crash-reduction/](../examples/04-crash-reduction/).

```json
{
  "source": { "path": "examples/04-crash-reduction/crash.c" },
  "kind": "crash",
  "compiler": "clang",
  "flags": ["-O2"]
}
```

```sh
cea reduce_testcase --input input.json
```

### Limitations it records

- A reduced case reproduces the failure the test describes, nothing more. If the test is loose, the reduced case may show a different problem than the original.
- If the budget ran out, the result is not minimal.
- If no sanitizer links, the UB guard is missing (see above).
- For a miscompile with a sanitizer guard, an unknown notes that the reduced program may still have undefined behaviour that sanitizers cannot see (strict aliasing, unsequenced modification, uninitialised reads).

### What it does not tell you

It does not tell you why the failure happens, or that the reduced case is free of undefined behaviour. Run `check_ub` on it, and keep the original.

## validate_transform

### What it does and when to use it

Uses Alive2 (`alive-tv`) to check that the "after" IR refines the "before" IR, and returns pass or fail with a counterexample. This is the only tool here that can show a rewrite is wrong for some input, rather than just different on one input. Use it on the IR before and after a pass, for example the two sides of the culprit found by `bisect_passes`, or on a hand-written `@src` and `@tgt` pair.

### Two ways to supply the IR

- `before` and `after`: two modules, each a `source` object. Code given inline defaults to the language `llvm-ir`.
- `pair`: one module that defines `@src` and `@tgt` (alive-tv's single-file mode).

Give either `pair` or both `before` and `after`, not a mix.

### Local alive-tv or the remote provider

`provider` selects where the check runs:

- `local` runs your `alive-tv` binary (see [tools-environment.md](tools-environment.md)). Nothing leaves your machine.
- `remote` sends the IR to the Alive2 project's own Compiler Explorer instance at `https://alive2.llvm.org/ce` and runs `alive-tv` there. This is opt-in: it is refused with `REMOTE_DISABLED` unless the environment variable `CEA_REMOTE_PROVIDERS` contains `compiler-explorer`. The environment variable `CEA_ALIVE2_CE_URL` can point it at another instance.
- `auto` (the default) uses the local binary if there is one, and otherwise the remote provider. If the remote provider is not enabled, the tool reports `alive-tv` as unavailable and includes the fix.

In remote mode with `before` and `after`, cea builds one combined module: the target data layout and triple, type definitions, the two functions renamed `@src` and `@tgt`, and only the globals, declarations, metadata and attribute groups they reach. The after module's numbered metadata and attribute groups are shifted so that two modules can share one file. The function name must be given in `function` unless the before module defines exactly one function. With `pair`, the whole module you supply is sent, with the module id, source file name and debug-info file paths replaced. The exact text sent is kept as the view `alive-input.ll`, and the answer as `alive-output.txt`.

The remote alive-tv is built against LLVM trunk, which may differ from your local LLVM in details of IR semantics; a limitation records this.

### Alive2 does not model `!tbaa`

Alive2 does not model type-based alias analysis. IR that carries `!tbaa` metadata is rejected or checked without it, so a transformation that is only valid under the strict aliasing rule cannot be verified, and may even be reported as incorrect. The result field `uses_tbaa` is `true` when the compared IR contains `!tbaa`. When a verdict is missing and `uses_tbaa` is true, the summary and the unknowns say that the IR uses `!tbaa` and that Alive2 cannot judge it. Do not read an "incorrect" on such IR as a compiler bug without checking the program against the aliasing rule; [triage.md](triage.md) shows how `triage_miscompile` handles this.

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `before` | `source` object | none | IR before the transformation. |
| `after` | `source` object | none | IR after the transformation. |
| `pair` | `source` object | none | Alternative: one IR module containing `@src` and `@tgt`. |
| `function` | string | none | Function to compare when the modules define several. Required for the remote provider with `before` and `after` when the module defines more than one. With the local provider it filters the reported pairs. |
| `provider` | `auto`, `local`, `remote` | `"auto"` | Where to run Alive2. |
| `smt_timeout_s` | integer | `60` | SMT solver timeout per query, 1 to 600. |
| `extra_args` | string[] | `[]` | Extra alive-tv options such as `--disable-undef-input`. Each must look like an option (start with `-`), not a path; at most 10. |

### Key result fields

| Field | Meaning |
|---|---|
| `verdict` | `correct`, `incorrect` or `inconclusive`. |
| `uses_tbaa` | Whether the compared IR carries `!tbaa`. |
| `provider` | Which alive-tv ran: local path and version, or the remote host. |
| `pairs` | Up to 30 compared functions: `function`, `verdict` (`correct`, `incorrect` or `unproven`), `error`, `counterexample`. |
| `counts` | `correct`, `incorrect`, `unproven`. |
| `alive_summary` | The totals alive-tv printed, when it printed them. |
| `output_preview` | Only when no pair was parsed: the start of alive-tv's output. |

The verdict is `incorrect` if any pair is incorrect, `inconclusive` if there is no pair or any pair is unproven (timeout, out of memory, unsupported feature), otherwise `correct`. Status is `inconclusive` when the verdict is.

### Example

This is the example from [../examples/03-alive2-counterexample/](../examples/03-alive2-counterexample/): a deliberately wrong rewrite of `(x + 1) > x` to `true`.

```json
{ "pair": { "path": "examples/03-alive2-counterexample/wrong.ll" }, "provider": "local" }
```

```sh
cea validate_transform --input input.json
```

### Limitations it records

- Alive2 is bounded: loops are unrolled a fixed number of times, so a counterexample needing more iterations is missed.
- It checks one function at a time (no interprocedural reasoning) and approximates memory, calls and some intrinsics. "Correct" means no counterexample within those limits.
- It does not model `!tbaa` (see above).
- Remote mode: the combined module is built textually; calls from the function to itself still name the original symbol; the remote build is LLVM trunk. The record also observes that IR was sent to the remote host.

### What it does not tell you

A `correct` verdict does not show the program is correct or that the pass is correct in general: only that these functions refine each other within Alive2's bounds. An `incorrect` verdict on IR that uses `!tbaa` is not a compiler bug until you have ruled out strict aliasing violations. Code generation (backend) passes cannot be checked by this tool at all.

## fuzz_compiler

### What it does and when to use it

Runs a time-boxed differential fuzzing campaign. It generates random C programs with Csmith or YARPGen, builds each with several compilers and optimisation levels, runs them, and saves every program whose builds disagree, or that crashes a compiler, as a candidate with its seed. A program that does not terminate within `program_timeout_s` is skipped, because that says nothing about the compiler.

A candidate is a lead, not a bug report. Run `check_ub` and `reduce_testcase` on it next.

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `generator` | `auto`, `csmith`, `yarpgen` | `"auto"` | `auto` prefers Csmith, then YARPGen. |
| `duration_s` | integer | `60` | Wall-clock budget for the campaign, 1 to 3600. |
| `max_programs` | integer | `200` | Upper bound on programs attempted, up to 100000. |
| `compilers` | string[] | all available | One to six compilers. Default: every available C compiler (clang, gcc). |
| `opt_levels` | array of levels | `["O0","O2"]` | One to six levels. At least two configurations in total are required. |
| `flags` | string[] | `[]` | Extra flags for every build. |
| `seed_start` | integer | clock-derived | First seed; seeds increase by one. The value used is reported. |
| `program_timeout_s` | integer | `10` | Per-program run timeout, 1 to 120. |
| `generator_args` | string[] | `[]` | Extra options for the generator. Each must look like an option, not a path; at most 20. |

### Key result fields

| Field | Meaning |
|---|---|
| `generator`, `seed_start` | The generator used and the first seed. |
| `programs_generated` | Programs the generator produced. |
| `programs_compared` | Programs that built and ran in time and were compared. |
| `skipped_timeout` | Programs skipped for non-termination. |
| `generator_failures` | Seeds for which the generator failed. |
| `candidates` | One entry per candidate: `seed`, `kind` ("divergence" or "compiler_crash"), `path`, `behaviours`, `crash_config`, `crash_preview`. |
| `candidates_dir` | Where candidate sources are saved: `candidates/<evidence_id>/seed-N/` in the session directory, with a `candidate.json` for each. `null` when there were none. |
| `configs` | The configurations compared. |

A "divergence" is any disagreement among the builds of one program, which includes some builds succeeding and others failing; look at `behaviours` before assuming the outputs differ.

Csmith needs its runtime header `csmith.h`. cea looks in `CEA_CSMITH_INCLUDE` and a few standard locations, and refuses with `PROVIDER_UNAVAILABLE` if it finds none.

### Example

```json
{
  "generator": "csmith",
  "duration_s": 120,
  "compilers": ["clang", "gcc"],
  "opt_levels": ["O0", "O2"],
  "seed_start": 1000
}
```

```sh
cea fuzz_compiler --input input.json
```

### Limitations it records

- Random differential testing samples the input space; finding nothing in a short campaign says very little about compiler correctness.
- Csmith and YARPGen aim to generate UB-free programs, but candidates must still pass `check_ub` before they are treated as miscompiles.
- With candidates present, an unknown notes that which build is wrong, and whether the program is UB-free, is not established.

### What it does not tell you

It does not tell you which build is right, and a campaign with no candidates does not show the compilers agree in general.

## bisect_compiler_history

### What it does and when to use it

Drives `git bisect run` on a compiler checkout to find the commit that introduced a failure. You give a good revision, a bad revision, an optional build command and a test command. Typically the test command is the generated `interesting.mjs` from `reduce_testcase`, run on a reduced case with the compiler you just built.

The checkout must have no uncommitted changes to tracked files and no bisection in progress. After the run, cea always runs `git bisect reset`, which returns the checkout to the commit or branch it started on.

### What the helper does

cea writes a small Node script, `bisect-runner.mjs` (a view of the record), and passes it to `git bisect run`. For each commit it runs the build command, if any, and treats a failed build as "cannot test this commit" (git skips it). It then runs the test command and maps the exit code: with the default `test_exit_zero_means` of "bad", exit 0 means the commit is bad and any other exit code means good, which matches the interestingness tests cea generates (they exit 0 when the failure is present). A test that cannot be started or times out also skips the commit.

The build and test commands are executed as you give them. They are your declared inputs, and they can do anything your user can do. See [../SECURITY.md](../SECURITY.md).

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `repo` | string | required | Path to the compiler's git checkout. |
| `good` | string | required | A revision where the test case behaves correctly. |
| `bad` | string | required | A revision where the failure occurs. `good` must be an ancestor of `bad`. |
| `build` | string[] | none | argv array that builds the compiler at the current commit, run in the repo. A failing build skips the commit. |
| `test` | string[] | required | argv array that tests the built compiler. Use absolute paths. |
| `test_exit_zero_means` | "bad" or "good" | "bad" | Which verdict an exit code of 0 from `test` means. |
| `build_timeout_s` | integer | `3600` | Per-build timeout, up to 86400. |
| `test_timeout_s` | integer | `120` | Per-test timeout, up to 3600. |
| `timeout_s` | integer | `21600` | Budget for the whole bisection, up to 604800 (7 days). |

Revisions may not start with a dash and may only contain letters, digits and `._/~^@{}-`.

### Key result fields

| Field | Meaning |
|---|---|
| `first_bad_commit` | The 40-character hash git reported, or `null`. |
| `commit` | Short hash, date, author and subject of that commit. |
| `good`, `bad` | The two revisions resolved to full hashes. |
| `commits_in_range` | Number of commits between them. |
| `skipped` | Commits that could not be built or tested. |
| `timed_out` | Whether the bisection ran out of time. |
| `bisect_output` | Preview of git's output; the full log is the view `bisect-log.txt`. |

Status is `inconclusive` when git did not single out one commit.

### Example

```json
{
  "repo": "/src/llvm-project",
  "good": "llvmorg-17.0.0",
  "bad": "llvmorg-18.1.0",
  "build": ["ninja", "-C", "/src/llvm-project/build", "clang"],
  "test": ["node", "/work/interesting.mjs", "/work/reduced.c"]
}
```

```sh
cea bisect_compiler_history --input input.json
```

### Limitations it records

- Skipped commits mean the first bad commit may be one of a range.
- Bisection assumes the failure appears once and stays; a flaky test, or a bug that was fixed and reintroduced, gives a wrong answer.
- An unknown notes that the commit may be the root cause or may only expose an older bug.

### What it does not tell you

It does not tell you why the commit caused the failure, or that the test was deterministic. Read the change.
