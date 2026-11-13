# Performance tools

Two tools deal with speed: `analyze_throughput` (a static model of how fast a block of code could run) and `benchmark` (a measurement of how fast whole programs did run). They are meant to be used together: the first suggests, the second confirms. A third tool, `opt_remarks`, explains why an optimisation did or did not happen and is documented in [tools-compile.md](tools-compile.md).

The rule behind both: semantics before speed. `benchmark` checks that every variant prints the same output before it times anything. A fast wrong program is a bug, not a result.

The shared input objects (`source`, `flags`, `run`, timeouts) are defined in [tools-compile.md](tools-compile.md). Provider installation is in [tools-environment.md](tools-environment.md).

## analyze_throughput

### What it does and when to use it

Runs `llvm-mca` on a function or on a marked region of assembly for a named CPU, and returns IPC, uops per cycle, block reciprocal throughput and the bottleneck report. You can give C or C++ source, which cea compiles to assembly first, or assembly text directly.

Use it to compare two instruction sequences for the same hot loop, or to see whether a loop is limited by a resource or by a data dependency. Then confirm with `benchmark`.

Which part of the assembly is analysed:

- With `function`: that function's instructions, found by its label.
- Without `function`, if the assembly contains `# LLVM-MCA-BEGIN` and `# LLVM-MCA-END` comments: the marked regions.
- Otherwise the whole file, as one block. This rarely corresponds to a real hot loop, and a limitation says so.

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `source` | object | none | C or C++ source to compile to assembly first. Give exactly one of `source` and `asm`. |
| `asm` | string | none | Assembly text (AT&T syntax for x86) to analyse directly. At most 1,000,000 characters. |
| `function` | string | none | Function to analyse. |
| `cpu` | string | required | CPU model for `-mcpu`, for example `skylake`, `znver4`, `cortex-a76`. Name it explicitly: results differ per CPU. |
| `triple` | string | compiler's target | Target triple. |
| `compiler` | string | `"clang"` | clang or gcc. Used only with `source`. |
| `flags` | string[] | `["-O2"]` | Extra compiler flags. |
| `iterations` | integer | `100` | llvm-mca iterations, 1 to 100000. |
| `timeout_s` | integer | `120` | Seconds. |

### Key result fields

| Field | Meaning |
|---|---|
| `success` | `false` if the compile step failed (with `stderr_preview`). |
| `cpu`, `triple` | What the model was run for. |
| `region` | Which part was analysed: a function, the marked regions, or the whole file. |
| `instructions_in_region` | Instruction lines in the analysed text. |
| `summary` | `iterations`, `instructions`, `total_cycles`, `total_uops`, `dispatch_width`, `uops_per_cycle`, `ipc`, `block_rthroughput`. |
| `bottleneck` | The bottleneck section of the report, when present. |
| `report_preview` | The first 40 lines of the llvm-mca report. |
| `limitation` | The fixed limitation text below. |

The analysed assembly is kept as the view `region.s`.

### Example

```json
{
  "source": { "path": "examples/02-missed-vectorization-aliasing/scale.c" },
  "function": "scale",
  "cpu": "skylake",
  "flags": ["-O2", "-march=skylake"]
}
```

```sh
cea analyze_throughput --input input.json
```

### Limitations it records

- The fixed text: llvm-mca is a static model of the out-of-order core only. It ignores caches and memory latency beyond L1 hits, branch misprediction, the frontend (decoding, uop cache), page faults and frequency effects, and it assumes the block runs repeatedly in a straight line. Its cycle counts are not run-time measurements.
- If the source was compiled without `-march`, `-mcpu` or `-mtune`, a limitation says that the compiler chose instructions for its default CPU while llvm-mca models the CPU you named.
- If no function or region was selected, the whole file was modelled as one block.

### What it does not tell you

It does not tell you how long the code takes on real hardware. The inferred line "one iteration would cost about N cycles" holds only for a hot loop with no cache misses or mispredictions, and the unknown "actual run time on real hardware" is always recorded. Measure with `benchmark`.

## benchmark

### What it does and when to use it

Builds one or more variants of a program, checks that they all print the same output, and times repeated runs with warm-up. It reports the median and the spread for each variant, machine details, and a comparison with the baseline. A speed difference is reported as distinguishable only when the run-time ranges (minimum to maximum) of the two variants do not overlap.

