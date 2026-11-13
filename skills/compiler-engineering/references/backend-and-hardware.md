# Backends, ABIs and hardware

**When to read this.** Read this when working below the IR: calling-convention or ABI mismatches, instruction selection or legalisation failures, register allocation and spilling, scheduling, frame layout and unwind info, JIT code emission, or code for a target you cannot run natively. Also read it before drawing conclusions from disassembly. Back to the [skill overview](../SKILL.md).

## Rules that apply throughout

Every statement about generated code depends on the **target triple, CPU and features** (`-mcpu`, `-march`, `-mattr`), the compiler version and the flags. State all of them first. Evidence before claims: cite the `compile` evidence ID for the assembly or object you read. Semantics before speed: an ABI violation that happens to work today is still a bug. Separate observed (the instructions in the listing) from inferred (why the compiler chose them) and unknown.

## ISA versus ABI

The **ISA** defines instructions and registers. The **ABI** is a convention layered on top: how arguments and results are passed, which registers survive a call, stack alignment, struct layout, and how unwinding works. Two correct compilers that disagree on the ABI produce code that links and then fails.

| | x86-64 System V (Linux, macOS) | x86-64 Windows | AArch64 AAPCS64 (Linux) |
|---|---|---|---|
| Integer args | rdi, rsi, rdx, rcx, r8, r9 | rcx, rdx, r8, r9 | x0-x7 |
| FP args | xmm0-xmm7 | xmm0-xmm3 (positional, shared slots with integer args) | v0-v7 |
| Return | rax (rdx), xmm0 (xmm1) | rax, xmm0 | x0 (x1), v0-v3 |
| Callee-saved | rbx, rbp, r12-r15 | rbx, rbp, rdi, rsi, r12-r15, xmm6-xmm15 | x19-x28, x29 (FP), low 64 bits of v8-v15 |
| Stack alignment | 16 bytes at the call instruction | 16 bytes; caller reserves 32 bytes of shadow space | sp always 16-byte aligned |
| Red zone | 128 bytes below rsp | none | none (Darwin differs; check the platform ABI) |

Things that commonly go wrong:

- **Struct passing.** System V classifies aggregates of up to 16 bytes into integer/SSE eightbytes and passes them in registers; larger ones go in memory. Windows x64 passes structs of size 1, 2, 4 or 8 in a register and everything else by reference to a caller-made copy. In LLVM, the frontend does this lowering (`byval`, `sret`, coerced types); a frontend that gets it wrong produces IR that is internally consistent but ABI-incompatible with C.
- **Red zone.** Leaf functions may use the 128 bytes below rsp without adjusting it. Signal handlers and interrupt code that write below rsp destroy it; kernels build with `-mno-red-zone`.
- **Stack misalignment** shows up as a crash in an aligned SSE/AVX store far from the cause (often inside a library call).
- **Variadic functions** have their own rules (System V passes the number of vector registers used in `al`).

Test ABI compatibility by compiling caller and callee with different compilers and calling across the boundary with every struct shape and argument count you support.

## Instruction selection and legalisation

LLVM lowers IR to machine instructions through one of two frameworks:

- **SelectionDAG:** builds a DAG per basic block, legalises types and operations, combines, then matches patterns (mostly generated from TableGen `.td` files) into target instructions. Mature, used by default on most targets, but sees one block at a time.
- **GlobalISel:** works on a generic machine IR across the whole function in stages: IRTranslator, Legalizer, RegBankSelect, InstructionSelect. Default on some targets and configurations (for example AArch64 at `-O0`); select it explicitly with `llc -global-isel`.

**Legalisation** turns operations the target cannot do directly into ones it can: widen `i7` to `i32`, split `i128` into two `i64`, expand a vector operation into scalars, turn an unsupported operation into a library call. A "cannot select" error means some node reached selection without a legal pattern; the fix belongs in legalisation or a missing pattern, not in disabling the verifier.

```sh
llc -mtriple=aarch64-linux-gnu -O2 t.ll -o t.s
llc -mtriple=x86_64-linux-gnu -O2 -print-after-all t.ll -o /dev/null 2>&1 | less
llc -mtriple=aarch64-linux-gnu -global-isel -O0 t.ll -o -
llc -verify-machineinstrs ...       # keep the machine verifier on while testing
```

## Register allocation

- **Liveness:** a value is live from its definition to its last use. Two values that are live at the same time **interfere** and need different registers.
- **Spilling:** when there are not enough registers, some live ranges go to stack slots, with loads and stores inserted. Spill code in a hot loop is a common performance problem; look for stack-relative loads and stores inside the loop body.
- **Algorithms:** graph colouring (Chaitin-Briggs style) builds an interference graph and colours it, good quality, more compile time. Linear scan walks live intervals in order, fast, used where compile time matters (JITs). LLVM's default **greedy** allocator assigns by priority and splits live ranges before spilling; `-O0` uses the fast allocator. Select others in `llc` with `-regalloc=basic|greedy|fast|pbqp` for comparison.
- Allocation bugs usually look like a value being clobbered across a call or in a loop back edge. `-verify-machineinstrs` catches many liveness inconsistencies.

## Scheduling

Instructions are reordered before register allocation (to expose parallelism, at the risk of raising register pressure) and after it (to hide latencies with a fixed register assignment). LLVM uses per-CPU scheduling models from TableGen; `-mcpu` selects the model. The same models feed `llvm-mca`, so a wrong model gives wrong schedules and wrong static estimates together. cea: `analyze_throughput` runs `llvm-mca` on a block; see the [performance guide](performance-and-codegen.md) for its limits.

## Frame layout and unwind info

