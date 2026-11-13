# The evidence ledger

Every tool call that does real work appends one Evidence record to the session ledger and returns it. This page describes the record, how sessions are stored on disk, how large outputs are kept as views, and the five ledger tools: `inspect_evidence_view`, `list_evidence`, `record_unknown`, `update_unknown` and `export_evidence_bundle`.

The background and the reasons for the design are in [design.md](design.md). The tools that create records are in [tools-environment.md](tools-environment.md), [tools-compile.md](tools-compile.md), [tools-correctness.md](tools-correctness.md), [tools-performance.md](tools-performance.md) and [triage.md](triage.md).

## The Evidence record

Every call of a recording tool, including calls that fail and calls where a provider is missing, produces a record with `"schema": "cea.evidence/1"`. A claim about a compiler should cite the `evidence_id` behind it.

| Field | Meaning |
|---|---|
| `schema` | Always `cea.evidence/1`. |
| `evidence_id` | `ev_<operation>_<8 hex digits>`. Cite this. |
| `session_id` | The session the record belongs to. |
| `created_at` | ISO 8601 timestamp when the record was finished. |
| `duration_ms` | Wall-clock time of the whole call. |
| `operation` | The tool name. |
| `status` | `ok` (the tool ran to completion), `inconclusive` (it ran but could not reach an answer), `unavailable` (a provider is missing or a remote provider is disabled), or `error`. |
| `summary` | One line. Never stronger than the evidence. |
| `inputs` | The input exactly as received (before defaults are applied). |
| `input_files` | Path, SHA-256 and size in bytes of every source file read. |
| `tools` | Name, resolved path and version line of every program used. |
| `commands` | Every process started: `purpose`, `argv`, `cwd`, `exit_code`, `signal`, `timed_out`, `output_truncated`, `duration_ms`, and the view names of captured output as `stdout_view` and `stderr_view`. |
| `target_triple` | The target when known, otherwise `null`. |
| `result` | The normalised, tool-specific result. Bounded in size. |
| `observed` | Facts read directly from tool output. |
| `inferred` | Conclusions drawn from observations. Each is weaker than an observation. |
| `unknowns` | What this evidence does not settle. |
| `limitations` | What the method cannot see. |
| `coverage` | What was and was not exercised: configurations, inputs, paths. |
| `views` | Named raw outputs kept on disk: `name`, `description`, `bytes`, `lines`, `sha256`. |
| `derived_from` | Evidence IDs this record builds on (used by `triage_miscompile`). |
| `error` | `code`, `message`, `remediation` and optional `details`, present when status is `error` or `unavailable`. |

Read the three lists in this order of strength: `observed` is what a tool printed, `inferred` is what follows from it, `unknowns` is what remains open. Keep them apart when you report.

### Status and error codes

The error `code` is one of `INVALID_INPUT`, `PROVIDER_UNAVAILABLE`, `UNSAFE_FLAG`, `NOT_FOUND`, `TIMEOUT`, `TOOL_FAILED`, `UNSUPPORTED`, `REMOTE_DISABLED` or `INTERNAL`. The status is `unavailable` for `PROVIDER_UNAVAILABLE` and `REMOTE_DISABLED`, and `error` for all other codes. Input validation failures are recorded too: a bad call leaves a record with status `error` and the list of problems. `INTERNAL` means a bug in cea; the remediation text asks you to report it with an evidence bundle.

Note that many tools report "the thing I looked for happened" or "the program under test failed" with status `ok`; see the status note in each tool page.

## Sessions and storage

A session is a named ledger. Records from all tools in one session can cite each other, and a bundle exports one session.

| Setting | Default | Meaning |
|---|---|---|
| `CEA_HOME` (or `--home`) | `.cea` in the current working directory | Where all sessions are stored. |
| `CEA_SESSION` (or `--session`) | `default` | The session name. 1 to 64 characters from letters, digits, dot, dash and underscore. |

The command-line options win over the environment variables. The MCP server uses the values it was started with.

Layout of one session:

