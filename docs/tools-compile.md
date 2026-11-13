# Compile and inspect tools

These four tools show what a compiler produced and why: `compile`, `emit_ir`, `pass_timeline` and `opt_remarks`. They answer questions of the form "what did the compiler do?". They do not decide whether the result is correct; use the [correctness tools](tools-correctness.md) for that.

All of them return an Evidence record (see [tools-ledger.md](tools-ledger.md)). Large outputs such as IR, assembly and diffs are stored as views on disk; the result holds a bounded preview and the view name. Read a view with `inspect_evidence_view`.

## Inputs shared by most tools

Several input objects recur across the tool pages. They are defined once here.

### The `source` object

| Field | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | none | Path to a source file on disk. The language is inferred from the extension (`.c`, `.h`, `.i` are C; `.cc`, `.cpp`, `.cxx`, `.c++`, `.hpp`, `.ii` are C++; `.rs` is Rust; `.ll` is LLVM IR). |
| `code` | string | none | Source text, when there is no file. At most 2,000,000 characters. |
| `language` | `c`, `c++`, `rust` or `llvm-ir` | none | Required with `code`. With `path` it overrides the extension. |

Give exactly one of `path` and `code`. Unknown extra fields are rejected. cea works on a private copy of the file inside the evidence work directory, so dump files and outputs never land next to your source. The SHA-256 of the original file is recorded in `input_files`.

### The `flags` array

An array of strings, one compiler argument per element (at most 200, each at most 500 characters). They are passed verbatim and never through a shell, so a flag containing spaces stays one argument.

Two kinds of flags are refused before anything runs:

- `-o` and anything that starts with `-o` followed by more characters (except names starting `-opt` or `-object`): cea chooses output paths itself. The error code is `INVALID_INPUT`.
- Flags that make the compiler load or run other code: `-fplugin...`, `-fpass-plugin...`, `-load`, `-load-pass-plugin`, `-wrapper`, `-B...`, `-specs...`, response files starting with `@`, `-fuse-ld=` with a path, `-Xlinker`, `-fprofile-use-sample...` and a few similar ones. The error code is `UNSAFE_FLAG`. Set `CEA_ALLOW_UNSAFE_FLAGS=1` to allow them if you trust the plugin or wrapper. See [../SECURITY.md](../SECURITY.md).

### The `run` object

Describes how a compiled test program is run, for tools that run programs.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `args` | string[] | `[]` | Arguments for the test program (at most 100). |
| `stdin` | string | none | Text fed to the program on standard input (at most 1,000,000 characters). |
| `timeout_s` | integer | `10` | Per-run timeout in seconds, 1 to 3600. |

Test programs run with a scrubbed environment and a 4 MiB output cap. This limits accidents; it is not a sandbox. See [../SECURITY.md](../SECURITY.md).

### Optimisation levels

Where a tool takes an optimisation level, the allowed values are `O0`, `O1`, `O2`, `O3`, `Os`, `Oz` and `Og`. For GCC, `Oz` is mapped to `-Os`. For rustc each level maps to `-C opt-level=...` (`Og` maps to 1).

### Timeouts

`timeout_s` is in seconds, from 1 to 3600. Every process cea starts has a timeout; on timeout the whole process tree is killed.

## compile

### What it does and when to use it

Compiles a file or snippet with exactly the flags you give and returns assembly, LLVM IR, an object file (disassembled when `llvm-objdump` is available) or an executable, with parsed diagnostics and the compile time. Use it to see the code a configuration generates, to check whether a flag changes the output, or to capture the IR or assembly you want to hand to another tool.

If the compiler rejects the program or crashes, the record's status is still `ok`: the tool ran, and the failure is the observed fact. Look at `success` and `compiler_crashed` in the result.

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `source` | object | required | The program; see above. |
| `compiler` | string | `"clang"` | Compiler name (`clang`, `gcc`, `rustc`, `clang-17`) or an absolute path. |
| `flags` | string[] | `[]` | Extra compiler flags. |
| `output` | `asm`, `ir`, `object` or `executable` | `"asm"` | What to produce. GCC cannot emit LLVM IR (`UNSUPPORTED`); LLVM IR input needs clang as the driver. |
| `function` | string | none | For `asm` output: also return only this function's assembly. |
| `timeout_s` | integer | `120` | Seconds. |

### Key result fields

