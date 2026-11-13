# Connection and recovery

**When to read this.** The cea tools are not showing up, a tool answered `unavailable`, a provider is missing, or you are setting cea up for the first time. Back to the [skill](../SKILL.md).

cea never installs or downloads a compiler. It finds what is already on the machine, and it tells you exactly what it could not find and how to fix it. Your job is to relay that, not to work around it.

## Install

Requires Node 20 or newer.

```sh
npm install -g cea-agents    # provides the `cea` command
cea doctor                   # what was detected, what is missing, and the fix for each
```

Without a global install, every command works through `npx -y cea-agents <command>`, and the server can be registered as `claude mcp add cea -- npx -y cea-agents mcp`.

## Register the MCP server

Claude Code:

```sh
claude mcp add cea -- cea mcp
```

Any other MCP client that takes a JSON server definition (stdio transport):

```json
{
  "mcpServers": {
    "cea": {
      "command": "cea",
      "args": ["mcp"],
      "env": {
        "CEA_HOME": "/absolute/path/for/evidence",
        "CEA_TOOLCHAIN_DIRS": "/opt/llvm/bin"
      }
    }
  }
}
```

On Windows, if the client cannot start `cea` directly (it is a `.cmd` shim), use `"command": "cmd", "args": ["/c", "cea", "mcp"]`, or run the server with Node: `"command": "node", "args": ["<npm global root>/cea-agents/dist/cli.js", "mcp"]` (`npm root -g` prints the global root).

Install the skill for Claude Code:

```sh
cea install-skill                 # copies to ~/.claude/skills/compiler-engineering
cea install-skill --dir <dir>     # any other skills directory
```

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `CEA_HOME` | where evidence sessions are stored | `.cea` in the working directory |
| `CEA_SESSION` | session name; later calls can cite earlier evidence in the same session | `default` |
| `CEA_TOOLCHAIN_DIRS` | directories searched before `PATH`, separated like `PATH` | empty |
| `CEA_TOOL_<NAME>` | exact binary for one provider, for example `CEA_TOOL_ALIVE_TV`, `CEA_TOOL_CLANG` | unset |
| `CEA_CSMITH_INCLUDE` | directory containing `csmith.h` | searched in common places |
| `CEA_REMOTE_PROVIDERS` | set to `compiler-explorer` to let `validate_transform` send IR to the Alive2 online instance | unset: no network |
| `CEA_ALLOW_UNSAFE_FLAGS` | set to `1` to allow `-fplugin` and similar flags | unset |

On Windows keep `CEA_HOME` on a short path. Compiled test programs live under it, and a path longer than 260 characters cannot be executed.

## Diagnose a missing provider

1. Run `environment_report` (or `cea doctor`). Each provider is listed as available with its path and version, or unavailable with a `reason` and a `remediation`.
2. Read the reason. The usual ones:

| Reason | Fix |
|---|---|
| `no <tool> found in CEA_TOOLCHAIN_DIRS or PATH` | install it, or add its directory to `CEA_TOOLCHAIN_DIRS`, or point `CEA_TOOL_<NAME>` at the binary |
| `found at ... but --version failed` | the binary is broken or needs a library; run it by hand |
| `... is not a real gcc (it reports: clang ...)` | on macOS and some MinGW toolchains `gcc` is clang; install GCC or set `CEA_TOOL_GCC` |
| `not supported on <platform>` | perf is Linux only |
| LLVM tools have different major versions | put one LLVM's `bin` first, or set `CEA_TOOL_OPT` and friends to matching binaries |

3. After changing the environment, restart the MCP server. Detection is cached for the life of the process.

Typical installs:

```sh
# Debian/Ubuntu
sudo apt install clang llvm gcc cvise creduce csmith libcsmith-dev
# macOS
brew install llvm gcc creduce          # then add $(brew --prefix llvm)/bin to CEA_TOOLCHAIN_DIRS
# Windows
# an LLVM release archive plus a MinGW-w64 toolchain; list both bin directories in CEA_TOOLCHAIN_DIRS
```

Alive2 (`alive-tv`) has to be built from source against your LLVM: see https://github.com/AliveToolkit/alive2. If you cannot build it, the remote provider is the alternative, and it sends the IR being checked to a third-party server. Only enable it for code you are allowed to share.

## What each missing provider costs you

| Missing | Effect | Honest wording |
|---|---|---|
| clang | most LLVM-based tools are unavailable | "not run: clang unavailable" |
| sanitizer runtimes | `check_ub` is inconclusive | "UB status unknown" |
| alive-tv, remote disabled | `validate_transform` unavailable | "transformation not validated" |
| cvise and creduce | `reduce_testcase` uses the built-in line reducer | "reduced by lines only; not minimal" |
| csmith and yarpgen | `fuzz_compiler` unavailable | "no fuzzing was done" |
| opt | `pass_timeline` with an explicit pipeline unavailable | use the driver pipeline through clang |

An unavailable tool is a gap in the evidence. Report the gap; do not fill it with a guess.

## Recovering from failures

| Symptom | Cause | Do |
|---|---|---|
| `INVALID_INPUT` | the input does not match the schema | `cea schema <tool>`; fix the named field |
| `UNSAFE_FLAG` | a flag would load code into the compiler | remove it, or the user sets `CEA_ALLOW_UNSAFE_FLAGS=1` |
| `NOT_FOUND` for an evidence ID | wrong session | check `CEA_SESSION`; `list_evidence` |
| `TIMEOUT` | the step exceeded its budget | raise the timeout input, or reduce the test case first |
| JSON quoting errors on the command line | shell quoting, mostly on Windows | `cea <tool> --input file.json` |
| program "works" under cea but not by hand | cea runs test programs with a scrubbed environment | check which environment variables the program depends on |

## Checklist before you conclude

- [ ] `environment_report` was run in this session and its evidence ID is in the answer.
- [ ] Every unavailable provider that affected the result is named, with what it left unknown.
- [ ] No compiler or tool was installed, downloaded or enabled without the user asking for it.
- [ ] The remote provider was used only if the user enabled it.
