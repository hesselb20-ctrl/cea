---
name: Bug report
about: Something in cea does not work as documented, or gives a wrong or misleading result
title: ''
labels: bug
assignees: ''
---

<!--
Do not report security problems here. Follow SECURITY.md and open a private
GitHub security advisory instead.

If you think you found a bug in a compiler (clang, gcc, LLVM, rustc), this is
the wrong place unless cea itself gave you a wrong result. Report compiler bugs
upstream. A triage report from `cea triage` is a good starting point for that.
-->

## What happened

A short description of what you did, what you expected, and what you got.

## Environment: output of `cea doctor`

Paste the full output. It shows the cea version, the OS, and which compilers and tools were found.

```text
(paste the output of: cea doctor)
```

## The exact command or tool input

The command line you ran, or the MCP tool call, with the full JSON input. If you used `--input file.json`, paste the file.

```sh
cea <tool> --input input.json
```

```json
{
}
```

If the input names a source file, attach it, or the smallest version that still shows the problem. Remove anything you cannot share.

## Evidence bundle

Run the `export_evidence_bundle` tool in the session where the problem happened and attach the file it writes (`bundle-<session>.cea.json`, by default in the session directory under `.cea/sessions/`):

```sh
cea export_evidence_bundle --input bundle.json
```

The bundle contains your source code and the compiler output, because those are stored with the evidence. Read it first and remove what you cannot share. If you cannot attach it, paste the `evidence_id` of the failing record and the record's `summary`, `status` and `error` fields.

## Expected behaviour

What you expected to happen.

## Anything else

Other tools or versions you tried, whether it is reproducible, and whether it worked in an earlier version.
