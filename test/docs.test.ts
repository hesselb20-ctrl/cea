/**
 * Keeps the documentation honest: every link resolves, every tool is documented, and every
 * tool or field name the docs mention exists in the source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsonSchemaOf, TOOLS } from '../src/registry.js';

const root = path.resolve('.');
const walk = (dir: string, keep: (f: string) => boolean): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(p, keep);
      return keep(p) ? [p] : [];
    })
    : [];
const md = (f: string) => f.endsWith('.md');
const docs = [
  ...['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'].map((f) => path.join(root, f)),
  ...walk(path.join(root, 'docs'), md),
  ...walk(path.join(root, 'skills'), md),
  ...walk(path.join(root, 'examples'), md),
  ...walk(path.join(root, '.github'), md),
];
const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');
const read = (f: string) => fs.readFileSync(f, 'utf8');
const toolNames = TOOLS.map((t) => t.name);
const skillDir = path.join(root, 'skills', 'compiler-engineering');

describe('documentation files', () => {
  it('has every file the project promises', () => {
    for (const f of [
      'README.md', 'LICENSE', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md', 'PROGRESS.md', 'docs/design.md',
      'docs/tools-environment.md', 'docs/tools-compile.md', 'docs/tools-correctness.md', 'docs/tools-performance.md', 'docs/tools-ledger.md', 'docs/triage.md', 'docs/cli.md',
      'docs/demo/triage.gif', 'docs/demo/triage.cast',
      '.github/workflows/ci.yml', '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md',
      'skills/compiler-engineering/SKILL.md',
      ...['miscompile-triage', 'ir-and-optimization', 'frontend-and-types', 'backend-and-hardware', 'performance-and-codegen', 'verification-and-testing', 'connection-and-recovery'].map((n) => `skills/compiler-engineering/references/${n}.md`),
      ...['01-ub-not-a-compiler-bug', '02-missed-vectorization-aliasing', '03-alive2-counterexample', '04-crash-reduction', '05-ub-sanitizers-cannot-see'].map((n) => `examples/${n}/README.md`),
    ]) {
      expect(fs.existsSync(path.join(root, f)), f).toBe(true);
    }
  });

  it('opens the README with the hero and the pitch, and keeps the demo', () => {
    const readme = read(path.join(root, 'README.md'));
    const firstLines = readme.split('\n').slice(0, 8).join('\n');
    expect(firstLines).toContain('.github/assets/hero-light.svg');
    expect(firstLines).toContain('Makes coding agents prove compiler claims.');
    expect(readme).toContain('docs/demo/triage.gif');
  });
});

describe('links', () => {
  it('every relative link in every Markdown file points at a file that exists', () => {
    const broken: string[] = [];
    for (const f of docs.filter((d) => fs.existsSync(d))) {
      const text = read(f).replace(/```[\s\S]*?```/g, '');
      for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = m[1]!;
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const file = decodeURIComponent(target.split('#')[0]!);
        if (!fs.existsSync(path.resolve(path.dirname(f), file))) broken.push(`${rel(f)} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('skill', () => {
  const skill = read(path.join(skillDir, 'SKILL.md'));

  it('has frontmatter with name, description and version', () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill.replace(/\r\n/g, '\n'));
    expect(fm).not.toBeNull();
    const keys = Object.fromEntries(fm![1]!.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
    expect(keys['name']).toBe('compiler-engineering');
    expect(keys['description']!.length).toBeGreaterThan(80);
    expect(keys['version']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('links every reference guide and routes to it', () => {
    for (const f of fs.readdirSync(path.join(skillDir, 'references'))) {
      expect(skill, f).toContain(`(references/${f})`);
    }
  });

  it('states the rules the project enforces', () => {
    for (const needle of ['Semantics before speed', 'Evidence before claims', 'Small before large', 'exact compiler version', 'undefined behaviour before blaming', 'Never disable a verifier', 'No speed claim without variance', 'Cite evidence IDs', 'observed, inferred and unknown']) {
      expect(skill.toLowerCase(), needle).toContain(needle.toLowerCase());
    }
  });

  it('every reference starts with when to read it and ends with a checklist', () => {
    for (const f of fs.readdirSync(path.join(skillDir, 'references'))) {
      const t = read(path.join(skillDir, 'references', f));
      expect(t, f).toMatch(/When to read this/i);
      expect(t, f).toMatch(/Checklist before you conclude/i);
    }
  });
});

describe('tools and documentation agree', () => {
  const readme = fs.existsSync(path.join(root, 'README.md')) ? read(path.join(root, 'README.md')) : '';
  const toolDocs = walk(path.join(root, 'docs'), md).map(read).join('\n');
  const skill = read(path.join(skillDir, 'SKILL.md'));

  it('every tool in the server is documented in the README, the docs and the skill', () => {
    for (const n of toolNames) {
      expect(readme, `README lacks ${n}`).toContain(`\`${n}\``);
      expect(toolDocs, `docs lack ${n}`).toContain(`\`${n}\``);
      expect(skill, `SKILL.md lacks ${n}`).toContain(`\`${n}\``);
    }
  });

  it('every tool or field name the docs put in backticks exists in the source', () => {
    // Anything in backticks that looks like an identifier (lower_snake_case) must be a tool,
    // an input field of some tool, or an identifier that occurs in the source code.
    const known = new Set<string>(toolNames);
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(collect);
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'properties' && v && typeof v === 'object') Object.keys(v).forEach((p) => known.add(p));
          collect(v);
        }
      }
    };
    TOOLS.forEach((t) => collect(jsonSchemaOf(t)));
    const source = walk(path.join(root, 'src'), (f) => f.endsWith('.ts')).map(read).join('\n');
    const inSource = (id: string) => new RegExp(`(?<![A-Za-z0-9_])${id}(?![A-Za-z0-9_])`).test(source);
    const unknown: string[] = [];
    for (const f of docs.filter((d) => fs.existsSync(d))) {
      for (const m of read(f).replace(/```[\s\S]*?```/g, '').matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
        const id = m[1]!;
        if (/^(ev|unk)_/.test(id)) continue; // example evidence and unknown IDs
        if (!known.has(id) && !inSource(id)) unknown.push(`${rel(f)}: \`${id}\``);
      }
    }
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('every `cea <command>` shown in the docs is a real command', () => {
    const commands = new Set([...toolNames, ...toolNames.map((n) => n.replace(/_/g, '-')), 'tools', 'schema', 'doctor', 'triage', 'mcp', 'install-skill', 'help', 'version']);
    const bad: string[] = [];
    for (const f of docs.filter((d) => fs.existsSync(d))) {
      const text = read(f).replace(/\r\n/g, '\n');
      const found: string[] = [];
      // Command lines inside fenced code blocks, and inline code spans that start with "cea ".
      for (const block of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
        for (const m of block[1]!.matchAll(/^\s*(?:\$ )?cea ([a-z][a-z_-]*)/gm)) found.push(m[1]!);
      }
      for (const m of text.replace(/```[\s\S]*?```/g, '').matchAll(/`cea ([a-z][a-z_-]*)[^`]*`/g)) found.push(m[1]!);
      for (const c of found) if (!commands.has(c)) bad.push(`${rel(f)}: cea ${c}`);
    }
    expect([...new Set(bad)]).toEqual([]);
  });
});
