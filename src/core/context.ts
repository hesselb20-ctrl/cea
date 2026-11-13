import path from 'node:path';
import { z } from 'zod';
import { CeaError, toErrorObject } from './errors.js';
import { realExec } from './exec.js';
import { Ledger } from './ledger.js';
import { Toolbox, type CompilerInfo } from './toolbox.js';
import type { CommandRecord, ErrorObject, Evidence, ExecFn, ExecOptions, ExecResult, FileRef, Status, ToolVersion, ViewRef } from './types.js';
import { fileRef, safeName } from './util.js';

export interface Config {
  home: string;
  session: string;
  remoteProviders: Set<string>;
  allowUnsafeFlags: boolean;
}

export interface Ctx {
  config: Config;
  ledger: Ledger;
  exec: ExecFn;
  toolbox: Toolbox;
  /** Network access for remote providers; replaceable in tests. */
  fetch: typeof fetch;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  return {
    home: overrides.home ?? env['CEA_HOME'] ?? path.join(process.cwd(), '.cea'),
    session: overrides.session ?? env['CEA_SESSION'] ?? 'default',
    remoteProviders: overrides.remoteProviders ?? new Set((env['CEA_REMOTE_PROVIDERS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    allowUnsafeFlags: overrides.allowUnsafeFlags ?? env['CEA_ALLOW_UNSAFE_FLAGS'] === '1',
  };
}

export function createContext(overrides: Partial<Config> = {}, parts: Partial<Pick<Ctx, 'exec' | 'toolbox' | 'fetch'>> = {}): Ctx {
  const config = configFromEnv(process.env, overrides);
  const exec = parts.exec ?? realExec;
  return {
    config,
    ledger: new Ledger(config.home, config.session),
    exec,
    toolbox: parts.toolbox ?? new Toolbox({ exec }),
    fetch: parts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
  };
}

export interface RunOptions extends ExecOptions {
  /** Which streams to keep as views. Default: both, when non-empty. */
  keep?: 'both' | 'stdout' | 'stderr' | 'none';
}

export interface ToolOutcome {
  status: Status;
  summary: string;
  result: Record<string, unknown>;
}

/**
 * Collects everything one tool call did, so the Evidence record is complete by construction:
 * a tool cannot run a command or read a file without it being recorded.
 */
export class EvidenceBuilder {
  readonly id: string;
  readonly workDir: string;
  private readonly started = Date.now();
  private readonly inputFiles: FileRef[] = [];
  private readonly tools: ToolVersion[] = [];
  private readonly commands: CommandRecord[] = [];
  private readonly views: ViewRef[] = [];
  private readonly observedList: string[] = [];
  private readonly inferredList: string[] = [];
  private readonly unknownList: string[] = [];
  private readonly limitationList: string[] = [];
  private readonly coverage: Record<string, unknown> = {};
  private readonly derived: string[] = [];
  private target: string | null = null;

  constructor(readonly ctx: Ctx, readonly operation: string, readonly inputs: unknown) {
    this.id = ctx.ledger.newEvidenceId(operation);
    this.workDir = ctx.ledger.workDir(this.id);
  }

  private noteTool(t: ToolVersion): void {
    if (!this.tools.some((x) => x.path === t.path)) this.tools.push({ name: t.name, path: t.path, version: t.version });
  }

  /** Resolve a provider binary (throws PROVIDER_UNAVAILABLE) and record its version. */
  async tool(id: string): Promise<ToolVersion> {
    const t = await this.ctx.toolbox.require(id);
    this.noteTool(t);
    return t;
  }

  /** Resolve a compiler by name or path and record its version and target. */
  async compiler(nameOrPath: string): Promise<CompilerInfo> {
    const c = await this.ctx.toolbox.compiler(nameOrPath);
    this.noteTool(c);
    if (this.target === null && c.target) this.target = c.target;
    return c;
  }

  /** Run a process, record the exact command, and keep its output as views. */
  async run(purpose: string, cmd: string, args: string[], opts: RunOptions = {}): Promise<ExecResult> {
    const { keep = 'both', ...execOpts } = opts;
    const r = await this.ctx.exec(cmd, args, { cwd: this.workDir, ...execOpts });
    const n = String(this.commands.length + 1).padStart(2, '0');
    const rec: CommandRecord = {
      purpose,
      argv: r.argv,
      cwd: r.cwd,
      exit_code: r.exitCode,
      signal: r.signal,
      timed_out: r.timedOut,
      output_truncated: r.truncated,
      duration_ms: r.durationMs,
    };
    if ((keep === 'both' || keep === 'stdout') && r.stdout.length > 0) {
      rec.stdout_view = this.view(`${n}-${safeName(purpose)}.stdout.txt`, r.stdout, `stdout of: ${purpose}`).name;
    }
    if ((keep === 'both' || keep === 'stderr') && r.stderr.length > 0) {
      rec.stderr_view = this.view(`${n}-${safeName(purpose)}.stderr.txt`, r.stderr, `stderr of: ${purpose}`).name;
    }
    this.commands.push(rec);
    if (r.spawnError) {
      throw new CeaError('TOOL_FAILED', `could not start ${cmd}: ${r.spawnError}`, 'Check that the binary exists and is executable; run environment_report.');
    }
    return r;
  }

  file(p: string): FileRef {
    const ref = fileRef(p);
    if (!this.inputFiles.some((f) => f.path === ref.path && f.sha256 === ref.sha256)) this.inputFiles.push(ref);
    return ref;
  }

  view(name: string, content: string, description: string): ViewRef {
    const ref = this.ctx.ledger.writeView(this.id, name, content, description);
    const i = this.views.findIndex((v) => v.name === ref.name);
    if (i >= 0) this.views[i] = ref;
    else this.views.push(ref);
    return ref;
  }

  observe(s: string): void { this.observedList.push(s); }
  infer(s: string): void { this.inferredList.push(s); }
  unknown(s: string): void { this.unknownList.push(s); }
  limit(s: string): void { if (!this.limitationList.includes(s)) this.limitationList.push(s); }
  cover(key: string, value: unknown): void { this.coverage[key] = value; }
  derive(evidenceId: string): void { if (!this.derived.includes(evidenceId)) this.derived.push(evidenceId); }
  setTarget(t: string | null): void { if (t) this.target = t; }

  finish(outcome: ToolOutcome, error?: unknown): Evidence {
    const e: Evidence = {
      schema: 'cea.evidence/1',
      evidence_id: this.id,
      session_id: this.ctx.ledger.sessionId,
      created_at: new Date().toISOString(),
      duration_ms: Date.now() - this.started,
      operation: this.operation,
      status: outcome.status,
      summary: outcome.summary,
      inputs: this.inputs,
      input_files: this.inputFiles,
      tools: this.tools,
      commands: this.commands,
      target_triple: this.target,
      result: outcome.result,
      observed: this.observedList,
      inferred: this.inferredList,
      unknowns: this.unknownList,
      limitations: this.limitationList,
      coverage: this.coverage,
      views: this.views,
      derived_from: this.derived,
    };
    if (error !== undefined) e.error = toErrorObject(error);
    this.ctx.ledger.append(e);
    return e;
  }
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  family: 'environment' | 'compile' | 'correctness' | 'performance' | 'ledger' | 'composite';
  title: string;
  description: string;
  input: S;
  /** Recording tools: everything they do lands in a new Evidence record. */
  run?(input: z.output<S>, ev: EvidenceBuilder, ctx: Ctx): Promise<ToolOutcome>;
  /** Ledger tools read or annotate existing records and do not create evidence themselves. */
  query?(input: z.output<S>, ctx: Ctx): Promise<ToolOutcome>;
}

/** What a ledger tool returns: same envelope as Evidence, without provenance fields. */
export interface PlainResponse {
  schema: 'cea.response/1';
  operation: string;
  session_id: string;
  status: Status;
  summary: string;
  result: Record<string, unknown>;
  error?: ErrorObject;
}

export type ToolResponse = Evidence | PlainResponse;

function invalidInput(name: string, error: z.ZodError): CeaError {
  const issues = error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return new CeaError('INVALID_INPUT', `invalid input for ${name}: ${issues.join('; ')}`, `Fix the listed fields. Run "cea schema ${name}" for the JSON schema.`, { issues });
}

/** Run a ledger tool (no Evidence record is created). */
export async function queryTool<S extends z.ZodType>(ctx: Ctx, def: ToolDef<S>, rawInput: unknown): Promise<PlainResponse> {
  const base = { schema: 'cea.response/1' as const, operation: def.name, session_id: ctx.ledger.sessionId };
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const err = invalidInput(def.name, parsed.error);
    return { ...base, status: 'error', summary: err.message, result: {}, error: err.toObject() };
  }
  try {
    const o = await def.query!(parsed.data, ctx);
    return { ...base, ...o };
  } catch (e) {
    const obj = toErrorObject(e);
    return { ...base, status: 'error', summary: `${def.name} failed: ${obj.message}`, result: {}, error: obj };
  }
}

export function callTool<S extends z.ZodType>(ctx: Ctx, def: ToolDef<S>, rawInput: unknown): Promise<ToolResponse> {
  return def.query ? queryTool(ctx, def, rawInput) : invokeTool(ctx, def, rawInput);
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/**
 * Validate input, run the tool, and persist an Evidence record whatever happens. A failure is
 * evidence too: "alive-tv is not installed" is a fact the agent must not paper over.
 */
export async function invokeTool<S extends z.ZodType>(ctx: Ctx, def: ToolDef<S>, rawInput: unknown): Promise<Evidence> {
  const ev = new EvidenceBuilder(ctx, def.name, rawInput);
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const err = invalidInput(def.name, parsed.error);
    return ev.finish({ status: 'error', summary: err.message, result: {} }, err);
  }
  try {
    const outcome = await def.run!(parsed.data, ev, ctx);
    return ev.finish(outcome);
  } catch (e) {
    const obj = toErrorObject(e);
    const status: Status = obj.code === 'PROVIDER_UNAVAILABLE' || obj.code === 'REMOTE_DISABLED' ? 'unavailable' : 'error';
    return ev.finish({ status, summary: `${def.name} did not run: ${obj.message}`, result: {} }, e);
  }
}
