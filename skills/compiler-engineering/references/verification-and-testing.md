# Verification and testing of compilers

**When to read this.** Read this when writing regression tests for a compiler change, choosing between test generation, fuzzing and formal methods, setting up random-program testing, interpreting a bootstrap failure, or deciding how much a "verified compiler" guarantees. Also read it whenever a test fails and the tempting fix is to loosen the check or turn a verifier off. Back to the [skill overview](../SKILL.md).

## Rules that apply throughout

Semantics before speed: a test asserts a property of meaning or of output, not a snapshot of whatever the compiler emits today. Evidence before claims: "tested" means a named test, run with a stated compiler build, with a result you can cite (an evidence ID or test log). Small before large: a minimal test that names the property beats a large test that happens to cover it. State the compiler version (including whether it is an assertions-enabled build), flags and target for every result.

## lit and FileCheck

LLVM's test runner is `lit`; each test file declares how it is run in `RUN:` lines, and `FileCheck` matches the output against `CHECK` lines in the same file.

```llvm
; RUN: opt -passes=instcombine -S < %s | FileCheck %s

; Property: (x + 1) > x folds to true only when the add is nsw.
define i1 @fold_nsw(i32 %x) {
; CHECK-LABEL: @fold_nsw(
; CHECK-NEXT:    ret i1 true
  %a = add nsw i32 %x, 1
  %c = icmp sgt i32 %a, %x
  ret i1 %c
}

define i1 @no_fold_without_nsw(i32 %x) {
; CHECK-LABEL: @no_fold_without_nsw(
; CHECK:         icmp
; CHECK-NOT:     ret i1 true
  %a = add i32 %x, 1
  %c = icmp sgt i32 %a, %x
  ret i1 %c
}
```

| Directive | Meaning |
|---|---|
| `CHECK:` | pattern appears, after the previous match |
| `CHECK-NEXT:` | pattern is on the line right after the previous match |
| `CHECK-SAME:` | pattern continues on the same line as the previous match |
| `CHECK-NOT:` | pattern does not appear between the surrounding matches |
| `CHECK-LABEL:` | splits the output into blocks, so a failure in one function cannot match text from another |
| `CHECK-DAG:` | patterns appear in any order |

Use `[[VAR:%.*]]` to capture a name and `[[VAR]]` to reuse it, `{{regex}}` for regular expressions, and `--check-prefixes=A,B` for several RUN configurations in one file. Run tests with `llvm-lit -v path/to/test.ll`.

`llvm/utils/update_test_checks.py` (and `update_llc_test_checks.py`, `update_cc_test_checks.py`, `update_mir_test_checks.py`) regenerate the CHECK lines from the current output. They are convenient and dangerous: they record whatever the compiler does now, bugs included. After running one, read the diff and confirm every changed line is intended.

Test-writing rules:

- **Minimal:** the smallest function that shows the property; no unrelated instructions.
- **Name the property** in the function name and a comment (`@no_fold_without_nsw`), so a failure says what broke.
- Pair each positive test with negative tests (see the [IR guide](ir-and-optimization.md)).
- `CHECK-NOT` alone is weak: it passes when the output is empty or the pattern is misspelled. Combine it with a positive check in the same block.
- Pin the triple (`-mtriple=` or a `target triple` line) for codegen tests.

## Translation validation versus verified compilation

- **Translation validation** checks each individual compilation: given source and output, prove the output refines the source. Alive2 does this for LLVM IR functions. It finds bugs in the cases you run, needs no proof of the compiler, and inherits the validator's bounds (loop unrolling, timeouts, unsupported features). cea: `validate_transform`.
- **Verified compilation** proves once, in a proof assistant, that the compiler preserves semantics for every valid input program. It gives a much stronger guarantee for what it covers, at very high engineering cost, and only for the compiler that was verified.

## Random program generation

| Tool | Generates | Finds | Oracle |
|---|---|---|---|
| Csmith | random C programs free of the UB it knows about, printing a checksum of global state | middle-end and backend miscompiles and crashes | differential: compare checksums across compilers and levels |
| YARPGen | random C/C++ programs designed to avoid UB and to trigger specific optimisations (later versions target loop optimisations) | miscompiles in optimisations that Csmith-style programs rarely reach | differential |
| EMI (equivalence modulo inputs) | variants of an existing program that differ only in code not executed for a given input (for example deleting or inserting dead code) | miscompiles, using the fact that all variants must behave the same on that input | metamorphic: compare the variants with each other |

```sh
csmith --seed 12345 > t.c
clang -O0 -w -I"$CSMITH_INCLUDE" t.c -o t0 && ./t0 > o0     # CSMITH_INCLUDE: Csmith's runtime headers
clang -O2 -w -I"$CSMITH_INCLUDE" t.c -o t2 && ./t2 > o2
cmp o0 o2
```

Each generator only explores the language subset it emits. A clean run says nothing about features it never generates. Generated programs can still hit UB the generator does not model, so check a failing case with sanitizers before reducing. cea: `fuzz_compiler` runs a generator with a differential oracle and records seeds, so every finding is reproducible; `differential_run` compares configurations on a given program.

## Fuzzing the compiler itself

