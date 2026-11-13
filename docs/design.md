# cea design

cea ("Compiler Engineering Agent") gives a coding agent a compiler engineer's toolbox and makes it prove every claim. It is an MCP server plus a CLI that wrap compiler tools the user already has, store every result as a citable Evidence record, and ship with an agent skill that teaches the workflow.

Three rules shape every decision:

1. **Semantics before speed.** A fast wrong program is a bug. Tools that measure speed also check output.
2. **Evidence before claims.** "Compiler bug", "this pass is correct" and "this is faster" are conclusions. Each needs evidence IDs behind it.
3. **Small before large.** Reduce first, then reason.

## Components

```
agent ──MCP (stdio)──▶ server.ts ─┐
human ──cea <tool> --json──▶ cli.ts ─┤
                                   ▼
                       registry.ts (tool definitions, zod schemas)
                                   ▼
                core/invoke.ts  validate → EvidenceBuilder → tool.run → persist
                    │                 │
          core/toolbox.ts        core/ledger.ts
       (find providers, versions)   (JSONL + views on disk)
                    │
              core/exec.ts  spawn(argv[]), timeout, output cap, tree kill
                    ▼
     clang · opt · llvm-reduce · llvm-mca · gcc · rustc · alive-tv · cvise · csmith · git …
```

- **TypeScript, Node 20+, ESM.** Runtime dependencies: `@modelcontextprotocol/sdk` and `zod` only.
- **One definition per tool.** The MCP server and the CLI both read `registry.ts`, so `cea <tool> --json '<input>'` and the MCP tool can never drift apart.
- **No bundled compilers.** Providers are located on `PATH`, in `CEA_TOOLCHAIN_DIRS`, or through `CEA_TOOL_<NAME>` overrides. Nothing is installed or downloaded.

## Tool list

| Family | Tools |
|---|---|
| Environment | `environment_report` |
| Compile and inspect | `compile`, `emit_ir`, `pass_timeline`, `opt_remarks` |
| Correctness | `check_ub`, `differential_run`, `bisect_passes`, `reduce_testcase`, `validate_transform`, `fuzz_compiler`, `bisect_compiler_history` |
| Performance | `analyze_throughput`, `benchmark` |
| Ledger | `inspect_evidence_view`, `list_evidence`, `record_unknown`, `update_unknown`, `export_evidence_bundle` |
| Composite | `triage_miscompile` |

## Evidence schema (`cea.evidence/1`)

Every tool call, including failures and "provider missing" outcomes, appends one record to the session ledger and returns it.

| Field | Meaning |
|---|---|
| `evidence_id` | `ev_<operation>_<8 hex>`; cite this |
| `session_id`, `created_at`, `duration_ms` | provenance |
| `operation` | tool name |
| `status` | `ok` (ran to completion), `inconclusive`, `unavailable` (provider missing), `error` |
| `summary` | one line; never stronger than the evidence |
| `inputs` | validated input as received |
| `input_files[]` | path, SHA-256, size of every source file read |
| `tools[]` | name, resolved path, version line of every binary used |
| `commands[]` | exact argv, cwd, exit code, signal, timeout flag, duration, view names for stdout/stderr |
| `target_triple` | when known, else `null` |
| `result` | normalized, tool-specific, bounded in size |
| `observed[]` | facts read directly from tool output |
| `inferred[]` | conclusions drawn from observations; each is weaker than an observation |
| `unknowns[]` | what this evidence does not settle |
| `limitations[]` | what the method cannot see |
| `coverage` | what was and was not exercised (configs, inputs, paths) |
| `views[]` | named raw outputs kept on disk: name, bytes, lines, SHA-256 |
| `derived_from[]` | evidence IDs this record builds on |
| `error` | `{code, message, remediation}` when status is `error` or `unavailable` |

Storage: `<CEA_HOME>/sessions/<session>/evidence.jsonl`, `unknowns.jsonl`, `views/<evidence_id>/<name>`, `work/<evidence_id>/`. `CEA_HOME` defaults to `.cea` in the working directory; the session defaults to `default` (`CEA_SESSION`). JSONL was chosen over SQLite to avoid a native dependency; the ledger is append-only and small.

Large outputs never enter the agent's context. Results hold bounded previews; the full text is a view, read page by page with `inspect_evidence_view` (line offset, limit, optional substring filter).

## Provider interface

```ts
interface ProviderSpec {
  id: string;              // "clang", "alive-tv", …
  kind: 'compiler' | 'llvm-tool' | 'verifier' | 'reducer' | 'fuzzer' | 'profiler' | 'vcs' | 'remote';
  candidates: string[];    // binary names to try; LLVM tools also try versioned names (opt-18)
  versionArgs: string[];   // usually ["--version"]
  purpose: string;         // which tools need it
  install: string;         // remediation hint shown when missing
}
interface ProviderStatus { id; available; path?; version?; reason?; remediation? }
```

`Toolbox.resolve(id)` checks, in order: `CEA_TOOL_<ID>`, the directory of the resolved clang (so `opt` matches `clang`), `CEA_TOOLCHAIN_DIRS`, `PATH`. Tools receive the toolbox and the `exec` function through a context object, which is what unit tests replace with fakes.

The Compiler Explorer provider is remote and off by default. It is used only when `CEA_REMOTE_PROVIDERS` contains `compiler-explorer`, because it sends source code to a third party.

## Safety model

- Processes are spawned with argument arrays and `shell: false`. No string is ever interpolated into a shell.
- Every process has a timeout and an output cap; on timeout the whole process tree is killed.
- Flags that load code into the compiler (`-fplugin`, `-load`, `-wrapper`, `-B`, `-specs`, response files) are rejected unless `CEA_ALLOW_UNSAFE_FLAGS=1`.
- Tools run only resolved provider binaries, binaries compiled from the declared source, and commands the caller passes explicitly as argv (history bisection build commands).
- Compiled test programs run with a scrubbed environment in a per-evidence work directory, with timeouts and output limits. This limits accidents; it is **not** a security sandbox. Running a test program executes its code.

## Risks and how the design answers them

| Risk | Answer |
|---|---|
| Agent blames the compiler for undefined behaviour | `triage_miscompile` runs `check_ub` first and stops; `reduce_testcase` keeps a UB check inside the interestingness test |
| Reduction drifts to a different bug | interestingness test pins the original good and bad outputs or the crash signature |
| A clean sanitizer run read as "no UB" | every `check_ub` record lists what sanitizers cannot see, as `limitations` and `unknowns` |
| Speed claims from one run | `benchmark` refuses fewer than 5 runs, reports median and spread, and marks overlapping ranges as not distinguishable |
| llvm-mca numbers read as real performance | fixed limitation text: no caches, no branch misprediction, no frontend effects |
| Tool versions differ between steps | every record carries tool paths and versions; `environment_report` flags mixed LLVM versions |
| Pass bisection misattributes | result states that the first flipping pass may only expose a later or earlier fault; `validate_transform` is the check |
| Context flooding | bounded results plus paged views |
| Windows path and quoting problems | `path.join` everywhere, `os.tmpdir()`-free design (work dirs live in the session), interestingness tests are Node scripts, not shell |

## Build order

1. Ledger, exec, toolbox, `environment_report`
2. `compile`, `emit_ir`, `pass_timeline`
3. `check_ub`, `differential_run`, `bisect_passes`, `reduce_testcase`, `validate_transform`, `triage_miscompile`
4. `opt_remarks`, `analyze_throughput`, `benchmark`, `fuzz_compiler`, `bisect_compiler_history`, unknowns, bundle export
5. Skill, docs, examples, demo, CI, release
