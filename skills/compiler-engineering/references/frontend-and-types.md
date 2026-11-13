# Frontends: parsing, type systems, diagnostics

**When to read this.** Read this when building or changing a lexer, parser, name resolver or type checker, when designing a type system or its inference, and when improving error messages. cea's tools start at the IR and go down (`emit_ir`, `compile`, `pass_timeline`, ...); they do not inspect ASTs or type derivations. Frontend work therefore relies on the frontend's own tests (parse trees, typed ASTs, diagnostic snapshots) plus `compile` and `emit_ir` to see what the frontend handed to the backend. Back to the [skill overview](../SKILL.md).

## Rules that apply throughout

Semantics before speed: write down what a construct means before choosing how to parse or check it. Evidence before claims: "the grammar is unambiguous" or "the type system is sound" are claims; back them with tests, a proof sketch, or a counterexample search, and say which. Small before large: one minimal failing input per bug. For lowering bugs, state the frontend version and flags and cite the `emit_ir` evidence ID showing the IR it produced.

## Grammar first

Write the grammar (EBNF is enough) before the parser. Decide explicitly:

- precedence and associativity of every operator, including unary, postfix, assignment and comparison chains (is `a < b < c` legal?);
- statement terminators and where newlines matter;
- known ambiguities (dangling `else`, generic `<` vs less-than, cast vs parenthesised expression) and the rule that resolves each.

Keep the grammar in the repo next to the parser and add one test per production.

## Recursive descent and Pratt parsing

Recursive descent: one function per nonterminal, one token of lookahead in the common case. It gives direct control over errors and recovery, which is why most production compilers use hand-written parsers.

For expressions, use **Pratt parsing** (precedence climbing): each operator has a left and right binding power. Left-associative operators have `right = left + 1`; right-associative ones have `right < left`.

```python
INFIX  = {'+': (1, 2), '-': (1, 2), '*': (3, 4), '/': (3, 4), '^': (6, 5)}
PREFIX = {'-': 5}

def expr(min_bp=0):
    tok = next_token()
    if tok in PREFIX:
        lhs = ('neg', expr(PREFIX[tok]))
    elif tok == '(':
        lhs = expr(0); expect(')')
    else:
        lhs = atom(tok)
    while (op := peek()) in INFIX:
        l_bp, r_bp = INFIX[op]
        if l_bp < min_bp:
            break
        next_token()
        lhs = (op, lhs, expr(r_bp))
    return lhs
```

Trace for `a - b - c`: parse `a`; see `-` (l_bp 1 >= 0), parse the right side with min_bp 2: parse `b`, see `-` (1 < 2), stop. Result `(a - b)`; loop sees the second `-`, giving `((a - b) - c)`. For `a ^ b ^ c`, the right side is parsed with min_bp 5 and the next `^` has l_bp 6 >= 5, so it nests right: `a ^ (b ^ c)`. For `-a * b`, prefix minus parses its operand with bp 5, `*` (3) stops it: `(-a) * b`; for `-a ^ b`, `^` (6) binds tighter: `-(a ^ b)`.

## Spans on every node

Every token and every AST node carries a source span (file, start offset, end offset; derive line and column on demand). Spans must survive desugaring: a node produced by lowering `for` into `while` points at the original `for`. Without spans you cannot write good diagnostics, debug info, or coverage mapping. Test this: a snapshot test that prints spans for a small program catches lost locations early.

## Error recovery

A parser that stops at the first error is unusable in an editor and hides later errors.

- **Synchronisation tokens:** on error, record a diagnostic, then skip tokens until one that can start or end a construct at the current level (`;`, `}`, a statement keyword, `fn`), and resume.
- **Error nodes:** insert an `Error` node with the span of the skipped tokens instead of dropping the subtree. Later phases treat `Error` as having an error type that unifies with everything and produces no further diagnostics.
- **Avoid cascades:** never report errors that mention an error node or error type; deduplicate errors at the same span; cap the number of reported errors.
- **Missing tokens:** if the next token is exactly what a closing delimiter would make valid, report "expected `)`" and pretend it was there.

Test recovery with inputs that contain two independent errors and assert that exactly two diagnostics appear.

## Typing judgments

Write the rules as judgments `Γ ⊢ e : τ` before coding them. Two examples:

