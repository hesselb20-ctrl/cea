# Progress and verification

Status of every requirement in the original brief for v0.1.0. "Verified" means it was run, and says by what. Nothing here is marked done on the strength of having been written.

Local verification machine: Windows 11, Node 26, clang 23.1.5 (llvm-mingw 20261104, target `x86_64-w64-windows-gnu`), LLVM 23.1.5 tools (opt, llc, llvm-reduce, llvm-mca, llvm-mc), GCC 16.2.0 (MinGW-w64), Csmith 2.3.0 (built from source), git 2.53. Not installed locally: rustc, cargo, Miri, FileCheck, alive-tv, cvise, creduce, YARPGen, perf. CI adds Ubuntu with clang, GCC, cvise, creduce and Csmith.

Test suites: `test/unit` (100 tests, providers mocked), `test/docs.test.ts` (10 tests), `test/integration/real.test.ts` (30 tests against real tools).

## 1. Architecture

| Requirement | Status | Verified by |
|---|---|---|
| TypeScript, Node 20+, MCP SDK, package `cea-agents`, `cea` binary | done | build; CI matrix runs Node 20 and 22 |
| Every MCP tool also available as `cea <tool> --json` | done | integration: "cea <tool> --json and --input ..."; unit: "lists the same tools as the registry" |
| Providers are thin adapters; nothing bundled or installed | done | `src/core/toolbox.ts`; unit: toolbox tests |
| Detection and per-tool reporting for clang, opt, llc, llvm-reduce, llvm-mca, llvm-mc, llvm-objdump, FileCheck, GCC, rustc, cargo, Miri, Alive2, cvise, creduce, Csmith, YARPGen, perf | done | unit: "declares every provider the spec asks for"; integration: "reports real providers and their versions"; `cea doctor` |
| Sanitizers via the compiler | done | integration: `check_ub` tests; `environment_report` probes which sanitizers link |
| Compiler Explorer public API as optional remote provider, off by default | partial | Implemented for `validate_transform` against the Alive2 project's Compiler Explorer instance, which is where alive-tv is hosted. Off unless `CEA_REMOTE_PROVIDERS=compiler-explorer`. Unit: "does not use the network unless ..."; run for real in examples 3 and 5. Remote compilation on godbolt.org for `compile` is not implemented. |
| Evidence record with id, operation, inputs, versions, exact commands, target, SHA-256, result, raw output refs, limitations, coverage, unknowns | done | unit: "records inputs, hashes, tool versions, exact commands, target and limitations" |
| Local session store; later calls reference earlier evidence by ID | done (JSONL) | unit: ledger tests; integration: CLI tests share a session across processes |
| Large outputs on disk, paged through `inspect_evidence_view` | done | unit: "pages and filters views ..." |
| Every result distinguishes observed, inferred, unknown | done | fields on every record; asserted across unit tests |

## 2. MCP tools

All tools: strict JSON schemas (unit: "gives every tool a strict object schema"), timeouts and output caps (unit: exec tests), error objects with remediation (unit: "turns invalid input into an error record ...").

| Tool | Status | Verified against real tools | Notes |
|---|---|---|---|
| `environment_report` | done | yes, local and CI | |
| `compile` | done | clang and GCC | rustc path not run against a real rustc |
| `emit_ir` | done | clang, GCC (GIMPLE) | rustc `--emit=llvm-ir,mir` path not run against a real rustc |
| `pass_timeline` | done | clang `-print-changed`, opt pipeline, GCC `-fdump-tree-all` | uses `-print-changed` with `-filter-print-funcs`, which already omits no-op passes |
| `opt_remarks` | done | clang `-fsave-optimization-record`, GCC `-fopt-info-all` | GCC remarks carry no function name; `-Rpass` text output is not parsed |
| `check_ub` | done | clang with UBSan and ASan | MSan and Miri paths are unit-tested with fakes only |
| `differential_run` | done | clang and GCC, five levels | |
| `bisect_passes` | done | clang `-opt-bisect-limit`; GCC flag scan | |
| `reduce_testcase` | done | built-in reducer locally; cvise in CI | llvm-reduce path not exercised end to end |
| `validate_transform` | done | remote alive-tv (examples 3 and 5) | a local `alive-tv` binary was never available; that path is unit-tested with a fake |
| `analyze_throughput` | done | llvm-mca 23.1.5 | |
| `benchmark` | done | clang, example 2 | governor read on Linux only; no hardware counters |
| `fuzz_compiler` | done | Csmith 2.3.0 locally (25 seeds, clang and GCC at -O0 and -O2: 23 compared, 2 skipped for non-termination, 0 candidates) and in CI | YARPGen path written from its documentation, never run |
| `bisect_compiler_history` | done | real git on a generated repository | not run on an actual compiler checkout (needs hours of builds) |
| `record_unknown` / `update_unknown` | done | unit | |
| `export_evidence_bundle` | done | unit and integration | single JSON file plus a Markdown index |
| `inspect_evidence_view`, `list_evidence` | done | unit and integration | `list_evidence` is an addition to the brief |

