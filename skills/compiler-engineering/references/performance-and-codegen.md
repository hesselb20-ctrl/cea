# Performance and code generation

**When to read this.** Read this when asked to make code faster, to explain why a loop did not vectorise, to compare two compilers, flags or patches for speed, or to judge a claim like "this change gives 8%". Performance work fails in two typical ways: optimising code that is not hot, and reporting noise as a result. A third failure is worse: a faster program that computes a different answer. Back to the [skill overview](../SKILL.md).

## Rules that apply throughout

- **Semantics before speed.** Every speed comparison also checks that both versions produce the same output on the same inputs. Flags such as `-ffast-math` change results; state that they do.
- **Evidence before claims.** "Faster" needs a `benchmark` evidence ID (or equivalent raw data) with median, spread and run count. A static estimate from `analyze_throughput` is a hypothesis, not a measurement.
- **Small before large.** Find the hot loop, isolate it, then reason.
- State the machine (CPU model), compiler version, flags, target triple and input size with every number.

## Step 1: Profile first

```sh
perf stat -e cycles,instructions,branch-misses,cache-misses ./prog input   # counters, whole run
perf record -g ./prog input && perf report                                 # sampling, where time goes
perf annotate --stdio -s hot_function                                      # samples per instruction
```

- **Sampling** (`perf record`) tells you where time is spent, with statistical error; short functions and short runs are under-sampled.
- **Counters** (`perf stat`) tell you what kind of slowness it is: low instructions per cycle with many cache misses is memory-bound; many branch misses point at unpredictable control flow; high IPC with many instructions means too much work.
- Build with `-g` (and ideally `-fno-omit-frame-pointer`) for usable call stacks. Profile the optimised build, not `-O0`.
- On machines without `perf` (Windows, macOS), use the platform profiler; the reasoning is the same.

Only the functions with a large share of samples are worth changing.

## Step 2: Read the assembly of the hot loop

```sh
clang -O2 -march=native -S -masm=intel hot.c -o -       # or -march=<exact cpu> for reproducibility
```

cea: `compile` stores the assembly for the exact configuration. Look for: calls inside the loop, spills to the stack, scalar code where vector code was expected, unexpected conversions, and loads that are repeated because the compiler cannot prove memory unchanged. See the [backend guide](backend-and-hardware.md) for how to read the listing. Prefer `-march=<cpu>` over `-march=native` in reports, because "native" is not reproducible elsewhere.

## Step 3: Ask the compiler why

```sh
clang -O2 -Rpass=loop-vectorize -Rpass-missed=loop-vectorize -Rpass-analysis=loop-vectorize hot.c
clang -O2 -fsave-optimization-record hot.c         # YAML records for every pass
gcc -O2 -fopt-info-vec-missed hot.c
```

cea: `opt_remarks` collects passed and missed remarks with source locations. Common causes of a missed optimisation and the usual remedies:

| Cause | Symptom in remarks / asm | Remedy (check semantics first) |
|---|---|---|
| Possible aliasing | runtime alias checks, or "cannot prove pointers do not alias"; reloads after stores | `restrict` on pointers that truly do not overlap; local copies of values |
| Non-countable loop | "could not determine number of loop iterations" | rewrite with a simple counter and bound; avoid `!=` exits on pointers modified in the body; avoid early `break` where possible |
| Function call in loop | "call instruction cannot be vectorized" | make it inlinable (same TU, `static inline`, LTO), or hoist it |
| FP reduction or reassociation | "cannot reorder floating-point operations" | explicit permission: `-fassociative-math` (with `-fno-signed-zeros -fno-trapping-math`), `-ffast-math`, or `#pragma omp simd reduction(+:s)` with `-fopenmp-simd`; results can change |
| Unknown alignment or trip count | peeled loops, scalar epilogues | `__builtin_assume_aligned`, larger trip counts; often harmless |
| Unsigned wrap or narrow index types | extensions inside loop | use pointer-width index types |
| Cost model says not profitable | "vectorization is not beneficial" | believe it until a measurement says otherwise |

`#pragma clang loop vectorize(enable)` overrides the cost model, not legality; it cannot make an aliasing loop safe. Never add `restrict` or fast-math flags without checking that the program's semantics allow it: a `restrict` lie is UB, and fast-math can change results or break NaN handling.

## Step 4: Static throughput models

