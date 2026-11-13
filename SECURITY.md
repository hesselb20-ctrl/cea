# Security

cea is a tool that runs compilers and runs the programs they produce. Read this page before you point it at code you do not trust.

## What cea does, and what that means

cea runs real compilers and other programs (see the provider table in [docs/tools-environment.md](docs/tools-environment.md)) on the source you give it, and many tools then execute the programs they compiled. That is the job. It follows that:

- **Compiling is not harmless.** A compiler reads every file the source includes, and it can be crashed or exploited by hostile input.
- **Running a test program runs its code.** `check_ub`, `differential_run`, `bisect_passes`, `reduce_testcase`, `benchmark`, `fuzz_compiler` and `triage_miscompile` all build a program and run it. If the source is malicious, so is the program.
- **cea is not a sandbox.** It limits accidents. It does not stop a determined program.

The rest of this page says exactly what is limited, what is not, and what you should do about it.

## What is limited

### Test programs

A compiled test program is started with:

- an argument array and no shell;
- a scrubbed environment: only `PATH` (with the compiler's directories in front), `LANG` and `LC_ALL` set to `C`, the Windows variable `SystemRoot`, the temporary-directory variables `TEMP`, `TMP` and `TMPDIR` when they exist, and the sanitizer option variables the tool sets. Your other environment variables, such as tokens and keys, are not passed on;
- a working directory inside the per-evidence work directory (`work/<evidence_id>/` in the session);
- a timeout (the `run.timeout_s` input, 10 seconds by default), after which the whole process tree is killed;
- an output cap of 4 MiB per stream.

This is not a sandbox. The program runs as you. It can read and write any file you can, use the network, start other processes, and use the CPU and memory until its timeout. The working directory is a starting point, not a boundary.

### What is not scrubbed

- **Compilers and other providers run with your full environment.** cea does not clear it for them.
- **The compilers invoked by the generated interestingness test** (`interesting.mjs`, used by `reduce_testcase`) inherit your full environment. The candidate programs it runs get a scrubbed one: `PATH` plus the compiler runtime directories, `LANG=C`, `SystemRoot`, `TEMP`, `TMP`, `TMPDIR` when set, and the sanitizer options. The reducers it drives (cvise, creduce, llvm-reduce) run in your environment, and for cvise and creduce cea also writes a small `interesting.sh` wrapper that they execute.
- **`bisect_compiler_history`** runs the commands you pass, in the checkout, with your environment.

### No shell

cea never builds a shell command line. Every process is started from an argument array with `shell: false`, so no value in a tool input can be interpreted as shell syntax. On Windows it refuses to run `.cmd` and `.bat` files because they need a shell. Revision names passed to git must match a conservative pattern and may not start with a dash. Session names, evidence IDs and view names are restricted to letters, digits, dot, dash and underscore so that they cannot point outside the session directory.

### Flags that load code

A compiler flag can make the compiler load and run other code. These flags are rejected with the error `UNSAFE_FLAG` unless `CEA_ALLOW_UNSAFE_FLAGS=1` is set:

- `-fplugin...`, `-fpass-plugin...`, `-load`, `-load-pass-plugin`, `-load=...`
- `-wrapper`, `-B...`, `-specs...`, `--specs...`
- response files (an argument starting with `@`)
- `-fuse-ld=` with a path, `-Xlinker`, `-fprofile-use-sample...`, `-sysroot-exec...`

cea also rejects `-o` flags, because it chooses output paths itself. The list is a denylist of known cases. It protects against accidents and against a tool call that was influenced by text in a file the agent read; it is not a guarantee that no flag can run code. Do not set `CEA_ALLOW_UNSAFE_FLAGS` unless you trust the plugin or wrapper and the caller.

### Network

cea makes no network requests by default. It has no telemetry and downloads nothing.

The only network feature is the **opt-in remote provider** `compiler-explorer`, used by `validate_transform`. It is enabled only when the environment variable `CEA_REMOTE_PROVIDERS` contains `compiler-explorer`. Then, if the local `alive-tv` is not available (or you pass `provider: "remote"`), `validate_transform` sends the IR being checked to the Alive2 project's Compiler Explorer instance at `https://alive2.llvm.org/ce` over HTTPS. The variable `CEA_ALIVE2_CE_URL` can point it at a different instance. What is sent:

- With `before` and `after`: one combined module containing the target data layout and triple, type definitions, the two compared functions (renamed `@src` and `@tgt`), and the globals, declarations, metadata and attribute groups they reference. Other functions and unreferenced debug information are not sent.
- With `pair`: the whole module you supply, after the module id, source file name and debug-info file names are replaced.
- The extra options in `extra_args` and the SMT timeout.

IR can contain names, string constants and logic from your source. The exact text sent is stored in the Evidence record as the view `alive-input.ll` so you can see it afterwards. The remote service's own handling and retention of the data is outside cea's control. Leave the remote provider off for code you must not disclose. This is the only code path in cea that sends anything off the machine.

Programs that cea compiles and runs are not network-restricted. A test program can open sockets.

### Commands you pass

`bisect_compiler_history` executes the `build` and `test` argument arrays you give it, once per bisection step, in a git checkout that it moves between commits. It does not inspect them. They are your declared inputs and can do anything your user can do. Only give it commands and a repository you trust.

### Stored data

The session directory (`.cea` by default) holds copies of your sources, compiled programs, compiler output and the Evidence records. `export_evidence_bundle` writes the records and views into one file. Treat both like source code: keep `.cea` out of version control, and read a bundle before you attach it to a public issue.

### Tools called by an agent

When cea runs as an MCP server, any client that can talk to it can start compilers and programs on paths your user can read, run the commands in `bisect_compiler_history`, and write a file anywhere your user can with `export_evidence_bundle`. Keep your agent host's approval prompts on for these tools. Text in files an agent reads may try to steer it into unsafe calls; the approval prompt is the defence.

## What to do about it

- **Run untrusted test cases in a virtual machine or a container**, not on your main machine. Use a throwaway one, with no credentials in its environment, no mounted home directory, and, if the test does not need it, no network (for example `--network none` in a container).
- Do not run cea as an administrator or root user.
- Keep `CEA_ALLOW_UNSAFE_FLAGS` unset and `CEA_REMOTE_PROVIDERS` empty unless you need them, and know what each sends or runs.
- Put the compilers you trust in `CEA_TOOLCHAIN_DIRS` or point `CEA_TOOL_<NAME>` at them, so cea does not pick up a binary you did not intend. `cea doctor` shows the path and version that was found for each.
- Use a separate `CEA_HOME` per project, and delete it when you are done with sensitive code.

## Reporting a vulnerability

Please report a vulnerability privately. Open a GitHub security advisory on the repository: go to https://github.com/hesselb20-ctrl/cea/security/advisories/new, or the Security tab of the repository and choose "Report a vulnerability". Please do not open a public issue for a security problem.

Include the version (`cea version`), the output of `cea doctor`, the tool input or command, what you expected and what happened, and the impact you see.

Reports we are especially interested in: a way to make a tool run a command through a shell, a way around the unsafe-flag check that was not intended, a path traversal out of the session directory, data sent off the machine when the remote provider is disabled, or sensitive environment variables reaching a test program that is meant to get a scrubbed environment. A test program that harms your machine because you ran it is how the tool is documented to work, not a vulnerability; the fix for that is the isolation described above.