"Never executes anything outside the declared inputs": tools run resolved provider binaries, binaries compiled from the declared source, and for `bisect_compiler_history` the build and test commands passed in. Flags that load code into the compiler are rejected by default (unit: "rejects flags that load code into the compiler").

## 3. Composite workflow

| Requirement | Status | Verified by |
|---|---|---|
| `triage_miscompile` chains environment, check_ub, differential_run, bisect_passes, reduce_testcase, pass_timeline, validate_transform | done | integration: example 5 runs every step; recorded output in `examples/05-ub-sanitizers-cannot-see/README.md` |
| Stops early and says why | done | integration: "example 1: says UB found, not a compiler bug and stops"; unit: not_reproduced path |
| Draft upstream bug report in Markdown | partial | The report (reproducer, flags, versions, responsible pass, violated invariant, evidence IDs) is generated for every outcome. The "likely compiler bug" branch (Alive2 refutes the culprit transformation) has never fired on a real miscompile, because none was available to reproduce; it is covered by logic and by the unit tests around it only. |

## 4. Skill

| Requirement | Status | Verified by |
|---|---|---|
| `skills/compiler-engineering/SKILL.md` with name, description, version | done | docs test: "has frontmatter ..." |
| Seven reference guides | done | docs test: "has every file the project promises" |
| Routes by task; requires version, flags, target; UB first; no disabled verifiers; variance for speed; evidence IDs; observed/inferred/unknown | done | docs test: "states the rules the project enforces" |
| Readable without the MCP server | done | references give plain commands |
| Reference content technically reviewed | partial | Written with care but not reviewed by a compiler engineer. The FileCheck examples in `verification-and-testing.md` were not run through lit (FileCheck is not installed here). |

## 5. Demo and proof

| Requirement | Status | Verified by |
|---|---|---|
| Example 1: "compiler bug" that is signed-overflow UB | done | run locally and in CI; integration test |
| Example 2: missed vectorisation from aliasing, fixed with `restrict` | done | run locally: 3.55x by median, non-overlapping ranges; integration test checks the remark and the output, not the ratio |
| Example 3: Alive2 counterexample for a wrong rewrite | done | run locally through the remote provider; integration test runs when alive-tv or the remote provider is available (skipped in CI) |
| Example 4: crash reduced to a few lines | done | 88 to 2 lines locally; integration test, also in CI |
| Example 5 (extra): UB that sanitizers cannot see | done | run locally and in CI |
| No invented results; historical bugs only if reproducible | done | all cases are constructed; every number in the example READMEs is from a recorded run with compiler and date stated |
| Recorded terminal demo of `cea triage` on example 1 | done | `docs/demo/triage.cast` (asciicast v2, recorded by `scripts/record-demo.mjs` from a real run) and `docs/demo/triage.gif`. The prompt line is typed by the script; the output and its timing are real. |

## 6. Quality bar

| Requirement | Status | Verified by |
|---|---|---|
| Unit tests for every tool with providers mocked | done | `test/unit/tools.test.ts` |
| Integration tests against real clang and gcc in CI on Ubuntu; skip, do not fail; report skips | done | `.github/workflows/ci.yml`; last integration test prints missing providers |
| Lint and typecheck | done | `npm run lint`, `npm run typecheck`; CI |
| Test that every SKILL.md link and every documented tool exists | done | `test/docs.test.ts` |
| Windows, macOS, Linux path handling; never assume `/tmp` | done for Windows and Linux, partial for macOS | Windows locally; all three in the CI unit matrix. Integration tests do not run on macOS. |
| No network by default | done | unit: fake `fetch` throws unless the remote provider is enabled |
| No shell interpolation | done | unit: "passes arguments verbatim, without a shell" |
| Sandbox runs with timeouts and output limits | partial | Timeouts, output caps, scrubbed environment and per-call work directories are implemented and tested. This is not OS-level isolation, and the docs say so. |
| Document that running test programs executes code | done | README limitations, SECURITY.md |

## 7. Repository and publishing

| Requirement | Status |
|---|---|
| README with demo, pitch, quickstart, tool table, example prompts, architecture diagram, limitations | done |
| LICENSE (MIT), CONTRIBUTING, CHANGELOG, SECURITY.md, docs per tool family, issue templates | done |
| Commits in logical steps, GitHub no-reply address | done |
| Public GitHub repository `cea`, tag `v0.1.0`, release with notes | see the release page |
| npm publish | not done, by instruction: waits for confirmation |
