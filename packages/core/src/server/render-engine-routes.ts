import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ChromeDownloadState, ChromeDownloadOffer, RenderEngineStatus } from '@motion-studio/shared';
import { CftError, cftDownloadInfo, installCft, type CftDownloadInfo } from '../render/cft-download.ts';
import type { RenderEngine } from '../render/renderer.ts';
import { t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';

/**
 * The render engine of the System check (Task 8, carry 12): which Chromium renders now, and the on-demand Chrome for
 * Testing download of the CLI (global constraints: only with explicit consent, after showing its size, into the app data
 * folder; never bundled). On desktop the engine is Electron's own Chromium: nothing is offered.
 *
 * - `GET /api/render-engine`: the kind (`electron`, `system` with its version, `cft`, `injected`, or null) and the
 *   download's state. The executable's path is never sent.
 * - `GET /api/render-engine/download-info`: the version and exact size (metadata only: the manifest and a HEAD request).
 * - `POST /api/render-engine/download` `{ consent: true, sizeBytes }`: starts the download of exactly the size the user
 *   agreed to (409 when the offer changed meanwhile), one at a time; progress through the GET. Anything but
 *   `consent: true` is refused before any request goes out.
 */

/** Seam for tests: the real one reads Google's manifest and downloads into `<appData>/chromium/` (cft-download.ts). */
export interface ChromeInstaller {
  info(signal?: AbortSignal): Promise<CftDownloadInfo>;
  install(o: { consent: true; info: CftDownloadInfo; signal: AbortSignal; onProgress(p: { bytes: number; total: number | null }): void }): Promise<{ exe: string; version: string }>;
}

export function defaultChromeInstaller(appDataDir: string, endpoint?: string): ChromeInstaller {
  return {
    info: (signal) => cftDownloadInfo({ ...(endpoint ? { endpoint } : {}), ...(signal ? { signal } : {}) }),
    install: (o) => installCft({ consent: o.consent, appDataDir, info: o.info, signal: o.signal, onProgress: o.onProgress, ...(endpoint ? { endpoint } : {}) }),
  };
}

const downloadBody = z.object({ consent: z.literal(true), sizeBytes: z.number().int().positive() }).strict();

/**
 * What the UI is told about a failed metadata read or download (fix round 1): a stable code only (a CftError's, else
 * `error`), never the raw message, which may hold local paths; the detail goes to the core's log.
 */
function failureCode(e: unknown, what: string): string {
  console.warn(`Motion Studio: Chrome for Testing ${what} failed: ${(e as Error)?.message ?? String(e)}`);
  return e instanceof CftError ? e.code : 'error';
}

export function registerRenderEngineRoutes(app: FastifyInstance, ctx: { engine: RenderEngine | undefined; installer: ChromeInstaller | null }): void {
  let download: ChromeDownloadState = { state: 'idle', bytes: 0, total: null };
  /**
   * One download at a time (fix round 1, I1): claimed synchronously, before the first await, by the request that passed
   * the consent check, and released on every path (a refusal, or once the install settles).
   */
  let claimed = false;
  const closing = new AbortController();
  app.addHook('preClose', async () => { closing.abort(new Error('closed')); });

  const kindNow = async () => (ctx.engine ? await ctx.engine.info().catch(() => ({ kind: null })) : { kind: null });
  const statusNow = async (): Promise<RenderEngineStatus> => {
    const info = await kindNow();
    return {
      kind: info.kind, ...('version' in info && info.version ? { version: info.version } : {}),
      downloadable: ctx.installer !== null && ctx.engine !== undefined && info.kind === null, download: { ...download },
    };
  };
  const offer = async (): Promise<CftDownloadInfo> => {
    if (!ctx.installer) throw new CodedError(503, t().errors.chromeDownloadUnavailable, 'chrome-download-unavailable');
    try {
      return await ctx.installer.info(closing.signal);
    } catch (e) {
      throw new CodedError(503, t().errors.chromeInfoFailed({ code: failureCode(e, 'metadata') }), 'chrome-info-failed');
    }
  };

  app.get('/api/render-engine', async () => statusNow());

  app.get('/api/render-engine/download-info', async (): Promise<ChromeDownloadOffer> => {
    const o = await offer();
    return { version: o.version, sizeBytes: o.sizeBytes };
  });

  app.post('/api/render-engine/download', async (req, reply) => {
    const body = downloadBody.safeParse(req.body ?? {});
    // Nothing is asked of the network before the consent is there.
    if (!body.success) throw new CodedError(400, t().errors.chromeConsentRequired, 'consent-required');
    if (!ctx.installer || !ctx.engine) throw new CodedError(503, t().errors.chromeDownloadUnavailable, 'chrome-download-unavailable');
    // Another request holds the slot (it is checking the offer, or downloading): this one starts nothing.
    // The racer that lost reports a download in progress, even while the winner is still checking the offer (state not
    // 'running' yet): the UI must not show "idle" or an old failure for a download that is about to start.
    if (claimed) {
      const now = await statusNow();
      return reply.status(202).send(now.download.state === 'running' ? now : { ...now, download: { state: 'running', bytes: 0, total: null } });
    }
    claimed = true;
    let started = false;
    try {
      if ((await kindNow()).kind !== null) throw new CodedError(409, t().errors.renderEngineAvailable, 'engine-available');
      const info = await offer();
      // The size the user agreed to must be the one downloaded (installCft checks the bytes against it too).
      if (info.sizeBytes !== body.data.sizeBytes) throw new CodedError(409, t().errors.chromeSizeChanged, 'download-size-changed');
      download = { state: 'running', bytes: 0, total: info.sizeBytes };
      const installer = ctx.installer;
      started = true;
      void (async () => {
        try {
          await installer.install({
            consent: true, info, signal: closing.signal,
            onProgress: (p) => { if (download.state === 'running') download = { state: 'running', bytes: p.bytes, total: info.sizeBytes }; },
          });
          download = { state: 'done', bytes: info.sizeBytes, total: info.sizeBytes };
        } catch (e) {
          download = { state: 'failed', bytes: download.bytes, total: info.sizeBytes, error: t().errors.chromeDownloadFailed({ code: failureCode(e, 'download') }) };
        } finally {
          claimed = false;
        }
      })();
    } finally {
      if (!started) claimed = false;
    }
    return reply.status(202).send(await statusNow());
  });
}
