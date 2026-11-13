# Command-line reference

The package `cea-agents` installs one binary, `cea`. It runs the same tool definitions as the MCP server, so `cea <tool> --input input.json` and the MCP tool call of the same name take the same input and return the same record. Node 20 or newer is required.

Use `npx -y cea-agents <command>` to run it without installing, or `npm install -g cea-agents`. The tools themselves are documented in [tools-environment.md](tools-environment.md), [tools-compile.md](tools-compile.md), [tools-correctness.md](tools-correctness.md), [tools-performance.md](tools-performance.md), [tools-ledger.md](tools-ledger.md) and [triage.md](triage.md).

## Commands

| Command | What it does |
|---|---|
| `cea <tool> --json '<input>'` | Run a tool with the input given inline as JSON. Prints the result as JSON. |
| `cea <tool> --input <file.json>` | Same, with the input read from a file. Use `-` as the file name to read standard input. |
| `cea tools` | List the tools: name, family and first sentence of the description. |
| `cea tools --json` | List the tools as JSON, with title, description and the full input schema of each. |
| `cea schema <tool>` | Print one tool's JSON input schema. |
| `cea doctor` | Human-readable environment report: providers found or missing, sanitizers, warnings. |
| `cea triage <file> [options]` | Human-readable triage of a suspected miscompile. See [triage.md](triage.md). |
| `cea mcp` | Run the MCP server on standard input and output. It runs until the client closes the connection. |
| `cea install-skill [--dir <dir>]` | Copy the agent skill `compiler-engineering` into `<dir>/compiler-engineering`. The default for `<dir>` is `.claude/skills` in your home directory. It then prints the command to register the MCP server: `claude mcp add cea -- npx -y cea-agents mcp`. |
| `cea help` | Print the help text. |
| `cea version`, `cea --version` | Print the version. |

Tool names accept dashes or underscores: `cea check-ub` is the same as `cea check_ub`. The tools are `environment_report`, `compile`, `emit_ir`, `pass_timeline`, `opt_remarks`, `check_ub`, `differential_run`, `bisect_passes`, `reduce_testcase`, `validate_transform`, `analyze_throughput`, `benchmark`, `fuzz_compiler`, `bisect_compiler_history`, `triage_miscompile`, `inspect_evidence_view`, `list_evidence`, `record_unknown`, `update_unknown` and `export_evidence_bundle`.

`cea <tool> --help` prints the tool's description and input schema and exits with 0 without running it.

## Options

| Option | Applies to | Meaning |
|---|---|---|
| `--json '<input>'` | tools | The tool input as JSON text. |
| `--input <file>` | tools | The tool input from a file; `-` reads standard input. A byte order mark at the start is ignored. If both `--json` and `--input` are given, `--json` wins. With neither, the input is an empty object, which works for tools whose fields all have defaults. |
| `--session <name>` | every command that uses the ledger | Evidence session. Default: `CEA_SESSION`, or `default`. |
| `--home <dir>` | every command that uses the ledger | Where sessions are stored. Default: `CEA_HOME`, or `.cea` in the current directory. |
| `--compact` | tools | Print the JSON on one line. By default it is indented. |
| `--help` | tools | Print the description and input schema of the tool. |
| `--version` | any | Print the version. |

Options can also be written as `--name=value`. The options for `cea triage` are in the next section.

### Options of cea triage

```
cea triage <file> [--compiler <name>] [--flags "<flags>"] [--ref "<flags>"] [--no-reduce] [--report <file>]
```

| Option | Default | Meaning |
|---|---|---|
| `<file>` | required | The source file. |
| `--compiler <name>` | `clang` | The compiler under suspicion. |
| `--flags "<flags>"` | `-O2` | The suspect configuration, split on whitespace. |
| `--ref "<flags>"` | `-O0` | The reference configuration, split on whitespace. |
| `--no-reduce` | off | Skip test-case reduction. |
| `--report <file>` | none | Also write the Markdown report to this file. |

For more control (inline code, a function name, a run specification, validation off, a reduction budget), call the tool itself: `cea triage_miscompile --input file.json`.

