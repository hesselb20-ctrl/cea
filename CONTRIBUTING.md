# Contributing to cea

Thank you for helping. cea ("Compiler Engineering Agent") is an MCP server and CLI that wraps real compiler tools and stores every result as a citable Evidence record. This file explains how to set up, how to add a tool, and the rules a change has to follow. The design is in [docs/design.md](docs/design.md); the tool reference starts at [docs/tools-environment.md](docs/tools-environment.md).

## Setup

You need Node 20 or newer. Compilers and the other providers are optional for development: unit tests use fakes, and integration tests skip what is not installed.

```sh
npm install
npm run build
```

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript from `src/` to `dist/`. |
| `npm run typecheck` | Type-check `src/` and `test/` without writing files. |
| `npm run lint` | Run ESLint over the repository. |
| `npm test` | Run every test (unit, docs and integration). |
| `npm run test:unit` | Run the unit tests and the docs test. They use fake providers and need no compiler or network. |
| `npm run test:integration` | Run the integration tests against the real compilers on this machine. A test whose provider is missing is skipped, not failed, and the last test prints which providers were absent. |

Run `cea doctor` (after a build: `node dist/cli.js doctor`) to see which providers your machine has. An integration run that is green because everything was skipped is not coverage; look at the skipped list.

Please run `npm run typecheck`, `npm run lint` and `npm run test:unit` before you open a pull request, and `npm run test:integration` when you touch something that runs a real tool.

## Layout

| Path | What is there |
|---|---|
| `src/registry.ts` | The single list of tools. The MCP server and the CLI are both generated from it. |
| `src/tools/` | One file per tool (the five ledger tools share `ledger_tools.ts`). |
| `src/core/` | The shared machinery: `context.ts` (the Evidence builder and tool runner), `exec.ts` (process spawning), `toolbox.ts` (provider discovery), `ledger.ts` (storage), `build.ts` (compiling and running test programs), `interesting.ts` (the reduction test). |
| `src/providers/` | Remote providers (currently only Compiler Explorer, off by default). |
| `test/unit/`, `test/integration/` | Tests. `test/helpers.ts` has the fake provider context. |
| `docs/`, `examples/`, `skills/` | Documentation, worked examples and the agent skill. |

## How to add a tool

1. **Define it** in a new file in `src/tools/` with `defineTool`. A tool has a `name` (lower snake case, the same as the file name), a `family` (`environment`, `compile`, `correctness`, `performance`, `ledger` or `composite`), a `title`, a `description` that says what it does and when to use it, an `input` schema built with `z.strictObject`, and either:
   - `run(input, ev, ctx)` for a tool that does work. Everything it does is recorded in the Evidence record through the builder `ev`: `ev.run` for processes, `ev.tool` and `ev.compiler` to resolve providers, `ev.file` for input files, `ev.view` for large outputs, and `ev.observe`, `ev.infer`, `ev.unknown`, `ev.limit` and `ev.cover` for the claims. It returns a `status`, a one-line `summary` and a `result`.
   - `query(input, ctx)` for a ledger tool that only reads or annotates existing records. It returns a `cea.response/1` envelope and creates no Evidence record.
2. **Register it** in `src/registry.ts`: import it and add it to the `TOOLS` list. The CLI and the MCP server pick it up from there; nothing else needs changing.
3. **Unit test it with a mocked exec.** Use `fake()` from `test/helpers.ts` to build a context whose providers are fake programs, and assert on the Evidence record: the argv it ran, the result fields, and the observed, inferred, unknown and limitation text. A unit test must never start a real compiler or touch the network.
4. **Integration test it** in `test/integration/`. Check for the providers first and skip the test when one is absent; never fail because a machine lacks a compiler.
5. **Document it.** Add a section to the page for its family in `docs/` (environment, compile, correctness, performance, ledger or triage) with: what it does and when to use it, a table of inputs taken from the real schema, the key result fields, an example input and the `cea <tool> --input input.json` command, the limitations it records, and a line on what it does not tell you. The docs test fails if a tool is not documented, if a backticked snake_case word is not a real tool, input property or result field, or if a relative link points to a file that does not exist.
6. If the tool needs a new program, add it to `PROVIDERS` in `src/core/toolbox.ts` (with the version command and an install hint) and to the provider table in [docs/tools-environment.md](docs/tools-environment.md).