```sh
clang -O2 -S hot.c -o hot.s      # mark the loop with # LLVM-MCA-BEGIN / # LLVM-MCA-END comments
llvm-mca -mtriple=x86_64-linux-gnu -mcpu=skylake -timeline -bottleneck-analysis hot.s
```

uiCA (uica.uops.info) is a more detailed model for Intel cores. cea: `analyze_throughput` runs the static model and attaches its fixed limitation text.

What static throughput models **ignore**, always:

- caches and memory latency (every load hits L1);
- branch misprediction (loops are assumed to iterate forever);
- most frontend effects (decoding, uop cache, loop stream buffer), depending on the tool;
- memory disambiguation and store-to-load forwarding stalls;
- other threads, frequency changes, and everything outside the block.

Use them to compare two versions of the **same** inner loop on the **same** CPU model, and to find port pressure or long dependency chains. Never report their cycle counts as real run time.

## Step 5: Benchmark correctly

```sh
hyperfine --warmup 3 --runs 20 './prog_a input' './prog_b input'
taskset -c 2 ./prog input                          # pin to one core (Linux)
perf stat -r 20 ./prog input                       # repeated counter runs with variance
```

cea: `benchmark` refuses fewer than 5 runs, checks output, reports median and spread, and marks overlapping ranges as not distinguishable.

Statistics that matter:

- **Warm-up** runs are discarded (page cache, CPU frequency ramp, lazy binding).
- Report the **median**, not the mean; timing distributions are skewed by outliers.
- Report the **spread** (min-max, or interquartile range) and the number of runs.
- **Overlapping ranges mean no claim.** If A's range overlaps B's, say "not distinguishable at this noise level", not "A is slightly faster".
- Measure the **noise floor** first: run the same binary twice as A and B. Any difference smaller than that is noise.
- Control the machine: performance governor (changing the CPU frequency governor or turning off turbo is a system setting; ask the user first), core pinning, no other heavy processes, same input files, same environment size. Laptops on battery and shared CI runners are noisy.
- Interleave A and B runs (A B A B) rather than all A then all B, so drift affects both.
- Use enough work per run that timer resolution and process start-up do not dominate, or benchmark inside the program.
- **Check correctness alongside speed:** same output on every run, on several inputs, including edge cases.

## Worked example: an aliasing loop

```c
void scale(float *dst, const float *src, float k, int n) {
    for (int i = 0; i < n; i++) dst[i] = src[i] * k;
}
```

At `-O2` clang usually vectorises this behind a runtime overlap check, keeping a scalar fallback. A remark or the asm shows the check (a compare of the two address ranges before the vector loop). If the caller guarantees no overlap, `float *restrict dst, const float *restrict src` removes the check. That is a semantic promise: a caller that passes overlapping buffers now has UB. The procedure is:

1. `opt_remarks` evidence before and after, showing the change in vectorisation decisions.
2. `compile` evidence showing the asm difference.
3. `benchmark` evidence on realistic sizes, with output compared; for small `n` the check may cost nothing measurable.
4. A note in the report that every caller was checked for overlap, or an `unknown` saying it was not.

## Common codegen comparisons

- **Compiler A vs compiler B:** compare at the same `-O` level and `-march`; record both versions. Flags with the same name can differ in meaning across compilers.
- **Flag X on vs off:** keep everything else fixed, including link flags and LTO.
- **Patch vs baseline:** build both from the same tree with the same configuration; report per-benchmark results, not only a geometric mean.

## Reporting a result

A performance claim states: machine, compiler and version, flags, target, input, number of runs, median and spread for each variant, the noise floor, and that outputs matched. Cite the `benchmark`, `compile` and `opt_remarks` evidence IDs. List what is unknown (other CPUs, other inputs, effect at scale) with `record_unknown`.

## Checklist before you conclude

- [ ] The code changed is actually hot according to a profile.
- [ ] Both versions produce identical output on the same inputs; any flags that change FP semantics are named.
- [ ] Machine, compiler version, flags, target and input size are stated.
- [ ] `benchmark` (or equivalent) used warm-up, at least 5 runs, median and spread; the noise floor is known.
- [ ] Overlapping ranges are reported as "not distinguishable".
- [ ] Static model numbers (`analyze_throughput`, llvm-mca, uiCA) are labelled as estimates with their limitations.
- [ ] Every claim cites an evidence ID; observed, inferred and unknown are separate.
