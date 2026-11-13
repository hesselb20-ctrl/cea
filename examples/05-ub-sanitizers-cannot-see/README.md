# Example 5: undefined behaviour that sanitizers cannot see

[`alias.c`](alias.c) prints `1073741824` at `-O0` and `1` at `-O2`, and UBSan and ASan are both silent. This is the case where a "sanitizers are clean, so it must be the compiler" conclusion goes wrong.

```c
int store_both(int *i, float *f) {
  *i = 1;
  *f = 2.0f;
  return *i;
}
/* called as store_both(&x, (float *)&x) */
```

Writing a `float` through a pointer to an `int` object breaks the strict aliasing rule. The compiler assumes the two pointers do not overlap and returns `1` without re-reading `*i`.

## Run it

```sh
cea triage examples/05-ub-sanitizers-cannot-see/alias.c
```

## What cea said

Recorded on 2026-11-13 with clang 23.1.5 (llvm-mingw 20261104), target `x86_64-w64-windows-gnu`, with the remote Alive2 provider enabled. This time the chain runs to the end:

```
  [2] check_ub           ok  no sanitizer findings (undefined, address at O0, O1); not proof of
                             UB-freedom
  [3] differential_run   ok  DIVERGENCE: 2 distinct behaviours across 13 builds
  [4] bisect_passes      ok  first flipping pass: instcombine on store_both (limit 19 of 270)
  [5] reduce_testcase    ok  reduced 18 -> 10 lines with builtin
  [6] pass_timeline      ok  1 changing pass run(s) on store_both: InstCombinePass
  [9] validate_transform ??  Alive2 gave no verdict (the IR uses !tbaa, which Alive2 does not model)

  verdict: suspected_undetected_ub
  suspected undefined behaviour that sanitizers cannot see: the difference disappears with -fwrapv
  -fno-strict-aliasing -fno-delete-null-pointer-checks; behaviour flips at instcombine; the
  transformation relies on !tbaa (strict aliasing), which Alive2 cannot check
  compiler bug? unlikely
```

What the culprit pass changed, from the report:

```diff
 define dso_local i32 @store_both(ptr noundef %0, ptr noundef %1) local_unnamed_addr #0 {
   store i32 1, ptr %0, align 4, !tbaa !12
   store float 2.000000e+00, ptr %1, align 4, !tbaa !13
-  %3 = load i32, ptr %0, align 4, !tbaa !12
-  ret i32 %3
+  ret i32 1
 }
```

## Observed, inferred, unknown

Observed:

- No sanitizer finding at `-O0` and `-O1`.
- The two configurations print different output, and the same binary is stable across reruns.
- With `-fwrapv -fno-strict-aliasing -fno-delete-null-pointer-checks` added, `-O2` behaves like `-O0`.
- The behaviour flips when InstCombine runs on `store_both()`; it removes a load, and both stores carry `!tbaa` metadata.

Inferred:

- The transformation is justified by type-based aliasing, so it is valid exactly when the program obeys the strict aliasing rule. The program most likely does not.

Unknown:

- cea did not prove that the program violates strict aliasing. No tool in the chain can. A person has to read `main` and see the cast.

## What it shows

- A clean sanitizer run is "no sanitizer findings", never "no undefined behaviour".
- A pass named by bisection is where the behaviour flips, not necessarily where the fault is.
- The semantic-flag probe is what keeps this from being reported as a compiler bug. Had Alive2 been asked about this IR with the `!tbaa` metadata removed, it would have called the transformation incorrect, because it does not model type-based aliasing. `triage_miscompile` ranks the probe above that result for this reason.
- GCC agrees: `bisect_passes` with `"compiler": "gcc"` reports that disabling `-fstrict-aliasing` restores the reference behaviour.
