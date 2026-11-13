# Environment tools

This page covers `environment_report`, the tool you call first, and the rules cea uses to find compilers and other programs on your machine. For the other tool families see [compile and inspect](tools-compile.md), [correctness](tools-correctness.md), [performance](tools-performance.md), [the ledger](tools-ledger.md) and [triage](triage.md). The design background is in [design.md](design.md).

cea never installs or downloads anything. It looks for programs that are already there, runs each with its version flag, and records the path and version line in every Evidence record that used it. If a program is missing, the tool that needs it returns an Evidence record with status `unavailable` and a one-line fix.

## environment_report

### What it does and when to use it

`environment_report` detects the compilers (clang, gcc, rustc), their versions and target triples, and the status of every provider listed in the table below. For each provider that is missing it records why and how to fix it. By default it also compiles a one-line program with each sanitizer to learn which sanitizers actually link on this machine.

Call it first in any investigation. A statement about a compiler is only meaningful with the exact version, flags and target, and this record pins the first two. The human form of the same tool is `cea doctor` (see [cli.md](cli.md)).

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `probe_sanitizers` | boolean | `true` | Compile a one-line program with each sanitizer to see which ones link here. With `false` the sanitizer table is empty and the gap is recorded as an unknown. |

### Key result fields

| Field | Meaning |
|---|---|
| `host` | `platform`, `arch`, `os_release`, `cpu_model`, `logical_cpus`, and the Node version as `node`. |
| `compilers` | One entry per detected compiler among clang, gcc and rustc: `id`, `family`, `path`, `version`, `target`. |
| `providers` | One entry per provider: `id`, `kind`, `available`, `path`, `version`, `reason`, `remediation`, `needed_by`. `reason` and `remediation` are set when `available` is false. |
| `missing` | The ids of the providers that are not available. |
| `sanitizers` | For each clang or gcc compiler, which of `undefined`, `address` and `memory` compiled and linked. gcc is not probed for `memory`. |
| `llvm_targets` | Target names parsed from `llc --version`, when `llc` is available. |
| `remote_providers` | `{"compiler_explorer": true|false}`, whether the opt-in remote provider is enabled. |
| `warnings` | Human-readable warnings, for example mixed LLVM major versions. |
| `session` | `home`, `session` and `ledger_dir` for the current session. |

The record's status is `ok` even when providers are missing; missing providers are data, not failure. The `summary` reads like `12/19 providers available; compilers: clang (x86_64-pc-windows-msvc)`.

### Example

```json
{ "probe_sanitizers": true }
```

```sh
cea environment_report --input input.json
```

### Limitations it records

- Detection covers binaries on `PATH`, in `CEA_TOOLCHAIN_DIRS` and named by `CEA_TOOL_<NAME>` overrides only. Other installed toolchains are not discovered.
- When the LLVM tools found have different major versions (clang, `llvm-*` tools, `opt`, `llc`, `llvm-reduce`), a warning says so and the same text is recorded as a limitation, because IR printed by one version may not parse in another.

### What it does not tell you

It does not tell you that a toolchain is correct or that two tools were built from the same source. A sanitizer that links here may still miss the bug you care about; see the limitations of `check_ub` in [tools-correctness.md](tools-correctness.md).

## How providers are found

A provider is a program cea may run on your behalf: a compiler, an LLVM tool, a verifier, a reducer, a fuzzer, a profiler, or git. The list is fixed (see the table at the end of this page). For each provider cea walks the following steps and uses the first hit.

1. **Explicit override.** If the variable `CEA_TOOL_<NAME>` is set, it is used and nothing else is searched. `<NAME>` is the provider id in upper case with every run of characters other than letters and digits replaced by one underscore, so `alive-tv` becomes `CEA_TOOL_ALIVE_TV` and `llvm-reduce` becomes `CEA_TOOL_LLVM_REDUCE`. If the variable points to a file that does not exist, the provider is reported as unavailable with that reason; cea does not fall back to the search path. On Windows `.exe` is appended when the path has no extension and a file with that name exists.
2. **Next to clang.** For LLVM tools (`opt`, `llc`, `llvm-mca`, `llvm-mc`, `llvm-objdump`, `FileCheck`) and for `llvm-reduce`, cea first looks in the directory of the clang it resolved, using the same version suffix. If clang is `clang-18`, it looks for `opt-18` there first. This keeps `opt` and `clang` from different LLVM releases from being mixed by accident.
3. **Search directories.** `CEA_TOOLCHAIN_DIRS` first, then `PATH`. Both are split with the platform path separator (`;` on Windows, `:` elsewhere). The plain name (`opt`) is tried in every directory first.
4. **Versioned LLVM names.** Only for providers that allow it (clang and every LLVM tool, including `llvm-reduce`): if no plain name matched, cea looks for names such as `opt-18` or `clang-17` in the same directories. In the first directory that has any match it takes the highest version number.

Version detection runs the provider's version command (usually `--version`) with a 15 second timeout. If that fails, the provider is unavailable and the reason includes the exit code or the error. The first line that contains the word "version" or a number of the form `N.N` becomes the recorded version.

### The compiler named in a tool call

Tools that take a `compiler` string resolve it in one of two ways. If the string is a compiler provider id (`clang`, `gcc`, `rustc`), the rules above apply. Otherwise it is treated as a bare name looked up in `CEA_TOOLCHAIN_DIRS` and `PATH` (so `clang-17` works when a file with exactly that name exists) or as a path. The family (clang, gcc, rustc or unknown) is read from the `--version` output, and the target triple from `-dumpmachine` or, for rustc, from `rustc -vV`. Several tools refuse a family they do not support and say so.

For C++ sources, cea uses the C++ driver next to the compiler it found (`clang++` or `g++`). If it is not there the tool reports it as unavailable and asks you to pass the C++ driver as `compiler`.

