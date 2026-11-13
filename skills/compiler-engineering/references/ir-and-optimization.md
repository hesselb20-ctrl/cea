# LLVM IR semantics and optimisation passes

**When to read this.** Read this before writing, reviewing or debugging an LLVM IR transformation (an InstCombine pattern, a new pass, a change to an existing pass), before claiming a pass is correct or incorrect, and when reading the IR before and after a pass during [miscompile triage](miscompile-triage.md). Most wrong transformations come from three mistakes: treating poison as an ordinary value, keeping a flag that no longer holds, and producing a target that is less defined than the source. The reference is the LangRef (llvm.org/docs/LangRef.html); this guide is the working subset. Back to the [skill overview](../SKILL.md).

## Rules that apply throughout

Semantics before speed: a rewrite is only interesting once it is correct. Evidence before claims: "this rewrite is valid" needs a `validate_transform` evidence ID (or an `alive-tv` run with its version), not an argument. Small before large: validate the pattern on a minimal function before running it on a test suite. State the LLVM version, the pass pipeline and the target triple (data layout matters for pointer sizes and alignment) with every result.

## Undefined values: poison, undef, freeze

- **poison** is the result of a broken promise (an `add nsw` that overflows, an out-of-bounds `getelementptr inbounds`). It propagates through most instructions. Branching on poison, using it as a memory address, or passing it to a `noundef` parameter is immediate UB. `select` with a poison condition is poison; with a non-poison condition it is poison only if the chosen arm is.
- **undef** is an arbitrary value that may differ at **each use**: `%y = add i32 %u, %u` with `%u = undef` need not be even. It is being phased out in favour of poison; new code should not create it.
- **freeze** turns poison or undef into one arbitrary but **fixed** value. It is how a transform makes a possibly-poison value safe to branch on or to use twice consistently.

Classic trap: `select i1 %a, i1 %b, i1 false` is a "logical and" that ignores `%b` when `%a` is false. Rewriting it to `and i1 %a, %b` is wrong, because poison in `%b` now leaks into the result when `%a` is false. The correct form is `and i1 %a, (freeze %b)`, or keep the `select`. This is why LLVM canonicalises short-circuit logic as `select`.

## Flags and attributes are promises

Each flag says "if this property does not hold, the result is poison" (or the program has UB). Removing a flag is always valid (it makes the program more defined). Adding or keeping one requires proof.

| Flag / attribute | Promise |
|---|---|
| `nsw`, `nuw` on `add`/`sub`/`mul`/`shl` | no signed / unsigned overflow, else poison |
| `exact` on `udiv`/`sdiv`/`lshr`/`ashr` | no non-zero remainder or shifted-out bits, else poison |
| `inbounds` on `getelementptr` | address stays within the allocated object (or one past it), else poison |
| `nnan`, `ninf` | operands and result are not NaN / infinity, else poison |
| `nsz`, `arcp`, `contract`, `afn`, `reassoc` | value-changing permissions (sign of zero, reciprocal, fused ops, approximate functions, reassociation); together with `nnan`/`ninf` they are what `-ffast-math` turns on |
| `noundef` (param/return) | value is neither undef nor poison, else UB |
| `nonnull`, `dereferenceable(n)`, `align n` | pointer property; violations give poison or UB depending on attribute and `noundef` |

