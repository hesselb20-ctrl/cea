import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callTool, type Ctx } from './core/context.js';
import { findTool, jsonSchemaOf, TOOLS } from './registry.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = [
  'cea gives you a compiler engineer\'s toolbox and makes you prove every claim.',
  'Rules: semantics before speed, evidence before claims, small before large.',
  'Start with environment_report. Never conclude "compiler bug" before check_ub is clean, and never claim "faster" without benchmark spread.',
  'Every tool returns an Evidence record: cite its evidence_id, and keep observed, inferred and unknown apart.',
  'Large outputs are views on disk: page them with inspect_evidence_view.',
].join(' ');

export function createServer(ctx: Ctx): Server {
  const server = new Server({ name: 'cea', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: jsonSchemaOf(t) as { type: 'object'; [k: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const def = findTool(req.params.name);
    if (!def) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'NOT_FOUND', message: `unknown tool ${req.params.name}`, remediation: `Available tools: ${TOOLS.map((t) => t.name).join(', ')}` } }) }],
      };
    }
    const response = await callTool(ctx, def, req.params.arguments ?? {});
    return {
      isError: response.status === 'error' || response.status === 'unavailable',
      content: [{ type: 'text', text: JSON.stringify(response, null, 1) }],
    };
  });
  return server;
}

export async function serveStdio(ctx: Ctx): Promise<void> {
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
}
