#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callTool, createContext, type Config, type ToolResponse } from './core/context.js';
import { findTool, jsonSchemaOf, TOOLS } from './registry.js';
import { serveStdio } from './server.js';
import { VERSION } from './version.js';

const HELP = `cea ${VERSION}: Compiler Engineering Agent

Usage:
  cea <tool> --json '<input>'      run a tool; prints its JSON result (an Evidence record,
                                   or a cea.response/1 envelope for the ledger tools)
  cea <tool> --input <file.json>   same, input read from a file ("-" for stdin)
  cea tools                        list tools
  cea schema <tool>                print a tool's JSON input schema
  cea doctor                       human-readable environment report
  cea triage <file> [options]      human-readable triage of a suspected miscompile
  cea mcp                          run the MCP server on stdio
  cea install-skill [--dir <dir>]  copy the agent skill (default: ~/.claude/skills)

Options:
  --session <name>   evidence session (default: $CEA_SESSION or "default")
  --home <dir>       where sessions are stored (default: $CEA_HOME or ./.cea)
  --compact          one-line JSON output

triage options:
  --compiler <name>  default clang
  --flags "<flags>"  suspect configuration, default "-O2"
  --ref "<flags>"    reference configuration, default "-O0"
  --no-reduce        skip test-case reduction
  --report <file>    also write the Markdown report to a file

Environment:
  CEA_TOOLCHAIN_DIRS       extra directories searched before PATH
  CEA_TOOL_<NAME>          explicit path for one provider, e.g. CEA_TOOL_ALIVE_TV
  CEA_REMOTE_PROVIDERS     set to "compiler-explorer" to allow sending IR to the Alive2 online instance
  CEA_ALLOW_UNSAFE_FLAGS   set to 1 to allow -fplugin and similar flags
  CEA_ALIVE2_CE_URL        base URL of the Alive2 Compiler Explorer instance
  CEA_CSMITH_INCLUDE       directory containing csmith.h
  NO_COLOR / FORCE_COLOR   turn colour off or on

Tool names accept dashes or underscores (cea check-ub == cea check_ub).`;

interface Args {
  positional: string[];
  opts: Map<string, string | true>;
}

const VALUE_OPTS = new Set(['json', 'input', 'session', 'home', 'compiler', 'flags', 'ref', 'report', 'dir']);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const opts = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) opts.set(key, a.slice(eq + 1));
      else if (VALUE_OPTS.has(key) && i + 1 < argv.length) opts.set(key, argv[++i]!);
      else opts.set(key, true);
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function print(response: ToolResponse, compact: boolean): void {
  process.stdout.write(JSON.stringify(response, null, compact ? undefined : 1) + '\n');
}

function exitCode(response: ToolResponse): number {
  return response.status === 'error' || response.status === 'unavailable' ? 2 : 0;
}

function readInput(args: Args): unknown {
  const inline = str(args.opts.get('json'));
  const file = str(args.opts.get('input'));
  let text = inline;
  if (text === undefined && file !== undefined) text = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
  if (text === undefined) return {};
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    process.stderr.write(`cea: input is not valid JSON: ${e instanceof Error ? e.message : String(e)}\nOn Windows shells quoting JSON is awkward; use --input <file.json> instead.\n`);
    process.exit(2);
  }
}

const useColor = process.stdout.isTTY === true && !process.env['NO_COLOR'] || process.env['FORCE_COLOR'] === '1';
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => paint('1', s);
const dim = (s: string) => paint('2', s);
const green = (s: string) => paint('32', s);
const red = (s: string) => paint('31', s);
const yellow = (s: string) => paint('33', s);
const cyan = (s: string) => paint('36', s);

/** Word-wrap to the terminal width, indenting continuation lines. */
function wrap(text: string, first: string, rest: string): string {
  const width = Math.max(60, Math.min(process.stdout.columns ?? 100, 110));
  const out: string[] = [];
  let line = first;
  for (const word of text.split(' ')) {
    if (line.length + word.length + 1 > width && line.trim().length > 0 && line !== first) {
      out.push(line);
      line = rest + word;
    } else {
      line += (line === first || line === rest ? '' : ' ') + word;
    }
  }
  out.push(line);
  return out.join('\n');
}

async function doctor(overrides: Partial<Config>): Promise<number> {
  const ctx = createContext(overrides);
  const e = await callTool(ctx, findTool('environment_report')!, {});
  const r = e.result as { host: Record<string, unknown>; providers: { id: string; available: boolean; version?: string; path?: string; reason?: string; remediation?: string }[]; sanitizers: Record<string, Record<string, boolean>>; warnings: string[] };
  console.log(bold(`cea ${VERSION} environment`) + dim(`  ${String(r.host['platform'])} ${String(r.host['arch'])}, ${String(r.host['cpu_model'])}`));
  for (const p of r.providers) {
    if (p.available) console.log(`  ${green('ok     ')} ${p.id.padEnd(13)} ${(p.version ?? '').replace(/ \(https?:[^)]*\)/, '')} ${dim(p.path ?? '')}`);
    else console.log(`  ${yellow('missing')} ${p.id.padEnd(13)} ${p.reason ?? ''}\n          ${dim(`fix: ${p.remediation ?? ''}`)}`);
  }
  for (const [c, table] of Object.entries(r.sanitizers)) {
    console.log(`  sanitizers with ${c}: ${Object.entries(table).map(([k, v]) => (v ? green(k) : dim(`${k} (no)`))).join(', ')}`);
  }
  for (const w of r.warnings) console.log(yellow(`  warning: ${w}`));
  if ('evidence_id' in e) console.log(dim(`  evidence: ${e.evidence_id}`));
  return exitCode(e);
}