A minimal skeleton:

```ts
import { z } from 'zod';
import { materialize, SourceSchema } from '../core/build.js';
import { defineTool } from '../core/context.js';

export const lineCount = defineTool({
  name: 'line_count',
  family: 'compile',
  title: 'Count lines',
  description: 'Count the lines of a source file. Use it to show how a reduction shrank a test case.',
  input: z.strictObject({ source: SourceSchema }),
  async run(input, ev) {
    const src = materialize(ev, input.source);
    const lines = src.text.split('\n').length;
    ev.observe(`${lines} lines`);
    ev.limit('Counts physical lines, including blank lines and comments.');
    return { status: 'ok', summary: `${lines} lines`, result: { lines } };
  },
});
```

This is only an illustration of the shape; it is not a tool in the repository.

## Project rules

These come from the design. A change that breaks one of them will be sent back.

- **Semantics before speed.** A fast wrong program is a bug. Tools that measure speed also check output.
- **Evidence before claims.** "Compiler bug", "this pass is correct" and "this is faster" are conclusions, and each needs evidence behind it. A summary is never stronger than the evidence. Keep `observed`, `inferred` and `unknowns` apart: an observation is something a tool printed, an inference follows from it and is weaker.
- **Small before large.** Reduce first, then reason.
- **Never spawn through a shell.** Processes are started with an argv array and `shell: false`, through `ev.run` or `exec`. Do not build a command line from strings. Do not run `.cmd` or `.bat` files. Test harnesses that must run on every platform are written as Node scripts, not shell scripts.
- **Every tool has a timeout.** Every process has a timeout and an output cap, and on timeout the whole process tree is killed. Expose the budget as an input such as `timeout_s` with a sensible default and a maximum.
- **Results are bounded.** Never put large output in `result`. Put the full text in a view with `ev.view` and return a bounded preview and the view name. Agents read views page by page with `inspect_evidence_view`.
- **Say what the tool cannot see.** Record what the method cannot see with `ev.limit`, and what the evidence does not settle with `ev.unknown`. A clean sanitizer run, a missing remark or a verified transformation each leaves something unproven; say what.
- **Fail as evidence.** A missing provider or a bad input is a fact. Throw a `CeaError` with a code and a remediation hint, and the runner records it.
- **No network by default.** The only network feature is the opt-in remote provider. Do not add another without discussion, and never send source code anywhere unless the user enabled it.
- **Windows, macOS and Linux.** Use `path.join` and `os` APIs, not hard-coded separators, and keep platform differences in the toolbox.
- **Dependencies.** The runtime dependencies are the MCP SDK and zod only. Do not add one without a good reason.

## Pull requests

- Keep a pull request to one logical change, with tests and documentation in the same change.
- Say how you checked it: which commands, which compilers and versions.
- If you change a tool's result fields, update its docs page and the examples that show it.

## Commit style

- One logical change per commit.
- A short subject in the imperative mood, at most about 72 characters, with no trailing period. Start with the area when it helps: `check_ub: report the column of ASan findings`, `docs: explain the semantic probe`.
- A body, when the change is not obvious, that says why, not just what.
- Do not mix formatting changes with behaviour changes.

## Reporting problems

For a bug, open an issue with the bug report template. It asks for the output of `cea doctor`, the exact command or tool input, and the evidence bundle written by `export_evidence_bundle`. Read the bundle first: it contains your source code and compiler output. For a security problem, do not open an issue; follow [SECURITY.md](SECURITY.md).
