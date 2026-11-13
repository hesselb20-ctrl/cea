# Example 1: a "compiler bug" that is undefined behaviour

[`overflow.c`](overflow.c) prints `0` at `-O0` and `1` at `-O2`. That looks like a miscompile. It is not.

```c
static int check(int x) { return x + 1 > x; }
int main(void) { int v = INT_MAX; printf("%d\n", check(v)); return 0; }
```

`INT_MAX + 1` overflows a signed `int`, which is undefined behaviour in C. At `-O0` the addition wraps and the comparison is false. At `-O2` the optimiser folds `x + 1 > x` to `true`, which it may do because signed overflow cannot happen in a well-defined program.

## Run it

```sh
cea triage examples/01-ub-not-a-compiler-bug/overflow.c
```

or the single step that settles it:

```sh
cea check_ub --input examples/01-ub-not-a-compiler-bug/check_ub.json
```

## What cea said

Recorded on 2026-11-13 with clang 23.1.5 (llvm-mingw 20261104), target `x86_64-w64-windows-gnu`. Evidence IDs are from that run and will differ on yours.

```
cea triage examples/01-ub-not-a-compiler-bug/overflow.c  clang -O2 vs -O0
  [1] environment        ok  9/19 providers available; compilers: clang (x86_64-w64-windows-gnu),
                             gcc (x86_64-w64-mingw32)
      evidence ev_environment_report_84b6d483
  [2] check_ub           ok  UB found: signed integer overflow: 2147483647 + 1 cannot be represented
                             in type 'int' at overflow.c:3
      evidence ev_check_ub_6a29004c

  verdict: undefined_behavior
  UB found at overflow.c:3:36 (signed integer overflow: 2147483647 + 1 cannot be represented in type
  'int'), not a compiler bug
  compiler bug? no
```

The chain has seven steps and stopped after two. Bisecting passes or reducing the file would have produced plausible-looking output about a "culprit pass" for a program that has no correct answer.

The same run is the recorded demo: [`docs/demo/triage.gif`](../../docs/demo/triage.gif).

## What it shows

- The first question in a miscompile report is whether the program is well-defined, and a sanitizer run answers it in under a second here.
- `reduce_testcase` refuses this file for the same reason: its interestingness test will not accept a case that is not clean under sanitizers.
- The fix is in the program: compare before adding (`x < INT_MAX`), or use unsigned arithmetic, or compile with `-fwrapv` if wrapping is what you mean.