Use it to settle a performance question such as "is the restrict version faster?" or "does this flag help?". It is deliberately conservative: with too few runs, too much noise, or overlapping ranges, it says that no difference is established.

How it works:

1. Every variant is built. A variant can use a different compiler, flags or even a different source file (for example the version with `restrict`).
2. Each built variant is run once for correctness. All must print the same stdout as the baseline (or exactly `expected_stdout` if you give it) and exit with status 0. A variant that fails this is disqualified and is not timed.
3. Warm-up runs, then timed runs. The runs are interleaved across variants (A, B, A, B, ...) so that machine drift affects all of them alike.
4. Statistics per variant: runs, median, min, max, mean, standard deviation, median absolute deviation, interquartile range and coefficient of variation. Each timed run also re-checks that the output is unchanged.

The timing is the wall-clock time of the whole process, including start-up.

### Inputs

| Name | Type | Default | Meaning |
|---|---|---|---|
| `source` | object | required | The program. Variants use it unless they give their own `source`. |
| `variants` | array of objects | required | One to eight variants. The first is the baseline (if it is disqualified, the first variant that passed the output check is used as the baseline instead). Each has `name` (letters, digits and `._+-`, at most 40 characters), `compiler` (default `"clang"`), `flags` (default `["-O2"]`) and an optional `source`. |
| `runs` | integer | `10` | Timed runs per variant, 5 to 200. Fewer than 5 is refused by the schema: no spread, no claim. |
| `warmup` | integer | `2` | Warm-up runs per variant, 0 to 20. |
| `run` | object | `{"args":[],"timeout_s":60}` | How to run each build; the timeout default is 60 seconds here. |
| `expected_stdout` | string | none | If given, every variant must print exactly this. Otherwise all variants must agree with the baseline. |

### Key result fields

| Field | Meaning |
|---|---|
| `machine` | `cpu_model`, `logical_cpus`, `platform`, `load_average`, `scaling_governor` (read from Linux sysfs, "unknown" elsewhere), `total_memory_gb`. |
| `variants` | For each variant name: `compiler`, `flags`, `built`, `outcome`, `stdout_sha256`, `output_correct`, `note`, `stats`, `samples_ms`, and `stderr_preview` if the build failed. |
| `stats` | `runs`, `median_ms`, `min_ms`, `max_ms`, `mean_ms`, `stddev_ms`, `mad_ms`, `iqr_ms`, `cv_percent`. |
| `comparisons` | For each variant after the first valid one: `variant`, `baseline`, `median_ratio`, `ranges_overlap`, `distinguishable`. |
| `output_check` | `expected_stdout` or "agreement with baseline". |
| `disqualified` | Names of variants that built but gave wrong output or timed out. |

`median_ratio` is the baseline median divided by the variant median, so a value above 1 means the variant was faster. The record's `summary` names the first comparison. If no variant produced correct output, the status is `inconclusive` and nothing was timed; if no variant built, the tool fails with `TOOL_FAILED`.

### Example

This is the example from [../examples/02-missed-vectorization-aliasing/](../examples/02-missed-vectorization-aliasing/).

```json
{
  "source": { "path": "examples/02-missed-vectorization-aliasing/scale.c" },
  "variants": [
    { "name": "baseline", "compiler": "clang", "flags": ["-O2"] },
    {
      "name": "restrict",
      "compiler": "clang",
      "flags": ["-O2"],
      "source": { "path": "examples/02-missed-vectorization-aliasing/scale_restrict.c" }
    }
  ],
  "runs": 10,
  "warmup": 2
}
```

```sh
cea benchmark --input input.json
```

### Limitations it records

- Wall-clock time of whole-process runs, including start-up and I/O, on one machine with one input. Runs are not pinned to a core, and no hardware counters are used.
- If the baseline median is under 50 ms, a limitation warns that process start-up is a large part of it; lengthen the workload.
- If any variant's coefficient of variation is above 5 percent, a limitation says the machine is noisy: close other work, pin the governor to performance, or raise `runs`.
- If any timed run produced different output than the correctness run, a limitation says the program is non-deterministic or failing intermittently and its timings are suspect.
- An unknown records that the result may not hold on other CPUs, inputs and data sizes.

### What it does not tell you

It does not tell you why one variant is faster, or that the difference will hold on other hardware or inputs. A result of "not distinguishable" means this experiment could not tell them apart, not that they are equal. Use `opt_remarks` and `analyze_throughput` to look for reasons.