## Output

For a tool, the output is one JSON document: the Evidence record for a recording tool, or a `cea.response/1` envelope for the five ledger tools. The shape is described in [tools-ledger.md](tools-ledger.md). The `status` field says how the call ended: `ok`, `inconclusive`, `unavailable` or `error`.

Colour is used for `cea doctor` and `cea triage` when output is a terminal. Set `NO_COLOR` to turn it off, or `FORCE_COLOR=1` to force it on.

## Exit codes

| Code | When |
|---|---|
| `0` | The tool ran and its status is `ok` or `inconclusive`. Also for help, version, `tools`, `schema`, `doctor` when the report was produced, and for `cea triage` whatever the verdict. |
| `2` | The status is `error` or `unavailable`. Also: the input is not valid JSON, the command or tool name is unknown, `cea schema` got an unknown tool, `cea triage` got no file argument, or `cea install-skill` could not find the skill. |
| `1` | An unexpected exception inside cea itself. This is a bug; report it with the evidence bundle. |

An `inconclusive` status exits with 0, so a script that must act on it should read `status` from the JSON. For example, `cea validate_transform` returns `inconclusive` when Alive2 gave no verdict.

## Environment variables

| Variable | Meaning |
|---|---|
| `CEA_HOME` | Where sessions are stored. Default: `.cea` in the current directory. Overridden by `--home`. |
| `CEA_SESSION` | Session name. Default: `default`. Overridden by `--session`. |
| `CEA_TOOLCHAIN_DIRS` | Extra directories searched for compilers and tools before `PATH`. Separated by `;` on Windows and `:` elsewhere. |
| `CEA_TOOL_<NAME>` | Explicit path for one provider, for example `CEA_TOOL_ALIVE_TV` or `CEA_TOOL_LLVM_REDUCE`. If it is set, nothing else is searched for that provider. See [tools-environment.md](tools-environment.md). |
| `CEA_REMOTE_PROVIDERS` | Comma-separated list of remote providers to allow. The only value that does anything is `compiler-explorer`, which lets `validate_transform` send IR to the Alive2 online instance. Off by default. |
| `CEA_ALLOW_UNSAFE_FLAGS` | Set to `1` to allow flags that load code into the compiler, such as `-fplugin`. |
| `CEA_CSMITH_INCLUDE` | Directory that contains `csmith.h`, for `fuzz_compiler` with Csmith. |
| `CEA_ALIVE2_CE_URL` | Base URL of the Compiler Explorer instance used by the remote provider. Default: `https://alive2.llvm.org/ce`. Only read when the remote provider runs. |
| `CEA_INTERESTING_VERBOSE` | Read by the generated `interesting.mjs`: set to `1` to print why a candidate was rejected. |
| `NO_COLOR`, `FORCE_COLOR` | Turn terminal colour off or on. |

## Tips

### On Windows, use --input

Quoting JSON on the command line is awkward in PowerShell and `cmd`: the shell strips or rewrites the double quotes, and cea then reports "input is not valid JSON". Write the input to a file and pass it with `--input`:

```sh
cea check_ub --input input.json
```

The same applies to any tool with a non-trivial input. In a POSIX shell, single quotes around the JSON work:

```sh
cea check_ub --json '{"source":{"path":"examples/01-ub-not-a-compiler-bug/overflow.c"}}'
```

Paths inside the JSON are relative to the current directory. Use forward slashes or escaped backslashes (`\\`) in JSON strings.

### Reading a result

The record can be large. To read one stored output, use `inspect_evidence_view` with the `evidence_id` from the record and the view name. To list what exists in the session, use `list_evidence`. To get everything out to attach to an issue, use `export_evidence_bundle`.

```sh
cea list_evidence --compact
cea export_evidence_bundle --input bundle.json
```

### Bug reports

When you open an issue, include the output of `cea doctor`, the exact command or tool input, and the bundle written by `export_evidence_bundle`. See [../CONTRIBUTING.md](../CONTRIBUTING.md).