- **libFuzzer on a component:** link a fuzz target that feeds bytes to the lexer or parser and build with `-fsanitize=fuzzer,address`. This finds crashes, hangs and assertion failures in parsing, not miscompiles. LLVM ships fuzz targets such as `clang-fuzzer`, `llvm-opt-fuzzer` and `llvm-isel-fuzzer`.
- **Structure-aware fuzzing:** random bytes rarely get past the parser. Mutate a structured representation instead (a protobuf grammar via libprotobuf-mutator, or IR-level mutation) so inputs are valid enough to reach the optimiser and backend.
- **Oracles:** crashes and sanitizer reports are free; for semantic bugs add a differential or translation-validation oracle.
- Keep the corpus and every crashing input; a fuzzer finding without the input is not evidence.

## Choosing a method

| Question | Method | cea tool |
|---|---|---|
| Is this one rewrite correct? | translation validation on the before/after pair | `validate_transform` |
| Does this change break known behaviour? | lit regression tests, plus the project's full test suite | (run the suite; cite the log) |
| Does the compiler miscompile programs nobody wrote yet? | random generation with a differential oracle | `fuzz_compiler`, `differential_run` |
| Does it crash on malformed input? | libFuzzer or structure-aware fuzzing with sanitizers | (fuzz target; keep the corpus) |
| Is the whole compiler self-consistent? | bootstrap with stage comparison | (build logs) |
| Must there be no miscompiles at all for a subset? | a verified compiler, with its exclusions | (not a cea step) |

These are complementary. Regression tests protect what was fixed; generators and fuzzers find what nobody thought of; validation checks the cases at hand; proofs cover a fixed specification. None replaces the others, and none supports "no bugs" as a claim. Report what was exercised (seeds, number of programs, features covered) in the `coverage` of the evidence and what was not as unknowns.

## A regression test for a fixed miscompile

When a miscompile is fixed, add the reduced case as a test at the lowest level that shows it: an `opt` test for an IR pass, an `llc` test for codegen, and only rarely an end-to-end execution test. Check the property, not the whole output:

```llvm
; RUN: opt -passes=instcombine -S < %s | FileCheck %s
; Property: a logical and (select) must not become a bitwise and,
; because poison in %b would then leak when %a is false.
define i1 @logical_and_not_bitwise(i1 %a, i1 %b) {
; CHECK-LABEL: @logical_and_not_bitwise(
; CHECK-NEXT:    [[R:%.*]] = select i1 [[A:%.*]], i1 [[B:%.*]], i1 false
; CHECK-NEXT:    ret i1 [[R]]
  %r = select i1 %a, i1 %b, i1 false
  ret i1 %r
}
```

Pair it with a test showing the optimisation still fires where it is valid, so the fix is not "never optimise". Run `alive-tv` on the before/after of both.

## Reducing findings

Every finding from generation or fuzzing must be reduced before it is reported, with an interestingness test that pins the same crash signature or the same wrong output and stays UB-free. See [miscompile triage](miscompile-triage.md). cea: `reduce_testcase`.

## Bootstrap and stage comparison

A self-hosting compiler is built three times: stage 1 by the host compiler, stage 2 by stage 1, stage 3 by stage 2. Stages 2 and 3 were built by compilers from the same source, so their outputs should be identical (GCC's bootstrap compares stage 2 and stage 3 object files; LLVM supports a multi-stage CMake bootstrap). A difference means the compiler miscompiles itself or is non-deterministic (hash ordering, timestamps, uninitialised memory, embedded paths). Bootstrap is a strong whole-compiler test because the compiler is a large, demanding program, but it only exercises the features the compiler's own source uses.

## Verified compilers: what is guaranteed

- **CompCert** (compcert.org): a C compiler whose semantic preservation is proved in Coq, from its C semantics down to assembly, for several targets. The guarantee: if the source program has defined behaviour under CompCert's C semantics, the generated assembly behaves as the source. It does **not** cover programs with undefined behaviour, preprocessing, the assembler and linker (external tools), libraries and the operating system, the hardware, or whether CompCert's formal C semantics match the ISO standard and your intent. Some components outside the proof are checked by validators rather than proved.
- **CakeML** (cakeml.org): a verified implementation of an ML dialect in HOL4, with an end-to-end proof down to machine code for several targets, including a compiler bootstrapped inside the logic. It excludes the correctness of the hardware and the machine models, foreign function interface calls and the operating system, and the trusted logic kernel; running out of memory is an allowed outcome rather than a violation.

Verified compilers move trust to the specifications and the trusted base; they do not remove it. When citing either, say which version and which target.

## Never disable a verifier to pass a test

LLVM's IR verifier (on by default in `opt` and after many passes; `opt -verify-each` checks after every pass), the machine verifier (`llc -verify-machineinstrs`), and assertions (`-DLLVM_ENABLE_ASSERTIONS=ON` builds) exist to catch invalid states early. A test that passes only with `-disable-verify`, with assertions off, or with a loosened CHECK line hides a bug that will reappear as a miscompile later. If a verifier fires, the IR or machine code is invalid: fix the producer. Test new passes on an assertions-enabled build; release builds skip many checks.

## Checklist before you conclude

- [ ] Tests are minimal, name the property, and pair positive with negative cases; `CHECK-LABEL` separates functions.
- [ ] Any regenerated CHECK lines were reviewed line by line.
- [ ] Generator and fuzzer findings record the seed or input, the oracle, and the compiler version; they were checked for UB and reduced.
- [ ] Claims of coverage name what the generator or fuzzer does not produce.
- [ ] Translation-validation results list the validator's bounds; verified-compiler claims list what the proof excludes.
- [ ] No verifier or assertion was disabled; the build type (assertions on or off) is stated.
- [ ] Every claim cites an evidence ID or test log; observed, inferred and unknown are separate.