```
Γ ⊢ e1 : τ1 → τ2    Γ ⊢ e2 : τ1             Γ, x : τ1 ⊢ e : τ2
--------------------------------- (App)     ----------------------------- (Abs)
        Γ ⊢ e1 e2 : τ2                        Γ ⊢ λx:τ1. e : τ1 → τ2
```

Each rule becomes one case in the checker. If a case in the code has no rule, the type system has an undocumented feature; if a rule has no case, the checker is incomplete.

## Choosing an inference strategy

| Approach | Strengths | Limits | Choose when |
|---|---|---|---|
| Hindley-Milner (algorithm W / unification) | full inference, principal types, let-polymorphism | no subtyping, no higher-rank types without annotations; errors appear far from the cause | ML-like languages with few annotations |
| Bidirectional checking | separates *checking* against a known type from *synthesising* one; handles subtyping, higher-rank and dependent types with annotations at boundaries; errors are local | needs annotations on top-level definitions and some lambdas | languages with subtyping, rich types, or where good errors matter most |
| Constraint generation + solving | generate constraints, then solve; extends to type classes/traits, records, GADTs; the solver can choose which constraint to blame | more machinery; solver order affects error quality and performance | type classes or traits, overloading, row types |

Many real systems combine them: bidirectional at the top, unification for local holes.

## Soundness traps

Soundness means well-typed programs do not go wrong (no type confusion at run time). Common ways to lose it:

- **Variance of mutable references.** A mutable container must be invariant in its element type. Covariant mutable arrays (as in Java) need a run-time store check; without it, storing a `Cat` into an `Animal[]` that is really a `Dog[]` corrupts memory. Function parameters are contravariant, results covariant.
- **Generalising effectful expressions.** In ML, generalising `let r = ref []` gives `r : ∀a. a list ref`, so one can store an `int` and read a `string`. The value restriction (only generalise syntactic values) or a relaxed variant fixes it.
- **Unsound escape hatches.** Unchecked casts, `any`, `unsafe`, and bivariant parameter checking break soundness by design. If the language has them, document where, and never let the optimiser trust types that crossed one.
- **Missing occurs check.** Unifying `α` with `α → β` must fail; without the check, unification builds an infinite type or loops.
- **Coherence.** With type classes or traits, two different instances for the same type in different modules make program meaning depend on which one is in scope. Use orphan rules or forbid overlap.
- **Optimiser trust.** If the backend emits `nonnull`, `noalias` or `noundef` because the type system says so, any hole in the type system becomes a miscompile. Check what the frontend emits with `emit_ir`.

Look for counterexamples, not just confirmations: write small programs that try to exploit each trap and assert they are rejected.

## Good diagnostics

- **Primary span** on the exact token or expression at fault, plus secondary spans for related locations ("first defined here").
- **Cause** in one sentence, using the user's names and types as written, not internal type variables.
- **Fix-it** when the fix is mechanical and unambiguous (missing `;`, misspelled name with one close match), as a machine-applicable edit.
- **One error per root cause:** suppress follow-on errors from error nodes and error types.
- Stable wording, tested with snapshot tests (input file plus expected diagnostic output). Clang's `-verify` mode (`// expected-error {{...}}` comments) is one model for this.

## Inspecting what the frontend produced

```sh
clang -fsyntax-only -Xclang -ast-dump t.c          # clang's AST, for comparison
clang -O0 -S -emit-llvm t.c -o -                    # IR as lowered, before optimisation
rustc --emit=llvm-ir -C opt-level=0 t.rs
```

cea: `emit_ir` records the IR with exact flags and tool versions; `compile` records the produced object or assembly. Use them to confirm lowering decisions (signedness of operations, which attributes and flags the frontend promised) and cite the evidence IDs. For anything above the IR, the frontend's own test suite is the evidence.

## Checklist before you conclude

- [ ] The grammar is written down, including precedence, associativity and resolved ambiguities.
- [ ] Every AST node has a span, and spans survive desugaring.
- [ ] Recovery is tested with multi-error inputs; no cascaded diagnostics.
- [ ] Typing rules exist for every checker case, and soundness traps were probed with counterexample programs.
- [ ] Diagnostics have a primary span, a cause, and a fix-it where mechanical.
- [ ] Lowering claims cite `emit_ir` or `compile` evidence with version and flags; claims above the IR cite tests, and the rest is listed as unknown.
