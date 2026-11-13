# Example 3: Alive2 refutes a plausible rewrite

[`wrong.ll`](wrong.ll) is an InstCombine-style rewrite that looks obviously right:

```
(x + 1) >s x   ==>   true
```

It is wrong. Without the `nsw` flag the add wraps, so for `x = INT_MAX` the source is `false` and the target is `true`. [`correct-with-nsw.ll`](correct-with-nsw.ll) is the same rewrite with `add nsw`, the precondition that makes it valid.

These files were written for this example; they are not taken from LLVM.

## Run it

`validate_transform` needs `alive-tv`. If it is not installed, the remote provider uses the Alive2 project's online instance, and has to be switched on explicitly because it sends the IR to a third party:

```sh
CEA_REMOTE_PROVIDERS=compiler-explorer cea validate_transform --input examples/03-alive2-counterexample/wrong.json
CEA_REMOTE_PROVIDERS=compiler-explorer cea validate_transform --input examples/03-alive2-counterexample/correct-with-nsw.json
```

With a local `alive-tv` on `PATH`, drop the environment variable.

## What cea said

Recorded on 2026-11-13 through the remote provider (alive-tv at alive2.llvm.org).

`wrong.ll` (`ev_validate_transform_3c4353db`): **INCORRECT: src: Value mismatch**

```
Example:
i32 %x = #x7fffffff (2147483647)

Source:
i32 %a = #x80000000 (2147483648, -2147483648)
i1 %c = #x0 (0)

Target:
Source value: #x0 (0)
Target value: #x1 (1)
```

`correct-with-nsw.ll` (`ev_validate_transform_d0a1fb1d`): **correct within Alive2 bounds (1 function pair)**

## What it shows

- A test that passes on a thousand inputs would not have found `x = 2147483647`. Alive2 searches all of them.
- The difference between a correct and an incorrect rewrite here is one flag. Flags like `nsw` are promises made by whoever produced the IR; a rewrite may rely on them, and must drop them when it no longer holds them true.
- This is the same fact as example 1, seen from the compiler's side: the C frontend emits `add nsw` for signed addition, which is exactly why `-O2` may fold the comparison.
- "Correct" from Alive2 is bounded: loops are unrolled a fixed number of times, functions are checked one at a time, and type-based aliasing is not modelled. The evidence record lists those limits.
