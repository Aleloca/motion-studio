import { rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { relativeFileSchema, webUrlSchema, type ServerMessage } from '@motion-studio/shared';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { saveGeneratedFile } from '../providers/files.ts';
import { ProviderError } from '../providers/http.ts';
import type { LookupFn, Transport } from '../providers/safe-fetch.ts';
import { downloadBytes } from '../providers/safe-url.ts';
import type { BridgeContext } from './bridge.ts';
import type { BridgeHandler } from './bridge-routes.ts';
import { jobHttp } from './provider-tools.ts';
import { t } from '../i18n.ts';

export interface DownloadToolDeps {
  media: MediaTools; broadcast(m: ServerMessage): void;
  /** Tests: the site's responses (downloads still go through the resolved-address check). */
  fetch?: typeof fetch; transport?: Transport; lookup?: LookupFn;
}

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_URL = 2000;
const DIRS = { brand: ['brand'], fonts: ['font'] } as const;
const EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'avif', 'woff', 'woff2', 'ttf', 'otf']);
const cancelled = (): string => t().errors.jobCancelled;
const badDest = (): string => t().providers.invalidDestination;

function destination(raw: unknown): { dir: keyof typeof DIRS; name: string } {
  if (typeof raw !== 'string' || !relativeFileSchema.safeParse(raw).success) throw new ProviderError(400, badDest());
  const parts = raw.split('/');
  if (parts.length !== 3 || parts[0] !== 'assets' || !Object.hasOwn(DIRS, parts[1]!) || parts.some((p) => p.startsWith('.'))) throw new ProviderError(400, badDest());
  if (!EXTENSIONS.has(extname(parts[2]!).slice(1).toLowerCase())) throw new ProviderError(400, badDest());
  return { dir: parts[1] as keyof typeof DIRS, name: parts[2]! };
}

/**
 * MCP tool `download_file` for brand analysis (whose sandbox has no network): the core downloads a logo, image or
 * font from a website into assets/brand or assets/fonts, under a new name, and registers it. Failures leave nothing behind.
 */
export function downloadTool(deps: DownloadToolDeps): BridgeHandler {
  const alive = (c: BridgeContext) => { if (c.signal.aborted) throw new ProviderError(499, cancelled()); };
  const run: BridgeHandler = async (c, a) => {
    if (c.kind !== 'brand-analysis') throw new ProviderError(403, t().errors.toolUnavailable);
    const url = a.url;
    if (typeof url !== 'string' || url.length > MAX_URL || !webUrlSchema.safeParse(url).success) throw new ProviderError(400, t().providers.invalidUrl);
    const { dir, name } = destination(a.dest);
    const host = new URL(url).hostname;
    let bytes: Buffer;
    try {
      ({ bytes } = await downloadBytes(jobHttp(deps, c), url, {}, { provider: host, secrets: [], maxBytes: MAX_BYTES, allowHttp: true }));
    } catch (e) {
      // http.ts words 401/403 for API keys; a website simply refuses the file.
      if (e instanceof ProviderError && (e.upstreamStatus === 401 || e.upstreamStatus === 403)) throw new ProviderError(502, t().providers.accessDenied({ host, status: e.upstreamStatus }), e.upstreamStatus);
      throw e;
    }
    alive(c);
    const file = await saveGeneratedFile(c.projectDir, dir, name, bytes);
    try {
      alive(c);
      await new LibraryStore(c.projectDir, deps.media).registerAssets([{ file, origin: 'website', sourceUrl: url, description: '', tags: [...DIRS[dir]] }]);
    } catch (e) {
      await rm(join(c.projectDir, 'assets', ...file.split('/')), { force: true }).catch(() => {});
      throw e;
    }
    deps.broadcast({ type: 'library', project: c.projectSlug });
    return { file: `assets/${file}` };
  };
  return async (c, a) => {
    try { return await run(c, a); }
    catch (e) {
      if (c.signal.aborted) throw new ProviderError(499, cancelled());
      throw e;
    }
  };
}
