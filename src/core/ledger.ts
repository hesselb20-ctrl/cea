import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CeaError } from './errors.js';
import type { Evidence, UnknownRecord, ViewRef } from './types.js';
import { countLines, safeName, sha256 } from './util.js';

/**
 * Append-only evidence store for one session.
 *
 *   <home>/sessions/<session>/evidence.jsonl      one Evidence record per line
 *   <home>/sessions/<session>/unknowns.jsonl      one UnknownRecord revision per line (last wins)
 *   <home>/sessions/<session>/views/<id>/<name>   raw outputs, read page by page
 *   <home>/sessions/<session>/work/<id>/          scratch space for that tool call
 */
export class Ledger {
  readonly dir: string;

  constructor(readonly home: string, readonly sessionId: string) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(sessionId)) {
      throw new CeaError('INVALID_INPUT', `invalid session name: ${sessionId}`, 'Use letters, digits, dot, dash or underscore (max 64 characters).');
    }
    this.dir = path.join(path.resolve(home), 'sessions', sessionId);
  }

  private ensure(sub?: string): string {
    const d = sub ? path.join(this.dir, sub) : this.dir;
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  private get evidenceFile(): string {
    return path.join(this.dir, 'evidence.jsonl');
  }

  private get unknownsFile(): string {
    return path.join(this.dir, 'unknowns.jsonl');
  }

  newEvidenceId(operation: string): string {
    return `ev_${safeName(operation)}_${randomBytes(4).toString('hex')}`;
  }

  newUnknownId(): string {
    return `unk_${randomBytes(4).toString('hex')}`;
  }

  workDir(evidenceId: string): string {
    return this.ensure(path.join('work', evidenceId));
  }

  viewPath(evidenceId: string, name: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(evidenceId) || !/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new CeaError('INVALID_INPUT', 'invalid evidence id or view name', 'Use the evidence_id and view names exactly as returned in an Evidence record.');
    }
    return path.join(this.dir, 'views', evidenceId, name);
  }

  writeView(evidenceId: string, name: string, content: string, description: string): ViewRef {
    const clean = safeName(name);
    this.ensure(path.join('views', evidenceId));
    fs.writeFileSync(this.viewPath(evidenceId, clean), content, 'utf8');
    return {
      name: clean,
      description,
      bytes: Buffer.byteLength(content, 'utf8'),
      lines: countLines(content),
      sha256: sha256(content),
    };
  }

  readView(evidenceId: string, name: string): string {
    const p = this.viewPath(evidenceId, name);
    if (!fs.existsSync(p)) {
      throw new CeaError('NOT_FOUND', `no view "${name}" for evidence ${evidenceId}`, 'Call inspect_evidence_view with only evidence_id to list the views that exist.');
    }
    return fs.readFileSync(p, 'utf8');
  }

  append(e: Evidence): void {
    this.ensure();
    fs.appendFileSync(this.evidenceFile, JSON.stringify(e) + '\n', 'utf8');
  }

  list(): Evidence[] {
    return readJsonl<Evidence>(this.evidenceFile);
  }

  get(evidenceId: string): Evidence | undefined {
    return this.list().find((e) => e.evidence_id === evidenceId);
  }

  require(evidenceId: string): Evidence {
    const e = this.get(evidenceId);
    if (!e) {
      throw new CeaError('NOT_FOUND', `no evidence with id ${evidenceId} in session ${this.sessionId}`, 'Check the id, or the session (CEA_SESSION / --session). list_evidence shows what exists.');
    }
    return e;
  }

  putUnknown(u: UnknownRecord): void {
    this.ensure();
    fs.appendFileSync(this.unknownsFile, JSON.stringify(u) + '\n', 'utf8');
  }

  listUnknowns(): UnknownRecord[] {
    const latest = new Map<string, UnknownRecord>();
    for (const u of readJsonl<UnknownRecord>(this.unknownsFile)) latest.set(u.unknown_id, u);
    return [...latest.values()];
  }

  getUnknown(id: string): UnknownRecord | undefined {
    return this.listUnknowns().find((u) => u.unknown_id === id);
  }

  listViewFiles(evidenceId: string): string[] {
    const d = path.join(this.dir, 'views', evidenceId);
    return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
  }
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* a torn final line from an interrupted write is skipped, not fatal */
    }
  }
  return out;
}