| Field | Meaning |
|---|---|
| `success` | `true` when the compiler exited 0 and produced the output file. |
| `compiler` | `path`, `version`, `target` of the compiler used. |
| `flags`, `output_kind` | The flags and output kind as run. |
| `exit_code`, `timed_out`, `compiler_crashed` | How the compiler process ended. A crash is a signal or crash text such as a stack dump or an assertion failure. |
| `compile_time_ms` | One wall-clock sample. |
| `diagnostics` | Up to 50 parsed diagnostics: `file`, `line`, `column`, `severity`, `message`. |
| `diagnostic_counts` | `errors`, `warnings`, `total`. |
| `stderr_preview` | On failure: the first lines of the compiler's stderr. |
| `output_view`, `output_lines`, `output_preview` | For `asm` and `ir`: view name (`output.s` or `output.ll`), line count, and the first 60 lines. For `object`: `output_view` is `disassembly.txt` when `llvm-objdump` ran. |
| `function_view`, `function_asm` | When `function` was given and a label was found. |
| `object_bytes` | Size of the object file for `object` output. |
| `executable_path`, `executable_bytes` | For `executable` output. |

### Example

```json
{
  "source": { "path": "examples/02-missed-vectorization-aliasing/scale.c" },
  "compiler": "clang",
  "flags": ["-O2"],
  "output": "asm",
  "function": "scale"
}
```

```sh
cea compile --input input.json
```

### Limitations it records

- Compile time is a single wall-clock sample, not a measurement.
- If `function` was given but no label matched, an unknown is recorded: the function may have been inlined, renamed (C++ mangling) or removed.
- If an object file could not be disassembled because `llvm-objdump` is missing, an unknown says so.

### What it does not tell you

It does not tell you that the generated code is correct, fast, or the same as what another compiler version would generate. One compile is one data point.

## emit_ir

### What it does and when to use it

Emits the IR the frontend produced, before any optimisation pass ran. For clang that is `-Xclang -disable-llvm-passes`; for rustc it is `--emit=llvm-ir,mir` with no LLVM passes pre-populated; for GCC it is the GIMPLE dump from `-fdump-tree-gimple`. Use it to separate "the frontend generated this" from "a pass did this".

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `source` | object | required | The program. |
| `compiler` | string | `"clang"` | Compiler name or path. clang, gcc and rustc are supported. |
| `flags` | string[] | `[]` | Extra flags. |
| `opt_level` | `O0`..`Og` | `"O1"` | The level the frontend is told about. At `O0` clang marks every function `optnone`, which hides what later passes would see; `O1` or higher is usually what you want. |
| `timeout_s` | integer | `120` | Seconds. |

### Key result fields

| Field | Meaning |
|---|---|
| `success` | Whether IR was produced. On failure, `diagnostics` and `stderr_preview` explain. |
| `compiler`, `opt_level` | What was used. |
| `ir_view` | `frontend.ll` for clang and rustc, `frontend.gimple` for GCC. |
| `ir_preview` | The first 60 lines (40 for MIR). |
| `functions` | clang only: names of the functions defined in the IR. |
| `mir_view`, `mir_preview` | rustc only: the MIR. |
| `ir_kind` | GCC only: `gimple`. |
| `diagnostics` | Up to 50 parsed diagnostics. |

### Example

```json
{
  "source": { "path": "examples/02-missed-vectorization-aliasing/scale.c" },
  "opt_level": "O2"
}
```

```sh
cea emit_ir --input input.json
```

### Limitations it records

- Frontend IR depends on the level passed to the frontend (lifetime markers, TBAA metadata and attributes differ).
- At `O0`, clang adds `optnone` and `noinline`, so the IR is not what the `-O2` pipeline starts from.
- rustc: MIR optimisations still run according to the level; only LLVM passes are held back.
- GCC: GIMPLE is not LLVM IR, so `validate_transform` cannot check it.

### What it does not tell you

It says nothing about what the optimiser did afterwards. Use `pass_timeline` for that.

## pass_timeline

### What it does and when to use it

Shows what each optimisation pass did to one function, as a list of diffs with no-op passes skipped. For clang it uses `-print-changed` with `-filter-print-funcs`. You can also give an explicit `opt` pipeline in `passes`. For GCC it uses `-fdump-tree-all` and shows the tree (GIMPLE) passes. Each changing step is stored as two views (the function after the pass, and the diff), and the first page of diffs is inlined in the result.

Use it when you know which function is affected and want to see where its IR changed shape.

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `source` | object | required | The program (C, C++ or LLVM IR). |
| `function` | string | required | The function to follow: the IR name without `@`, mangled for C++. |
| `compiler` | string | `"clang"` | clang or gcc. |
| `flags` | string[] | `["-O2"]` | Flags that select the pipeline. |
| `passes` | string | none | LLVM only: run this `opt` pipeline (for example `instcombine,simplifycfg`) instead of the driver pipeline. Needs `opt`. GCC refuses it. |
| `only_passes` | string[] | none | Keep only steps whose pass name contains one of these substrings. |
| `offset` | integer | `0` | First step to inline. |
| `limit` | integer | `8` | Number of step diffs to inline, 1 to 50. |
| `timeout_s` | integer | `180` | Seconds. |