When a rewrite builds a new instruction from an old one, ask for each flag: does the reasoning that justified it still hold for the new operands? If not, drop it. `(a + b) - b → a` is valid without flags; `add nsw` reassociated across other operands usually loses `nsw`, because intermediate sums can overflow where the original did not. When a transform moves an instruction to a place where it executes more often (hoisting out of a branch), flags and metadata that were justified by the branch condition must be dropped (`dropPoisonGeneratingFlags` in LLVM's C++ API).

## Refinement

A transform from source S to target T is correct if, for every input, T's behaviour is one of S's allowed behaviours. T may be **more** defined, never less:

- S has UB for an input: T may do anything for that input.
- S returns poison: T may return any value (or poison).
- S returns undef: T may return any single value.
- S returns a concrete value: T must return exactly that value, with the same side effects and memory state.

Worked example. `(x + 1) > x` folds to `true` only when the add is `nsw`:

```llvm
define i1 @src(i32 %x) {
  %a = add nsw i32 %x, 1
  %c = icmp sgt i32 %a, %x
  ret i1 %c
}
define i1 @tgt(i32 %x) {
  ret i1 true
}
```

With `nsw`, `x = INT_MAX` gives poison in `@src`, which `true` refines. Without `nsw`, `x = INT_MAX` wraps, `@src` returns `false`, and the fold is wrong.

## Checking a rewrite with Alive2

```sh
alive-tv src_and_tgt.ll          # one file with @src and @tgt
alive-tv before.ll after.ll      # functions matched by name
opt -passes=instcombine -S before.ll -o after.ll && alive-tv before.ll after.ll
```

cea: `validate_transform` runs the same check and stores the verdict, the counterexample (input values, source and target results) and the Alive2 version. An "incorrect" verdict comes with a concrete input; reproduce it before reporting.

What Alive2 cannot do; state these as limitations next to any "correct" verdict:

- **Bounded loops.** Loops are unrolled a fixed number of times; behaviour beyond the bound is not checked.
- **No interprocedural reasoning.** Calls to other functions are treated as unknown; a transform that relies on a callee's body is not verified.
- **Memory model limits.** Some memory features (certain intrinsics, complex pointer provenance, very large allocations) are approximated or unsupported; the tool says so.
- **Timeouts and resource limits.** A timeout is "unknown", never "correct". Wide integer multiplication and division and floating point are typical causes.
- It checks one function pair, at one LLVM version's semantics, for the given data layout.

## Testing a transform

Write three kinds of IR tests in the pass's test directory (see the [verification guide](verification-and-testing.md) for lit and FileCheck):

- **Positive:** the minimal pattern that should fire, with the expected output checked exactly.
- **Negative:** each precondition violated in turn (flag missing, wrong predicate, extra use, wrong type), expecting no change. Negative tests are the ones that catch unsound generalisations.
- **Edge cases:** vector types (including `poison` lanes in constant vectors), `i1` and odd widths such as `i7`, boundary constants (`0`, `-1`, `INT_MIN`), pointer address spaces, and operands that are themselves poison or `undef`.

Each positive test should also pass `alive-tv` on its own before/after pair.

## One-use checks

A pattern like `(a ^ -1) & b → ...` usually requires that the inner value has a single use (`m_OneUse` in `PatternMatch`). Without it, the original instruction stays alive for its other users and the rewrite adds instructions instead of removing them. This is a profitability rule, not a correctness rule; a missing one-use check shows up as code-size growth or infinite combine loops, not wrong output. Test it with a negative test where the inner value has a second user.

## Canonicalisation and phase ordering

Early passes rewrite equivalent forms into one canonical form (constants on the right of commutative ops, `icmp` predicates normalised, `sub x, C` written as `add x, -C`, short-circuit logic as `select`), so later passes need to match only one shape. Consequences:

- A new pattern should match the canonical form, not every equivalent variant. Write the test input in canonical form or run the canonicalising pass first.
- Two rewrites that each undo the other cause infinite loops in InstCombine; never add a rule that reverses an existing canonicalisation.
- Phase ordering: whether an optimisation fires depends on what ran before (inlining exposes constants, SROA turns memory into SSA values, loop rotation enables LICM). An optimisation "missing" at `-O2` may be an ordering issue, not a missing pattern. Check by running the pass alone on the IR right before its slot in the pipeline.

```sh
clang -O2 -Xclang -disable-llvm-passes -S -emit-llvm t.c -o t.ll   # pre-pipeline IR
opt -passes='default<O2>' -S t.ll -o t.O2.ll
opt -passes='sroa,instcombine,simplifycfg' -S t.ll                 # a hand-picked pipeline
opt -print-pipeline-passes -passes='default<O2>' -disable-output t.ll
```

cea: `emit_ir` captures the IR at a chosen stage with the exact flags in the evidence record.

## Reading `pass_timeline` output

`pass_timeline` runs a pipeline with printing enabled and records, per pass execution, whether a function changed, with the IR before and after kept as views. The plain-command equivalents are `opt -print-changed` and `opt -print-after-all -filter-print-funcs=f`. To read it:

1. Find the first pass where the property you care about changes (a flag appears, a load disappears, a loop is vectorised).
2. Open the before and after views for that pass and that function with `inspect_evidence_view`, filtered by a substring.
3. Extract that function pair and run `validate_transform` on it.
4. Remember that a pass can be correct and still produce IR that a later pass mishandles; the timeline shows where things changed, not who is wrong.

## Optimisation remarks

```sh
clang -O2 -Rpass=loop-vectorize -Rpass-missed=loop-vectorize -Rpass-analysis=loop-vectorize t.c
clang -O2 -fsave-optimization-record t.c   # YAML records next to the object
```

cea: `opt_remarks` collects passed, missed and analysis remarks with source locations. Remarks say what a pass decided and often why; they are not a correctness signal. See the [performance guide](performance-and-codegen.md) for interpreting missed optimisations.

## Checklist before you conclude

- [ ] LLVM version, pipeline (`-passes=` string or `-O` level) and target triple / data layout are stated.
- [ ] Every flag on every new instruction is justified or dropped; hoisted instructions lost their condition-dependent flags.
- [ ] The rewrite is checked with `alive-tv` / `validate_transform`; the evidence ID is cited and Alive2's bounds (loops, calls, timeouts) are listed as limitations.
- [ ] Positive, negative and edge-case tests exist, including a one-use negative test where relevant.
- [ ] The pattern matches the canonical form and does not reverse an existing canonicalisation.
- [ ] Claims about what a pass did cite `pass_timeline` or `emit_ir` evidence; observed, inferred and unknown are kept apart.
