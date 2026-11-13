import type { ErrorCode, ErrorObject } from './types.js';

/** An error with a machine-readable code and a hint the agent can act on. */
export class CeaError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly remediation: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CeaError';
  }

  toObject(): ErrorObject {
    const o: ErrorObject = { code: this.code, message: this.message, remediation: this.remediation };
    if (this.details !== undefined) o.details = this.details;
    return o;
  }
}

export function toErrorObject(e: unknown): ErrorObject {
  if (e instanceof CeaError) return e.toObject();
  const message = e instanceof Error ? e.message : String(e);
  return {
    code: 'INTERNAL',
    message,
    remediation: 'This is a bug in cea. Re-run with the same input and report it with the evidence bundle.',
  };
}