```
<CEA_HOME>/sessions/<session>/
  evidence.jsonl                  one Evidence record per line, append-only
  unknowns.jsonl                  one revision of an unknown per line; the last revision wins
  views/<evidence_id>/<name>      raw outputs (IR, assembly, diffs, stdout, stderr)
  work/<evidence_id>/             scratch space of that call: compiled programs, copies of sources
  candidates/<evidence_id>/       fuzz_compiler candidates, one folder per seed
  bundle-<session>.cea.json       default output of export_evidence_bundle, plus a .md index
```

JSON Lines was chosen over a database to avoid a native dependency. The files are append-only. If a write was interrupted and left a torn last line, that line is skipped when reading.

Add `.cea/` to your `.gitignore`: the work directories hold compiled programs and copies of your sources.

## Views and paging

Large outputs never go into the result. A result holds a bounded preview and the name of a view; the full text is a file under `views/<evidence_id>/`. Names of command output views look like `01-compile_to_asm.stderr.txt`: a running number, the purpose of the command, and the stream. Other tools add named views such as `output.ll`, `frontend.ll`, `timeline.diff`, `remarks.tsv`, `interesting.mjs` and `report.md`.

Read a view with `inspect_evidence_view`, a line range at a time, optionally filtered by a substring.

## The five ledger tools

These five tools read or annotate existing records. They return a `cea.response/1` envelope and do not create Evidence records themselves. The envelope has these fields:

| Field | Meaning |
|---|---|
| `schema` | `cea.response/1`. |
| `operation` | The tool name. |
| `session_id` | The session the tool worked on. |
| `status` | `ok`, or `error` if the call failed (for example an unknown evidence ID). |
| `summary` | One line. |
| `result` | The tool-specific result. |
| `error` | `code`, `message` and `remediation`, present on failure. |

Because they create no record, calling them does not grow the ledger and they have no `observed`, `inferred`, `limitations` or `evidence_id` of their own. Do not cite a ledger tool call as evidence for a compiler claim; cite the records it read. The two unknown tools do write: they append to `unknowns.jsonl`.

### inspect_evidence_view

Reads a stored Evidence record, or pages through one of its views. With no `view`, it returns the full record and the list of views; use that to learn which views exist.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `evidence_id` | string | required | An ID such as `ev_` followed by the operation and eight hex digits. Must exist in the session. |
| `view` | string | none | View name from the record's `views`. Omit to get the record and the list of views. |
| `offset` | integer | `0` | First line (0-based) of the page. |
| `limit` | integer | `200` | Number of lines, 1 to 2000. |
| `contains` | string | none | Keep only lines containing this substring, applied before paging. Matching lines are prefixed with their original 0-based line number. |

Result without `view`: `evidence` (the whole record) and `views`. Result with `view`: `evidence_id`, `view`, `total_lines`, `matching_lines`, `offset`, `next_offset` (or `null` when the page reaches the end) and `text`.

```json
{
  "evidence_id": "ev_compile_1a2b3c4d",
  "view": "output.s",
  "offset": 0,
  "limit": 100,
  "contains": "vpmulld"
}
```

```sh
cea inspect_evidence_view --input input.json
```

Limitations: the tool shows what is stored and nothing else; it cannot show output that the producing tool did not keep. What it does not tell you: whether the content is correct. It is the raw output of the tool that wrote it.

### list_evidence

Lists the session's records: `evidence_id`, `operation`, `status`, `created_at`, `summary` and `derived_from`, newest last. Use it to find IDs to cite.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `operation` | string | none | Only records of this tool. |
| `limit` | integer | `50` | How many of the newest records to return, 1 to 500. |

Result: `total` (the number of matching records) and `evidence` (the last `limit` of them).

```json
{ "operation": "check_ub", "limit": 10 }
```

```sh
cea list_evidence --input input.json
```

Limitations: it lists the one session selected by `CEA_SESSION` or `--session`; records in other sessions are not shown. What it does not tell you: whether a listed record supports your claim; open the record and read `observed`, `inferred` and `unknowns`.

