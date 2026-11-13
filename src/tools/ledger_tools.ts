import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineTool, type Ctx } from '../core/context.js';
import { CeaError } from '../core/errors.js';
import type { UnknownRecord } from '../core/types.js';
import { normalizeNewlines } from '../core/util.js';

const EvidenceId = z.string().regex(/^ev_[A-Za-z0-9._-]+$/, 'must be an evidence_id such as ev_compile_1a2b3c4d');
const UnknownId = z.string().regex(/^unk_[a-f0-9]+$/, 'must be an unknown_id such as unk_1a2b3c4d');

export const inspectEvidenceView = defineTool({
  name: 'inspect_evidence_view',
  family: 'ledger',
  title: 'Inspect evidence view',
  description:
    'Read a stored Evidence record, or page through one of its raw output views (IR, assembly, diffs, stdout/stderr) by line range, optionally filtered by a substring. ' +
    'Large outputs live on disk; this is how to read them without flooding the context.',
  input: z.strictObject({
    evidence_id: EvidenceId,
    view: z.string().max(200).optional().describe('View name from the record\'s `views`. Omit to get the record and the list of views.'),
    offset: z.number().int().min(0).default(0).describe('First line (0-based) of the page.'),
    limit: z.number().int().min(1).max(2000).default(200).describe('Number of lines.'),
    contains: z.string().max(500).optional().describe('Keep only lines containing this substring (applied before paging). Matching line numbers are returned.'),
  }),
  async query(input, ctx) {
    const e = ctx.ledger.require(input.evidence_id);
    if (!input.view) {
      return { status: 'ok', summary: `${e.operation}: ${e.summary}`, result: { evidence: e, views: e.views } };
    }
    const lines = normalizeNewlines(ctx.ledger.readView(input.evidence_id, input.view)).split('\n');
    let numbered = lines.map((text, i) => ({ n: i, text }));
    if (input.contains) numbered = numbered.filter((l) => l.text.includes(input.contains!));
    const page = numbered.slice(input.offset, input.offset + input.limit);
    const next = input.offset + input.limit < numbered.length ? input.offset + input.limit : null;
    return {
      status: 'ok',
      summary: `${input.view}: lines ${input.offset}-${input.offset + page.length - 1} of ${numbered.length}${input.contains ? ' matching' : ''}`,
      result: {
        evidence_id: input.evidence_id,
        view: input.view,
        total_lines: lines.length,
        matching_lines: numbered.length,
        offset: input.offset,
        next_offset: next,
        text: input.contains ? page.map((l) => `${l.n}: ${l.text}`).join('\n') : page.map((l) => l.text).join('\n'),
      },
    };
  },
});

export const listEvidence = defineTool({
  name: 'list_evidence',
  family: 'ledger',
  title: 'List evidence',
  description: 'List the Evidence records of the session (id, operation, status, summary), newest last. Use it to find IDs to cite.',
  input: z.strictObject({
    operation: z.string().max(100).optional().describe('Only records of this tool.'),
    limit: z.number().int().min(1).max(500).default(50),
  }),
  async query(input, ctx) {
    let all = ctx.ledger.list();
    if (input.operation) all = all.filter((e) => e.operation === input.operation);
    const shown = all.slice(-input.limit);
    return {
      status: 'ok',
      summary: `${all.length} evidence record(s) in session ${ctx.ledger.sessionId}`,
      result: {
        total: all.length,
        evidence: shown.map((e) => ({ evidence_id: e.evidence_id, operation: e.operation, status: e.status, created_at: e.created_at, summary: e.summary, derived_from: e.derived_from })),
      },
    };
  },
});

function checkIds(ctx: Ctx, ids: string[]): void {
  const known = new Set(ctx.ledger.list().map((e) => e.evidence_id));
  const missing = ids.filter((i) => !known.has(i));
  if (missing.length > 0) {
    throw new CeaError('NOT_FOUND', `unknown evidence id(s): ${missing.join(', ')}`, 'Only cite evidence that exists in this session; list_evidence shows the IDs.');
  }
}

export const recordUnknown = defineTool({
  name: 'record_unknown',
  family: 'ledger',
  title: 'Record unknown',
  description:
    'Record an open question that the evidence so far does not settle, with the evidence that supports and contradicts each reading. ' +
    'Writing unknowns down is what keeps a plausible guess from being reported as a finding.',
  input: z.strictObject({
    question: z.string().min(5).max(2000),
    why_it_matters: z.string().max(2000).default(''),
    supporting_evidence: z.array(EvidenceId).max(100).default([]),
    contradicting_evidence: z.array(EvidenceId).max(100).default([]),
    note: z.string().max(4000).optional(),
  }),
  async query(input, ctx) {
    checkIds(ctx, [...input.supporting_evidence, ...input.contradicting_evidence]);
    const now = new Date().toISOString();
    const u: UnknownRecord = {
      unknown_id: ctx.ledger.newUnknownId(),
      session_id: ctx.ledger.sessionId,
      created_at: now,
      updated_at: now,
      question: input.question,
      why_it_matters: input.why_it_matters,
      status: 'open',
      supporting_evidence: input.supporting_evidence,
      contradicting_evidence: input.contradicting_evidence,
      notes: input.note ? [input.note] : [],
      resolution: null,
    };
    ctx.ledger.putUnknown(u);
    return { status: 'ok', summary: `recorded open question ${u.unknown_id}`, result: { unknown: u, open_unknowns: ctx.ledger.listUnknowns().filter((x) => x.status === 'open').length } };
  },
});

