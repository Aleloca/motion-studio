import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { elevenlabsVoices } from '../providers/elevenlabs-audio.ts';
import { ProviderError, type HttpDeps } from '../providers/http.ts';
import type { KeyCheckCache } from '../providers/key-check.ts';
import { fetchVoicePreview, isElevenLabsPreviewUrl, OPENAI_VOICES, VOICE_ID } from '../providers/voices.ts';
import type { SecretsVault } from '../secrets/vault.ts';
import { WorkspaceError } from '../workspace-store.ts';
import type { UrlSigner } from './signed-urls.ts';
import { t } from '../i18n.ts';

export interface VoicesRoutesContext { vault: SecretsVault; http: HttpDeps; signer: UrlSigner; keyChecks: KeyCheckCache }

export interface VoiceEntry { id: string; name: string; labels: Record<string, string>; /** Signed, short-lived core URL of the preview; null when the voice has none. */ previewUrl: string | null }

const PREVIEW_BASE = '/api/voices/preview';
const previewPath = (provider: string, id: string) => `${PREVIEW_BASE}/${provider}/${encodeURIComponent(id)}`;
const listQuery = z.object({ provider: z.enum(['elevenlabs', 'openai']), q: z.string().max(100).optional() });
const previewParams = z.object({ provider: z.literal('elevenlabs'), id: z.string().regex(VOICE_ID) });
const parse = <T>(s: z.ZodType<T>, b: unknown): T => { const r = s.safeParse(b ?? {}); if (!r.success) throw new WorkspaceError(400, t().errors.invalidRequest); return r.data; };
/** A provider failure is an answer with its own status, not a 500 (and never 401: that is the UI token's). */
const asHttp = async <T>(run: () => Promise<T>): Promise<T> => {
  try { return await run(); } catch (e) { if (e instanceof ProviderError) throw new WorkspaceError(e.status === 400 || e.status === 404 || e.status === 429 ? e.status : 503, e.message); throw e; }
};
const abortOnClose = (reply: FastifyReply): AbortSignal => {
  const ac = new AbortController();
  reply.raw.once('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
  return ac.signal;
};

/** Preview URLs the authenticated list has seen (core memory only), so the preview route fetches only what a response gave. */
const REMEMBERED = 500;

export function registerVoicesRoutes(app: FastifyInstance, ctx: VoicesRoutesContext) {
  const known = new Map<string, string>();
  const remember = (id: string, url: string) => {
    known.delete(id);
    known.set(id, url);
    if (known.size > REMEMBERED) known.delete(known.keys().next().value!);
  };

  // The list is authenticated; each voice carries a short-lived signed preview URL (an <audio> element cannot send the UI token).
  app.get('/api/voices', async (req) => {
    const q = parse(listQuery, req.query);
    const search = q.q?.trim().toLowerCase() ?? '';
    const configured = Boolean(await ctx.vault.get(q.provider));
    if (q.provider === 'openai') {
      // Fixed list, no preview: OpenAI offers none and a spoken sample would be a paid call.
      const voices: VoiceEntry[] = OPENAI_VOICES.filter((v) => !search || v.includes(search)).map((v) => ({ id: v, name: v, labels: {}, previewUrl: null }));
      return { provider: 'openai', configured, voices, previewExpiresAt: 0 };
    }
    if (!configured) return { provider: 'elevenlabs', configured, voices: [] as VoiceEntry[], previewExpiresAt: 0 };
    const apiKey = (await ctx.vault.get('elevenlabs'))!;
    // Learned only while this key is still the vault's (M2).
    const lease = ctx.keyChecks.lease('elevenlabs', apiKey);
    const list = await asHttp(async () => {
      try { return await elevenlabsVoices({ ...ctx.http, apiKey }, { search: q.q, pageSize: 30 }); }
      catch (e) {
        // A 401/403 means the key lacks the voices permission: remembered in memory, then the error goes on.
        if (e instanceof ProviderError && (e.upstreamStatus === 401 || e.upstreamStatus === 403)) await ctx.keyChecks.recordUse(ctx.vault, lease, 'voices', 'missing', 'voices_read');
        throw e;
      }
    });
    await ctx.keyChecks.recordUse(ctx.vault, lease, 'voices', 'ok');
    let expiresAt = 0;
    const voices: VoiceEntry[] = [];
    for (const v of list) {
      if (!VOICE_ID.test(v.id)) continue;
      let previewUrl: string | null = null;
      if (v.previewUrl && isElevenLabsPreviewUrl(v.previewUrl)) {
        remember(v.id, v.previewUrl);
        const s = ctx.signer.sign(previewPath('elevenlabs', v.id));
        previewUrl = s.url;
        expiresAt = s.expiresAt;
      }
      voices.push({ id: v.id, name: v.name, labels: v.labels, previewUrl });
    }
    return { provider: 'elevenlabs', configured, voices, previewExpiresAt: expiresAt };
  });

  // Reached with `?s=` only (route exempt from the header token, like the font previews): the MAC covers provider and id.
  app.get<{ Params: { provider: string; id: string }; Querystring: { s?: string } }>(`${PREVIEW_BASE}/:provider/:id`, async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (!ctx.signer.verify(path, req.query.s)) return reply.status(403).send({ error: t().errors.fileNotFoundShort });
    const p = parse(previewParams, req.params);
    const url = known.get(p.id);
    if (!url) throw new WorkspaceError(404, t().errors.fileNotFoundShort);
    const out = await asHttp(() => fetchVoicePreview(ctx.http, url, abortOnClose(reply)));
    return reply.header('content-type', 'audio/mpeg').header('cache-control', 'private, max-age=600').header('x-content-type-options', 'nosniff').send(out.bytes);
  });
}