async function triage(args: Args, overrides: Partial<Config>): Promise<number> {
  const file = args.positional[1];
  if (!file) {
    process.stderr.write('usage: cea triage <file> [--compiler clang] [--flags "-O2"] [--ref "-O0"] [--no-reduce] [--report out.md]\n');
    return 2;
  }
  const split = (s: string | undefined, d: string[]) => (s === undefined ? d : s.split(/\s+/).filter(Boolean));
  const input = {
    source: { path: file },
    compiler: str(args.opts.get('compiler')) ?? 'clang',
    flags: split(str(args.opts.get('flags')), ['-O2']),
    reference_flags: split(str(args.opts.get('ref')), ['-O0']),
    reduce: args.opts.get('no-reduce') !== true,
  };
  const ctx = createContext(overrides);
  console.log(`${bold('cea triage')} ${file}  ${dim(`${input.compiler} ${input.flags.join(' ')} vs ${input.reference_flags.join(' ')}`)}`);
  const e = await callTool(ctx, findTool('triage_miscompile')!, input);
  if (e.status === 'error' || e.status === 'unavailable') {
    console.log(red(`  error: ${e.error?.message ?? e.summary}`));
    if (e.error?.remediation) console.log(dim(`  fix: ${e.error.remediation}`));
    return 2;
  }
  const r = e.result as { verdict: string; headline: string; is_compiler_bug: string; steps: { step: string; evidence_id: string | null; status: string; summary: string }[]; report_markdown: string };
  for (const [i, s] of r.steps.entries()) {
    const mark = s.status === 'ok' ? green('ok') : s.status === 'inconclusive' ? yellow('??') : red('--');
    console.log(`  ${dim(`[${i + 1}]`)} ${s.step.padEnd(18)} ${mark}  ${wrap(s.summary, ' '.repeat(29), ' '.repeat(29)).slice(29)}`);
    console.log(`      ${dim(`evidence ${s.evidence_id}`)}`);
  }
  const color = r.verdict === 'transformation_refuted' ? red : r.verdict === 'unresolved' ? yellow : cyan;
  console.log('');
  console.log(`  ${bold('verdict:')} ${color(r.verdict)}`);
  console.log(wrap(r.headline, '  ', '  '));
  console.log(`  ${bold('compiler bug?')} ${r.is_compiler_bug}`);
  if ('evidence_id' in e) {
    if (e.observed.length) console.log(`  ${bold('observed:')}`);
    for (const o of e.observed) console.log(wrap(o, '    - ', '      '));
    if (e.inferred.length) console.log(`  ${bold('inferred:')}`);
    for (const o of e.inferred) console.log(wrap(o, '    - ', '      '));
    if (e.unknowns.length) console.log(`  ${bold('unknown:')}`);
    for (const o of e.unknowns) console.log(wrap(o, '    - ', '      '));
    console.log(dim(`  triage evidence ${e.evidence_id}  (report: view "report.md", or --report <file>)`));
    const out = str(args.opts.get('report'));
    if (out) {
      fs.writeFileSync(out, ctx.ledger.readView(e.evidence_id, 'report.md'), 'utf8');
      console.log(dim(`  report written to ${out}`));
    }
  }
  return 0;
}

function installSkill(args: Args): number {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.resolve(here, '..', 'skills', 'compiler-engineering');
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
    process.stderr.write(`cea: skill not found at ${src}\n`);
    return 2;
  }
  const root = str(args.opts.get('dir')) ?? path.join(os.homedir(), '.claude', 'skills');
  const dest = path.join(root, 'compiler-engineering');
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`Installed the compiler-engineering skill to ${dest}`);
  console.log('Register the MCP server with:  claude mcp add cea -- cea mcp');
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.positional[0];
  const overrides: Partial<Config> = {};
  const session = str(args.opts.get('session'));
  const home = str(args.opts.get('home'));
  if (session) overrides.session = session;
  if (home) overrides.home = home;

  if (args.opts.has('version') || cmd === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (!cmd || cmd === 'help' || (args.opts.has('help') && !cmd)) {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'tools') {
    if (args.opts.has('json')) console.log(JSON.stringify(TOOLS.map((t) => ({ name: t.name, family: t.family, title: t.title, description: t.description, inputSchema: jsonSchemaOf(t) })), null, 1));
    else for (const t of TOOLS) console.log(`${t.name.padEnd(26)} ${dim(`[${t.family}]`)} ${t.description.split('. ')[0]}.`);
    return 0;
  }
  if (cmd === 'schema') {
    const def = findTool(args.positional[1] ?? '');
    if (!def) {
      process.stderr.write(`cea: unknown tool "${args.positional[1] ?? ''}". Run "cea tools".\n`);
      return 2;
    }
    console.log(JSON.stringify(jsonSchemaOf(def), null, 1));
    return 0;
  }
  if (cmd === 'mcp') {
    await serveStdio(createContext(overrides));
    return new Promise<number>(() => { /* runs until the client closes stdio */ });
  }
  if (cmd === 'doctor') return doctor(overrides);
  if (cmd === 'triage') return triage(args, overrides);
  if (cmd === 'install-skill') return installSkill(args);

  const def = findTool(cmd);
  if (!def) {
    process.stderr.write(`cea: unknown command "${cmd}". Run "cea help" or "cea tools".\n`);
    return 2;
  }
  if (args.opts.has('help')) {
    console.log(`${def.name}: ${def.description}\n\nInput schema:\n${JSON.stringify(jsonSchemaOf(def), null, 1)}`);
    return 0;
  }
  const response = await callTool(createContext(overrides), def, readInput(args));
  print(response, args.opts.get('compact') === true);
  return exitCode(response);
}

main().then((code) => {
  process.exitCode = code;
}, (e) => {
  process.stderr.write(`cea: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exitCode = 1;
});
