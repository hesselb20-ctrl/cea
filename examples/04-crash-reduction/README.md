# Example 4: a compiler crash reduced from 88 lines to 2

[`crash.c`](crash.c) is an 88-line image-processing file that crashes clang.

The crash is constructed, and it is real: `#pragma clang __debug crash` is clang's own built-in "crash now" hook, which exists so that crash handling can be tested. Here it hides behind a macro, so a reducer has to keep both the macro definition and one use of it, and throw away everything else. Because the hook is part of clang, the example reproduces on any clang version instead of depending on a bug that gets fixed.

## Run it

```sh
cea reduce_testcase --input examples/04-crash-reduction/reduce.json
```

## What cea said

Recorded on 2026-11-13 with clang 23.1.5 (llvm-mingw 20261104), `-O2`, target `x86_64-w64-windows-gnu` (`ev_reduce_testcase_476545d0`):

```
Original crash reproduced; signature: "clang::PragmaHandler::~PragmaHandler"
Reduced from 88 lines (2438 bytes) to 2 lines (114 bytes) with builtin in 25 tests
The reduced case passes the interestingness test when re-run after reduction.
```

The reduced file:

```c
#define SATURATE(x) _Pragma("clang __debug crash") CLAMP((x), 0, 255)
    p->r = (uint8_t)SATURATE(p->r + amount);
```

## How it works

1. `reduce_testcase` compiles the original and confirms that the compiler crashes (a stack dump, not an ordinary error).
2. It derives a crash signature. There is no assertion text in this crash, so it takes the innermost symbolised stack frame. The signature is what keeps the reduction on the same crash.
3. It writes `interesting.mjs`, a Node script that exits 0 only if the compiler still crashes with that signature. The script is kept as a view of the evidence record and can be run by hand or handed to cvise.
4. It runs a reducer, then re-runs the test on the result. A reducer's word is not taken for it.

This run used the built-in line reducer because neither cvise nor creduce is installed on the recording machine; the record says so. With cvise the same command would also strip the unused macro arguments.

## What it shows

- The two lines that remain do not compile as C on their own, and that is fine: the test is "the compiler crashes the same way", and it does. For a miscompile the test is much stricter (see [example 5](../05-ub-sanitizers-cannot-see/README.md)).
- The stack frame used as the signature is whatever the symboliser printed on this platform. On Linux the frame name is different, and so is the signature.