### A gcc that is really clang is rejected

On macOS, and in some MinGW-style distributions, a program named `gcc` is an alias for clang. cea checks the version output of the `gcc` provider and rejects a binary whose output matches "clang". It then keeps looking for another `gcc` further along the search path. If none is found, the provider is reported as unavailable, with a reason such as "is not a real gcc (it reports: ...)". Set `CEA_TOOL_GCC` to a real GCC to fix it.

### Windows notes

cea never spawns a process through a shell. It also refuses to run `.cmd` and `.bat` files, because they need a shell. If a tool is installed only as a batch wrapper, point the matching `CEA_TOOL_<NAME>` variable at the real executable.

### The remote provider

There is one provider that is not a program: the Compiler Explorer instance used by `validate_transform`. It is off unless the environment variable `CEA_REMOTE_PROVIDERS` contains `compiler-explorer`. See [tools-correctness.md](tools-correctness.md) and [../SECURITY.md](../SECURITY.md) for what it sends.

## Provider table

The table is generated from the provider list in `src/core/toolbox.ts`. "Needed by" is the text cea records for each provider. The override variable is the name to set when the program is not on `PATH`.

| Id | Kind | Needed by | Override variable | How to install |
|---|---|---|---|---|
| `clang` | compiler | `compile`, `emit_ir`, `pass_timeline`, `opt_remarks`, `check_ub`, `differential_run`, `bisect_passes`, `triage_miscompile` | `CEA_TOOL_CLANG` | Install LLVM (for example `apt install llvm clang`, `brew install llvm`, or the release archive from github.com/llvm/llvm-project/releases) and put its `bin` directory on `PATH` or in `CEA_TOOLCHAIN_DIRS`. |
| `gcc` | compiler | `compile`, `pass_timeline`, `opt_remarks`, `differential_run` | `CEA_TOOL_GCC` | Install GCC (`apt install gcc`, `brew install gcc`, or a MinGW-w64 build on Windows). A `gcc` that is really clang is rejected. |
| `rustc` | compiler | `compile`, `emit_ir`, `differential_run` | `CEA_TOOL_RUSTC` | Install Rust with rustup (https://rustup.rs). |
| `cargo` | compiler | `check_ub` (Miri) | `CEA_TOOL_CARGO` | Install Rust with rustup (https://rustup.rs). |
| `miri` | verifier | `check_ub` (Rust) | `CEA_TOOL_MIRI` | `rustup toolchain install nightly`, then `rustup +nightly component add miri`. Set `CEA_TOOL_MIRI` to the nightly `cargo` if it is not the default. The check runs `cargo miri --version`. |
| `opt` | llvm-tool | `pass_timeline` (IR input), `validate_transform` (pass mode) | `CEA_TOOL_OPT` | Install LLVM as for clang. |
| `llc` | llvm-tool | `compile` (IR input) | `CEA_TOOL_LLC` | Install LLVM as for clang. |
| `llvm-reduce` | reducer | `reduce_testcase` (IR) | `CEA_TOOL_LLVM_REDUCE` | Install LLVM as for clang. |
| `llvm-mca` | llvm-tool | `analyze_throughput` | `CEA_TOOL_LLVM_MCA` | Install LLVM as for clang. |
| `llvm-mc` | llvm-tool | `environment_report` | `CEA_TOOL_LLVM_MC` | Install LLVM as for clang. |
| `llvm-objdump` | llvm-tool | `compile` (object disassembly) | `CEA_TOOL_LLVM_OBJDUMP` | Install LLVM as for clang. |
| `FileCheck` | llvm-tool | writing lit tests (skill guidance) | `CEA_TOOL_FILECHECK` | Ships with LLVM development packages (`apt install llvm-NN-tools`) or an LLVM build tree. |
| `alive-tv` | verifier | `validate_transform`, `triage_miscompile` | `CEA_TOOL_ALIVE_TV` | Build Alive2 (https://github.com/AliveToolkit/alive2) against your LLVM and put `alive-tv` on `PATH`, or enable the remote provider with `CEA_REMOTE_PROVIDERS=compiler-explorer` (this sends the IR to alive2.llvm.org). |
| `cvise` | reducer | `reduce_testcase` | `CEA_TOOL_CVISE` | `apt install cvise`, or `pip install cvise`. Without it `reduce_testcase` falls back to the built-in line reducer. |
| `creduce` | reducer | `reduce_testcase` | `CEA_TOOL_CREDUCE` | `apt install creduce` or `brew install creduce`. `cvise` is preferred when both exist. |
| `csmith` | fuzzer | `fuzz_compiler` | `CEA_TOOL_CSMITH` | `apt install csmith libcsmith-dev`, or build from https://github.com/csmith-project/csmith. Set `CEA_CSMITH_INCLUDE` if `csmith.h` is not in a standard include directory. |
| `yarpgen` | fuzzer | `fuzz_compiler` | `CEA_TOOL_YARPGEN` | Build YARPGen from https://github.com/intel/yarpgen and put it on `PATH`. |
| `perf` | profiler | `environment_report` (detected and reported; `benchmark` does not read hardware counters yet) | `CEA_TOOL_PERF` | `apt install linux-tools-common linux-tools-$(uname -r)`. Linux only; on other platforms the provider is reported as not supported. |
| `git` | vcs | `bisect_compiler_history` | `CEA_TOOL_GIT` | Install git. |

Two notes on the table. The `miri` row uses `cargo` as its program and the version check `cargo miri --version`. The `perf` provider is detected and reported, but `benchmark` does not read hardware counters yet. Details are in [tools-performance.md](tools-performance.md).

The `llvm-mc` provider is detected only so that `environment_report` can show it.