export const updateUnknown = defineTool({
  name: 'update_unknown',
  family: 'ledger',
  title: 'Update unknown',
  description:
    'Add supporting or contradicting evidence to an open question, add a note, or close it. Resolving requires a resolution text and at least one evidence ID on the record.',
  input: z.strictObject({
    unknown_id: UnknownId,
    add_supporting_evidence: z.array(EvidenceId).max(100).default([]),
    add_contradicting_evidence: z.array(EvidenceId).max(100).default([]),
    note: z.string().max(4000).optional(),
    status: z.enum(['open', 'resolved', 'wont_resolve']).optional(),
    resolution: z.string().max(4000).optional(),
  }),
  async query(input, ctx) {
    const cur = ctx.ledger.getUnknown(input.unknown_id);
    if (!cur) throw new CeaError('NOT_FOUND', `no unknown with id ${input.unknown_id}`, 'Use an unknown_id returned by record_unknown in this session.');
    checkIds(ctx, [...input.add_supporting_evidence, ...input.add_contradicting_evidence]);
    const u: UnknownRecord = {
      ...cur,
      updated_at: new Date().toISOString(),
      supporting_evidence: [...new Set([...cur.supporting_evidence, ...input.add_supporting_evidence])],
      contradicting_evidence: [...new Set([...cur.contradicting_evidence, ...input.add_contradicting_evidence])],
      notes: input.note ? [...cur.notes, input.note] : cur.notes,
      status: input.status ?? cur.status,
      resolution: input.resolution ?? cur.resolution,
    };
    if (u.status === 'resolved') {
      if (!u.resolution) throw new CeaError('INVALID_INPUT', 'resolving an unknown needs a resolution text', 'Pass `resolution` describing what settled the question.');
      if (u.supporting_evidence.length + u.contradicting_evidence.length === 0) {
        throw new CeaError('INVALID_INPUT', 'an unknown cannot be resolved without evidence', 'Attach the evidence IDs that settle it with add_supporting_evidence or add_contradicting_evidence, or close it as wont_resolve.');
      }
    }
    ctx.ledger.putUnknown(u);
    return { status: 'ok', summary: `${u.unknown_id} is ${u.status}`, result: { unknown: u } };
  },
});

export const exportEvidenceBundle = defineTool({
  name: 'export_evidence_bundle',
  family: 'ledger',
  title: 'Export evidence bundle',
  description:
    'Write the whole session (every Evidence record, every unknown, and the raw views) to one portable JSON file, plus a Markdown index, for attaching to a bug report or handing to a reviewer.',
  input: z.strictObject({
    output_path: z.string().min(1).optional().describe('Where to write the bundle. Default: <session dir>/bundle-<session>.cea.json'),
    include_views: z.boolean().default(true).describe('Embed raw views. Views larger than max_view_bytes are listed but not embedded.'),
    max_view_bytes: z.number().int().min(0).max(50_000_000).default(2_000_000),
  }),
  async query(input, ctx) {
    const evidence = ctx.ledger.list();
    const unknowns = ctx.ledger.listUnknowns();
    const views: { evidence_id: string; name: string; bytes: number; embedded: boolean; text?: string }[] = [];
    if (input.include_views) {
      for (const e of evidence) {
        for (const v of e.views) {
          const p = ctx.ledger.viewPath(e.evidence_id, v.name);
          if (!fs.existsSync(p)) continue;
          const bytes = fs.statSync(p).size;
          if (bytes <= input.max_view_bytes) views.push({ evidence_id: e.evidence_id, name: v.name, bytes, embedded: true, text: fs.readFileSync(p, 'utf8') });
          else views.push({ evidence_id: e.evidence_id, name: v.name, bytes, embedded: false });
        }
      }
    }
    const out = path.resolve(input.output_path ?? path.join(ctx.ledger.dir, `bundle-${ctx.ledger.sessionId}.cea.json`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const bundle = { schema: 'cea.bundle/1', exported_at: new Date().toISOString(), session_id: ctx.ledger.sessionId, evidence, unknowns, views };
    fs.writeFileSync(out, JSON.stringify(bundle, null, 1), 'utf8');
    const md = [
      `# cea evidence bundle: session ${ctx.ledger.sessionId}`,
      '',
      `${evidence.length} evidence record(s), ${unknowns.length} unknown(s). Full data: \`${path.basename(out)}\`.`,
      '',
      '| Evidence | Operation | Status | Summary |',
      '|---|---|---|---|',
      ...evidence.map((e) => `| \`${e.evidence_id}\` | ${e.operation} | ${e.status} | ${e.summary.replace(/\|/g, '\\|')} |`),
      '',
      '## Open questions',
      '',
      ...(unknowns.length ? unknowns.map((u) => `- \`${u.unknown_id}\` [${u.status}] ${u.question}${u.resolution ? ` Resolution: ${u.resolution}` : ''}`) : ['None recorded.']),
      '',
    ].join('\n');
    const mdPath = out.replace(/(\.cea)?\.json$/, '') + '.md';
    fs.writeFileSync(mdPath, md, 'utf8');
    return {
      status: 'ok',
      summary: `exported ${evidence.length} evidence record(s) to ${out}`,
      result: { bundle_path: out, index_path: mdPath, bytes: fs.statSync(out).size, evidence_count: evidence.length, unknown_count: unknowns.length, views_embedded: views.filter((v) => v.embedded).length, views_skipped: views.filter((v) => !v.embedded).length },
    };
  },
});
