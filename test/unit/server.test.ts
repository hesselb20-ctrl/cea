import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { findTool, jsonSchemaOf, TOOLS } from '../../src/registry.js';
import { createServer } from '../../src/server.js';
import { C_SRC, fake, writeOut } from '../helpers.js';

const REQUIRED = [
  'environment_report', 'compile', 'emit_ir', 'pass_timeline', 'opt_remarks', 'check_ub', 'differential_run', 'bisect_passes',
  'reduce_testcase', 'validate_transform', 'analyze_throughput', 'benchmark', 'fuzz_compiler', 'bisect_compiler_history',
  'record_unknown', 'update_unknown', 'export_evidence_bundle', 'inspect_evidence_view', 'triage_miscompile',
];

describe('registry', () => {
  it('contains every tool the specification requires', () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of REQUIRED) expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every tool a strict object schema, a title and a real description', () => {
    for (const t of TOOLS) {
      const s = jsonSchemaOf(t);
      expect(s['type'], t.name).toBe('object');
      expect(s['additionalProperties'], t.name).toBe(false);
      expect(t.description.length, t.name).toBeGreaterThan(60);
      expect(t.title.length, t.name).toBeGreaterThan(3);
      expect(Boolean(t.run) !== Boolean(t.query), `${t.name} must be either a recording tool or a ledger tool`).toBe(true);
    }
  });

  it('accepts dashes or underscores in tool names', () => {
    expect(findTool('check-ub')?.name).toBe('check_ub');
    expect(findTool('check_ub')?.name).toBe('check_ub');
    expect(findTool('nope')).toBeUndefined();
  });
});

describe('MCP server', () => {
  async function connect(f = fake({ clang: (args) => { if (args.includes('-o')) writeOut(args, 'f:\n\tretq\n'); return undefined; } })) {
    const server = createServer(f.ctx);
    const client = new Client({ name: 'test', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, f };
  }
  const textOf = (r: unknown) => ((r as { content: { type: string; text: string }[] }).content[0]!.text);

  it('lists the same tools as the registry, with JSON schemas', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    const compile = tools.find((t) => t.name === 'compile')!;
    expect(compile.inputSchema.type).toBe('object');
    expect(Object.keys(compile.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['source', 'compiler', 'flags', 'output']));
    expect(client.getInstructions()).toMatch(/evidence before claims/);
  });

  it('runs a tool and returns the Evidence record as JSON text', async () => {
    const { client, f } = await connect();
    const r = await client.callTool({ name: 'compile', arguments: { source: C_SRC } });
    expect(r.isError).toBe(false);
    const e = JSON.parse(textOf(r));
    expect(e.schema).toBe('cea.evidence/1');
    expect(e.result.success).toBe(true);
    expect(f.ctx.ledger.get(e.evidence_id)).toBeDefined();
    const page = await client.callTool({ name: 'inspect_evidence_view', arguments: { evidence_id: e.evidence_id, view: 'output.s' } });
    expect(JSON.parse(textOf(page)).result.text).toContain('retq');
  });

  it('flags errors with isError and keeps the remediation', async () => {
    const { client } = await connect(fake({}));
    const r = await client.callTool({ name: 'compile', arguments: { source: C_SRC } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(textOf(r)).error.code).toBe('PROVIDER_UNAVAILABLE');
    const bad = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/Available tools/);
  });
});