### record_unknown

Records an open question that the evidence so far does not settle, with the evidence that supports and contradicts each reading. Writing unknowns down keeps a plausible guess from being reported as a finding. Every evidence ID you cite must exist in the session, otherwise the call fails with `NOT_FOUND`.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `question` | string | required | The question, 5 to 2000 characters. |
| `why_it_matters` | string | `""` | Why the answer changes what you would do. |
| `supporting_evidence` | string[] | `[]` | Evidence IDs that support one reading. |
| `contradicting_evidence` | string[] | `[]` | Evidence IDs that contradict it. |
| `note` | string | none | A first note. |

Result: `unknown`, the stored record, and `open_unknowns`, the number of open unknowns in the session. An unknown record has `unknown_id` (`unk_` followed by eight hex digits), `session_id`, `created_at`, `updated_at`, `question`, `why_it_matters`, `status` (starts as "open"), `supporting_evidence`, `contradicting_evidence`, `notes` and `resolution`.

```json
{
  "question": "Does the reduced program have strict-aliasing UB that UBSan cannot see?",
  "why_it_matters": "If yes, the pass is behaving correctly and no compiler bug report should be filed.",
  "supporting_evidence": ["ev_check_ub_0a1b2c3d"]
}
```

```sh
cea record_unknown --input input.json
```

Limitations: it stores your text and the links; it does not check that the question is well posed. What it does not tell you: anything about the compiler. It is bookkeeping for what is not yet known.

### update_unknown

Adds evidence or a note to an unknown, or closes it. Every revision is appended to `unknowns.jsonl`; the latest revision is the current state.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `unknown_id` | string | required | An ID returned by `record_unknown` in this session. |
| `add_supporting_evidence` | string[] | `[]` | Evidence IDs to add to the supporting list. |
| `add_contradicting_evidence` | string[] | `[]` | Evidence IDs to add to the contradicting list. |
| `note` | string | none | A note to append. |
| `status` | "open", "resolved" or "wont_resolve" | unchanged | The new status. |
| `resolution` | string | unchanged | What settled the question. |

Resolving requires a `resolution` text and at least one evidence ID on the record (supporting or contradicting); otherwise the call fails with `INVALID_INPUT`. If the question cannot be answered, close it as "wont_resolve" instead. Result: `unknown`.

```json
{
  "unknown_id": "unk_1a2b3c4d",
  "add_contradicting_evidence": ["ev_validate_transform_5e6f7a8b"],
  "status": "resolved",
  "resolution": "Alive2 verified the pass; the program relies on signed overflow."
}
```

```sh
cea update_unknown --input input.json
```

Limitations: the tool does not judge whether the evidence you attach really settles the question; it only requires that some exists. What it does not tell you: whether the resolution is right.

### export_evidence_bundle

Writes the whole session to one portable JSON file, plus a Markdown index, for attaching to a bug report or handing to a reviewer. The bundle has the schema `cea.bundle/1` and contains `exported_at`, `session_id`, every Evidence record, every unknown, and the views.

| Name | Type | Default | Meaning |
|---|---|---|---|
| `output_path` | string | session directory | Where to write the bundle. Default: `bundle-<session>.cea.json` in the session directory. The Markdown index is written next to it with the same name and a `.md` extension. |
| `include_views` | boolean | `true` | Embed raw views as text. |
| `max_view_bytes` | integer | `2000000` | Views larger than this are listed but not embedded. 0 to 50,000,000. |

Result: `bundle_path`, `index_path`, `bytes`, `evidence_count`, `unknown_count`, `views_embedded`, `views_skipped`.

```json
{ "output_path": "cea-bundle.cea.json", "max_view_bytes": 500000 }
```

```sh
cea export_evidence_bundle --input input.json
```

Limitations: the bundle includes your source code and compiler output, because views hold them. Read it before you attach it to a public issue, and drop `include_views` if you do not want the raw text in it. Compiled binaries and the `work` directories are not included. What it does not tell you: that the session is complete. It contains only what was recorded in this session.
