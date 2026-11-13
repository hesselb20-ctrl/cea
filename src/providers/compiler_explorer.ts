import type { Ctx } from '../core/context.js';
import { CeaError } from '../core/errors.js';

export const REMOTE_ID = 'compiler-explorer';
export const GODBOLT_URL = 'https://godbolt.org';
/** The Alive2 project runs its own Compiler Explorer instance with alive-tv as a "compiler". */
export const ALIVE2_CE_URL = 'https://alive2.llvm.org/ce';

export interface CeResult {
  url: string;
  code: number;
  stdout: string;
  stderr: string;
  asm: string;
}

interface CeLine { text?: string }

/**
 * Compile on a Compiler Explorer instance. This sends `source` to a third party, so it only
 * runs when the user has opted in with CEA_REMOTE_PROVIDERS=compiler-explorer.
 */
export async function ceCompile(ctx: Ctx, baseUrl: string, compilerId: string, source: string, userArguments: string, timeoutMs = 60_000): Promise<CeResult> {
  if (!ctx.config.remoteProviders.has(REMOTE_ID)) {
    throw new CeaError(
      'REMOTE_DISABLED',
      'the Compiler Explorer remote provider is disabled',
      'It sends your source code to a third-party server. To allow that, set CEA_REMOTE_PROVIDERS=compiler-explorer in the environment of the cea server or CLI.',
    );
  }
  const url = `${baseUrl.replace(/\/$/, '')}/api/compiler/${encodeURIComponent(compilerId)}/compile`;
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ source, options: { userArguments, filters: { labels: false, directives: false, commentOnly: false, trim: false, intel: true }, compilerOptions: {} } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new CeaError('TOOL_FAILED', `request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`, 'Check network access, or install the tool locally.');
  }
  if (!res.ok) {
    throw new CeaError('TOOL_FAILED', `${url} answered HTTP ${res.status}`, 'The compiler id may be wrong or the service unavailable; try again or install the tool locally.');
  }
  const body = await res.json() as { code?: number; stdout?: CeLine[]; stderr?: CeLine[]; asm?: CeLine[] };
  const join = (xs: CeLine[] | undefined) => (xs ?? []).map((l) => l.text ?? '').join('\n');
  return { url, code: body.code ?? -1, stdout: join(body.stdout), stderr: join(body.stderr), asm: join(body.asm) };
}