### Key result fields

| Field | Meaning |
|---|---|
| `success` | `false` if compilation failed (with `stderr_preview`). |
| `function`, `compiler` | What was followed and with which compiler. |
| `steps_total` | Number of pass runs that changed the function (after `only_passes`). |
| `noop_passes_skipped` | Pass runs LLVM reported as no change. |
| `index` | Every step: `index`, `pass`, `added`, `removed`, `diff_view`, `ir_view`. |
| `page` | The inlined window: `offset`, `limit` and `steps`, each with a `diff` preview. |
| `all_diffs_view` | `timeline.diff`, all diffs in order. |
| `next_offset` | The offset to ask for next, or `null`. |

Other views: `step-000-start.ll` (the function before the first pass), one IR and one diff view per step, and `print-changed.raw.txt` (the raw dump, clang only).

### Example

```json
{
  "source": { "path": "examples/02-missed-vectorization-aliasing/scale.c" },
  "function": "scale",
  "flags": ["-O2"],
  "only_passes": ["licm", "loop-vectorize"],
  "limit": 4
}
```

```sh
cea pass_timeline --input input.json
```

### Limitations it records

- A diff shows what a pass changed, not whether the change is correct; use `validate_transform` on the before and after views.
- LLVM: only passes of the new pass manager IR pipeline are shown. Instruction selection and machine passes are not.
- GCC: tree (GIMPLE) passes only; RTL passes are not included.
- If the dump exceeded the output cap (256 MiB), later passes are missing and a limitation says so.

### What it does not tell you

It does not say that a pass is wrong, and it does not show what the backend did to the code. A function that was inlined away before the first dump cannot be followed and produces a `NOT_FOUND` error.

## opt_remarks

### What it does and when to use it

Collects the optimiser's own remarks: what it did, and more usefully what it declined to do and why. For clang it compiles with `-fsave-optimization-record` and parses the YAML. For GCC it uses `-fopt-info-all`. Remarks are filtered, deduplicated with a count, grouped by function, and loop-related remarks are grouped by the source line of the loop.

Use it to find out why a loop did not vectorise or a call was not inlined.

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `source` | object | required | The program. |
| `compiler` | string | `"clang"` | clang or gcc. |
| `flags` | string[] | `["-O2"]` | Extra flags. |
| `function` | string | none | Only remarks in this function. clang only; GCC remarks carry no function name. |
| `passes` | string[] | none | Only remarks whose pass name contains one of these, for example `["loop-vectorize","inline"]`. |
| `kinds` | array of `passed`, `missed`, `analysis` | all three | Which kinds of remark to keep. |
| `max_remarks` | integer | `60` | Remarks inlined in the result; the rest stay in the view. 1 to 500. |
| `timeout_s` | integer | `120` | Seconds. |

### Key result fields

| Field | Meaning |
|---|---|
| `success` | `false` if compilation failed (with `stderr_preview`). |
| `compiler`, `flags` | What was used. |
| `counts` | Distinct remarks by kind: `missed`, `analysis`, `passed`. |
| `by_function` | For each function: `loops` (keyed by "line N", each a list of remarks) and `other`. Each remark has `kind`, `pass`, `name`, `line`, `column`, `message`, `count`. Missed remarks come first. |
| `inlined` | How many remarks are in `by_function`. |
| `all_remarks_view` | `remarks.tsv`, every selected remark. The raw record is also kept (`remarks.opt.yaml` or `optinfo.txt`). |

### Example

This is the example from `02-missed-vectorization-aliasing` (see [../examples/02-missed-vectorization-aliasing/](../examples/02-missed-vectorization-aliasing/)).

```json
{
  "source": { "path": "examples/02-missed-vectorization-aliasing/scale.c" },
  "compiler": "clang",
  "flags": ["-O2"],
  "function": "scale",
  "passes": ["loop-vectorize"]
}
```

```sh
cea opt_remarks --input input.json
```

### Limitations it records

- A remark is the optimiser's explanation, not a measurement. A missed optimisation may not matter for run time, and a passed one may not help. Measure with `benchmark`.
- Passes only emit remarks where their authors added them; silence does not mean a transformation happened.
- GCC: remarks are grouped by source line only, and the `function` filter is ignored.

### What it does not tell you

It does not tell you that fixing the missed remark will make the program faster, and it does not cover compilers other than clang and GCC. For rustc the tool answers `UNSUPPORTED`.
