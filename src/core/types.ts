/** Shared types. The Evidence record is the unit every tool returns and every claim must cite. */

export type Status = 'ok' | 'inconclusive' | 'unavailable' | 'error';

export interface FileRef {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ToolVersion {
  name: string;
  path: string;
  version: string;
}

export interface CommandRecord {
  purpose: string;
  argv: string[];
  cwd: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  output_truncated: boolean;
  duration_ms: number;
  stdout_view?: string;
  stderr_view?: string;
}

export interface ViewRef {
  name: string;
  description: string;
  bytes: number;
  lines: number;
  sha256: string;
}

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'UNSAFE_FLAG'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'TOOL_FAILED'
  | 'UNSUPPORTED'
  | 'REMOTE_DISABLED'
  | 'INTERNAL';

export interface ErrorObject {
  code: ErrorCode;
  message: string;
  remediation: string;
  details?: unknown;
}

export interface Evidence {
  schema: 'cea.evidence/1';
  evidence_id: string;
  session_id: string;
  created_at: string;
  duration_ms: number;
  operation: string;
  status: Status;
  summary: string;
  inputs: unknown;
  input_files: FileRef[];
  tools: ToolVersion[];
  commands: CommandRecord[];
  target_triple: string | null;
  result: Record<string, unknown>;
  observed: string[];
  inferred: string[];
  unknowns: string[];
  limitations: string[];
  coverage: Record<string, unknown>;
  views: ViewRef[];
  derived_from: string[];
  error?: ErrorObject;
}

export interface UnknownRecord {
  unknown_id: string;
  session_id: string;
  created_at: string;
  updated_at: string;
  question: string;
  why_it_matters: string;
  status: 'open' | 'resolved' | 'wont_resolve';
  supporting_evidence: string[];
  contradicting_evidence: string[];
  notes: string[];
  resolution: string | null;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  stdin?: string;
  env?: Record<string, string | undefined>;
}

export interface ExecResult {
  argv: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  /** Set when the process could not be started at all. */
  spawnError?: string;
}

export type ExecFn = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;
