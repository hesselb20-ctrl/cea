# Example 2: a missed vectorisation caused by aliasing, fixed with `restrict`

[`scale.c`](scale.c) has a loop that should vectorise and does not:

```c
void scale(struct vec *v, int *out, int k) {
  for (int i = 0; i < v->n; i++)
    out[i] = v->data[i] * k;
}
```

`out` is an `int *` and `v->n` is an `int`. As far as the compiler can tell, the store to `out[i]` might overwrite `v->n`, so the loop bound has to be re-read every iteration and the trip count is unknown. [`scale_restrict.c`](scale_restrict.c) adds `restrict` to `out`, which promises that it does not alias anything else the function reads.

## Step 1: ask the optimiser why

```sh
cea opt_remarks --input examples/02-missed-vectorization-aliasing/remarks.json
```

Recorded on 2026-11-13 with clang 23.1.5 (llvm-mingw 20261104), `-O2`, target `x86_64-w64-windows-gnu` (`ev_opt_remarks_1127722c`):

```
missed   [loop-vectorize] scale line 14: loop not vectorized
analysis [loop-vectorize] scale line 14: loop not vectorized: Cannot vectorize uncountable loop
```

"Uncountable loop" is the observation. That the cause is aliasing between `out[i]` and `v->n` is an inference from reading the code; `restrict` is the experiment that tests it.

## Step 2: measure, with the output checked

```sh
cea benchmark --input examples/02-missed-vectorization-aliasing/benchmark.json
```

Same compiler and flags, AMD Ryzen 7 7800X3D, Windows 11, 10 timed runs after 2 warm-up runs (`ev_benchmark_7912f965`):

| Variant | Median | Range | CV | Output |
|---|---|---|---|---|
| baseline (`scale.c`) | 373.8 ms | 361.7 to 378.6 ms | 1.41% | reference |
| restrict (`scale_restrict.c`) | 105.3 ms | 103.0 to 107.4 ms | 1.20% | identical |

Result: the `restrict` variant is 3.55x faster by median, and the run-time ranges do not overlap. Both variants print the same checksum, which `benchmark` verifies before it times anything.

## What it shows

- Remarks say why an optimisation did not happen. They do not say whether it matters; the benchmark does.
- The speed claim comes with a median, a range, a run count, the machine and an output check. Without the non-overlapping ranges the tool would have reported "not distinguishable".
- Limits recorded with the evidence: wall-clock time of whole-process runs on one machine with one input, not pinned to a core, no hardware counters.
- `restrict` is a promise. If a caller passes overlapping pointers the behaviour is undefined, and example 1 shows where that leads. Copying `v->n` into a local before the loop is the alternative that needs no promise.