The prologue saves callee-saved registers and sets up the frame; the epilogue restores them. **Unwind info** describes, for every instruction address, where the caller's registers and return address are:

- On ELF and Mach-O: DWARF CFI in `.eh_frame` (`.cfi_def_cfa_offset`, `.cfi_offset` directives in assembly).
- On Windows x64: SEH unwind codes in `.pdata`/`.xdata` (`.seh_*` directives).

A wrong CFI is a **silent bug**: the code runs correctly until something unwinds through that frame (a C++ exception, a profiler's stack walk, a debugger backtrace, a sanitizer report). Then it crashes or produces a wrong stack far from the cause. Check unwind info explicitly:

```sh
llvm-dwarfdump --eh-frame t.o       # or: readelf --debug-dump=frames t.o
llvm-readobj --unwind t.obj         # Windows unwind info
```

Test by throwing an exception through every new prologue shape (with and without frame pointer, with dynamic `alloca`, with large frames that need stack probing).

## JIT concerns

- **W^X:** map memory read-write, write the code, then switch to read-execute (`mprotect`). Never keep pages writable and executable. On Apple Silicon, JIT memory uses `MAP_JIT` and per-thread write protection toggling.
- **Instruction cache:** on AArch64 and other non-coherent architectures, call `__builtin___clear_cache(begin, end)` (or the OS equivalent) after writing code and before executing it. x86 keeps caches coherent, so a missing flush passes tests on x86 and fails on ARM.
- **Relocations:** JIT code must resolve calls and data references. PC-relative 32-bit displacements limit distance to about ±2 GiB; use stubs or a code model that allows far targets.
- **Unwind and debug registration:** JIT frames need their unwind info registered with the runtime, or exceptions and profilers cannot walk through them.
- **Deoptimisation:** speculative JITs record, at each guard, how to rebuild the interpreter state (LLVM offers stack maps and `deopt` operand bundles for this). Test deopt paths explicitly; they rarely run in normal tests.

## Testing foreign targets with QEMU user mode

```sh
clang --target=aarch64-linux-gnu --sysroot=/usr/aarch64-linux-gnu -fuse-ld=lld -O2 t.c -o t.arm64
qemu-aarch64 -L /usr/aarch64-linux-gnu ./t.arm64
```

QEMU user mode runs the binary on the host's kernel. It checks semantics, not performance; timing under emulation means nothing. It also may not model every memory-ordering behaviour of real hardware, so it cannot clear concurrency bugs. cea: `differential_run` can compare outputs across targets and levels; record the emulator version as part of the configuration.

## Reading disassembly

```sh
clang -O2 -S -masm=intel t.c -o -                  # assembly from the compiler
objdump -d -M intel --no-show-raw-insn t.o         # GNU objdump on the object
llvm-objdump -d --disassemble-symbols=f t.o        # one function
```

cea: `compile` produces assembly or an object for a given target triple and stores it as a view. When reading:

1. Find the function and its prologue; note which callee-saved registers are saved and the frame size.
2. Find loops by backward branches; the hot loop is usually the innermost one.
3. Check for spills (`[rsp + ...]` or `[sp, #...]` loads and stores) and calls inside the loop.
4. Check whether vector instructions are used and with which width.
5. Compare against the source with debug line info (`-g`, then `objdump -dl` or Compiler Explorer at godbolt.org, which sends code to a third party).

A short annotated example (x86-64 System V, `-O2`):

```asm
sum:                          # long sum(const long *p, long n)
        xor     eax, eax      # acc = 0 (rax is the return register)
        test    rsi, rsi      # n in rsi (second integer argument)
        jle     .Lend
.Lloop:
        add     rax, qword ptr [rdi]   # p in rdi (first argument)
        add     rdi, 8
        dec     rsi
        jne     .Lloop        # backward branch: this is the loop
.Lend:
        ret                   # leaf function: no prologue, no callee-saved registers used
```

Assembly shows what the compiler emitted for this exact configuration; it does not show what runs fast. Use the [performance guide](performance-and-codegen.md) before claiming speed.

## Localising a backend miscompile

When [miscompile triage](miscompile-triage.md) shows that all IR passes are innocent (the `-O2` IR run through `llc -O0` gives the right answer, while `llc -O2` does not), the fault is in code generation:

```sh
clang -O2 -S -emit-llvm t.c -o t.ll                  # optimised IR, already validated
llc -O0 t.ll -o t0.s && clang t0.s -o t0 && ./t0     # good?
llc -O2 t.ll -o t2.s && clang t2.s -o t2 && ./t2     # bad?
llc -O2 -opt-bisect-limit=N t.ll -o t2.s             # machine passes honour the limit too
```

Then compare `-print-after-all` output around the flipping machine pass, try `-regalloc=basic` versus greedy, and try `-global-isel` versus SelectionDAG. A difference that follows one component is a lead, not a conclusion. Reduce the IR with `llvm-reduce` using a test that assembles, runs and compares output. cea: `compile` records each `llc`-level configuration; `differential_run` compares their outputs.

## Checklist before you conclude

- [ ] Target triple, CPU, features, compiler version and flags are stated and backed by `compile` or `environment_report` evidence.
- [ ] ABI claims name the specific ABI document and were tested across a compiler boundary.
- [ ] Machine verifier (`-verify-machineinstrs`) was on; no verifier was disabled to make a test pass.
- [ ] Unwind info was checked by tooling and by unwinding through the frame, not assumed.
- [ ] JIT code handles W^X, icache flushing and unwind registration.
- [ ] Foreign-target results name the emulator and its limits; no performance claims from emulation.
- [ ] Observed, inferred and unknown are separated, each with evidence IDs.
