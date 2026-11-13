# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

## [0.1.0] - 2026-11-13

First release.

### Added

- Evidence ledger: every tool call is stored as an Evidence record with exact command lines, tool versions, target triple, input hashes, observed / inferred / unknown, limitations and coverage. Raw output is kept on disk as views and paged with `inspect_evidence_view`.
- Provider detection for clang, opt, llc, llvm-reduce, llvm-mca, llvm-mc, llvm-objdump, FileCheck, GCC, rustc, cargo, Miri, alive-tv, cvise, creduce, Csmith, YARPGen, perf and git, with a reason and a fix for each one that is missing. A `gcc` that is really clang is rejected.
- Tools: `environment_report`, `compile`, `emit_ir`, `pass_timeline`, `opt_remarks`, `check_ub`, `differential_run`, `bisect_passes`, `reduce_testcase`, `validate_transform`, `analyze_throughput`, `benchmark`, `fuzz_compiler`, `bisect_compiler_history`, `inspect_evidence_view`, `list_evidence`, `record_unknown`, `update_unknown`, `export_evidence_bundle`.
- `triage_miscompile`: the whole chain in one call, with early stops and a draft report in Markdown.
- MCP server over stdio (`cea mcp`) and a CLI in which every tool is available as `cea <tool> --json` or `--input`, plus `cea doctor`, `cea triage` and `cea install-skill`.
- Agent skill `compiler-engineering` with seven reference guides.
- Optional remote provider for `validate_transform` (the Alive2 project's Compiler Explorer instance), off unless `CEA_REMOTE_PROVIDERS=compiler-explorer` is set.
- Five reproducible examples with recorded output, and a recorded terminal demo.
- Unit tests with mocked providers, integration tests against real compilers, and a documentation consistency test.

### Known gaps

- Rust (rustc `emit_ir`, Miri), YARPGen, MSan and a local alive-tv binary have not been exercised against the real tools.
- `benchmark` does not read hardware counters.
- The Compiler Explorer remote provider covers `validate_transform` only.
