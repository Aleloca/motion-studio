import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerMessage } from '@motion-studio/shared';
import { z } from 'zod';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { confirmPaid } from '../approvals/confirm-paid.ts';
import { jobHttp } from '../bridge/provider-tools.ts';
import { JobConflictError, type JobQueue } from '../jobs/job-queue.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { elevenlabsMusic, elevenlabsSoundEffect, MUSIC_MODEL, SFX_MODEL, validateMusic, validateSoundEffect } from '../providers/elevenlabs-audio.ts';
import { saveGeneratedFile } from '../providers/files.ts';
import { ProviderError, type HttpDeps } from '../providers/http.ts';
import type { KeyCheckCache } from '../providers/key-check.ts';
import { generateImage, normalizeImageSize } from '../providers/openai-images.ts';
import { elevenlabsSpeech, openaiSpeech } from '../providers/tts.ts';
import type { SecretsVault } from '../secrets/vault.ts';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { t } from '../i18n.ts';

export interface GenerateRoutesContext {
  requireWorkspace: () => WorkspaceStore; vault: SecretsVault; approvals: ApprovalBroker; media: MediaTools; queue: JobQueue;
  keyChecks: KeyCheckCache; http: Pick<HttpDeps, 'fetch' | 'transport' | 'lookup' | 'timeoutMs'>; broadcast: (m: ServerMessage) => void;
}

const LABEL = { openai: 'OpenAI', elevenlabs: 'ElevenLabs' } as const;
type Provider = keyof typeof LABEL;
const VOICE = /^[A-Za-z0-9_-]{1,64}$/;
const name = z.string().trim().max(60).optional();
const num = z.number().finite();

const opt = <T extends z.ZodRawShape>(shape: T) => z.preprocess((v) => v ?? {}, z.object(shape).strict());
const body = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), provider: z.literal('openai'), prompt: z.string().max(32_000), options: opt({
    width: num.default(1024), height: num.default(1024), quality: z.enum(['low', 'medium', 'high', 'auto']).optional(), background: z.enum(['transparent', 'opaque', 'auto']).optional(), name }) }).strict(),
  z.object({ kind: z.literal('voice'), provider: z.enum(['openai', 'elevenlabs']), text: z.string().max(5000), options: opt({
    voice: z.string().regex(VOICE).optional(), instructions: z.string().max(1000).optional(), format: z.enum(['mp3', 'wav']).default('mp3'), name }) }).strict(),
  z.object({ kind: z.literal('sfx'), provider: z.literal('elevenlabs'), prompt: z.string().max(5000), options: opt({
    durationSec: num.optional(), loop: z.boolean().optional(), promptInfluence: num.optional(), name }) }).strict(),
  z.object({ kind: z.literal('music'), provider: z.literal('elevenlabs'), prompt: z.string().max(5000), options: opt({
    durationSec: num, instrumental: z.boolean().optional(), name }) }).strict(),
]);
type Body = z.infer<typeof body>;

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';
const asWorkspaceError = (e: unknown): never => {
  if (e instanceof ProviderError) throw new WorkspaceError(e.status === 400 || e.status === 429 ? e.status : 503, e.message);
  throw e;
};

/**
 * POST /api/projects/:slug/generate: a direct user action (no agent, and brief.services does not apply). The request is
 * validated and the key checked at once; the paid call then runs as a core job (`asset-generation`) that asks the same
 * confirmation as the agent tools, can be cancelled, and registers its result in the library.
 */
export function registerGenerateRoutes(app: FastifyInstance, ctx: GenerateRoutesContext) {
  const keyChecks = ctx.keyChecks;
  const jobLabel = (b: Body) => t().jobs.assetGenerationLabel({ kind: b.kind === 'image' ? t().providers.imageTag : b.kind === 'voice' ? t().providers.voiceTag : b.kind === 'sfx' ? t().providers.soundTag : t().providers.musicTag });

  /** Limit checks of the provider functions, run before anything is queued, asked or sent. */
  const validate = (b: Body) => {
    try {
      if (b.kind === 'image') {
        const prompt = b.prompt.trim();
        if (!prompt) throw new ProviderError(400, t().providers.describeImage);
        return { prompt, size: normalizeImageSize(b.options.width, b.options.height) };
      }
      if (b.kind === 'voice') {
        const text = b.text.trim();
        if (!text) throw new ProviderError(400, t().providers.writeText);
        return { prompt: text, size: null };
      }
      if (b.kind === 'sfx') return { prompt: validateSoundEffect({ prompt: b.prompt, ...b.options }), size: null };
      return { prompt: validateMusic({ prompt: b.prompt, durationSec: b.options.durationSec, instrumental: b.options.instrumental }), size: null };
    } catch (e) { return asWorkspaceError(e); }
  };

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/generate', async (req, reply) => {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) throw new WorkspaceError(400, t().errors.invalidRequest);
    const b = parsed.data;
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    const projectDir = ws.projectDir(req.params.slug);
    const checked = validate(b);
    const apiKey = await ctx.vault.get(b.provider);
    if (!apiKey) throw new WorkspaceError(400, t().providers.configureKey({ provider: LABEL[b.provider] }));
    const projectSlug = req.params.slug;

    try {
      const job = ctx.queue.enqueue({
        key: `generate:${randomUUID()}:${projectSlug}`, kind: 'asset-generation', label: jobLabel(b), lane: 'generate',
        run: (signal, jobId) => run({ b, checked, apiKey, projectSlug, projectDir, signal, jobId }),
      });
      return reply.status(202).send({ jobId: job.id });
    } catch (e) {
      if (e instanceof JobConflictError) throw new WorkspaceError(409, e.message);
      throw e;
    }
  });

  interface Run { b: Body; checked: { prompt: string; size: { width: number; height: number } | null }; apiKey: string; projectSlug: string; projectDir: string; signal: AbortSignal; jobId: string }

  async function run(r: Run): Promise<void | 'cancelled'> {
    const { b, checked, apiKey, projectSlug, projectDir, signal } = r;
    const alive = () => { if (signal.aborted) throw new ProviderError(499, t().errors.jobCancelled); };
    const paid = (rule: string, title: string, detail: string) => confirmPaid({ approvals: ctx.approvals, settings: () => ctx.requireWorkspace().readSettings() }, { jobId: r.jobId, projectSlug, projectDir, creativeSlug: null, signal }, rule, title, detail);
    const http = { ...jobHttp(ctx.http, { signal }), ...(ctx.http.timeoutMs ? { timeoutMs: ctx.http.timeoutMs } : {}), apiKey };
    /** A 401/403 from the provider means the key lacks this capability: remembered in memory, then the error goes on. */
    const checkedCall = async <T>(provider: Provider, capability: string, permission: string, call: () => Promise<T>): Promise<T> => {
      try { const out = await call(); keyChecks.record(provider, capability, 'ok'); return out; }
      catch (e) {
        if (e instanceof ProviderError && (e.upstreamStatus === 401 || e.upstreamStatus === 403)) keyChecks.record(provider, capability, 'missing', permission);
        throw e;
      }
    };
    const fileName = (ext: string) => `${b.options.name || slug(checked.prompt)}.${ext}`;
    const store = async (dir: 'generated' | 'audio', ext: string, bytes: Uint8Array, item: (f: string) => Parameters<LibraryStore['registerAssets']>[0][number]) => {
      alive();
      const file = await saveGeneratedFile(projectDir, dir, fileName(ext), Buffer.from(bytes));
      try {
        alive();
        await new LibraryStore(projectDir, ctx.media).registerAssets([item(file)]);
      } catch (e) {
        await rm(join(projectDir, 'assets', ...file.split('/')), { force: true }).catch(() => {});
        throw e;
      }
      ctx.broadcast({ type: 'library', project: projectSlug });
    };
    const attribution = (p: Provider) => t().providers.audioAttribution({ provider: LABEL[p] });

    try {
      if (b.kind === 'image') {
        const size = checked.size!;
        await paid('provider:openai-images', t().approvals.generateImage, t().approvals.imageDetail({ width: size.width, height: size.height, refs: 0, prompt: checked.prompt.slice(0, 300) }));
        alive();
        const img = await checkedCall('openai', 'images', 'images_write', () => generateImage(http, { prompt: checked.prompt, width: size.width, height: size.height, quality: b.options.quality, background: b.options.background }));
        await store('generated', 'png', img.bytes, (f) => ({ file: f, origin: 'generated', description: checked.prompt.slice(0, 2000), tags: ['gpt-image-2'], provider: 'openai', model: 'gpt-image-2' }));
      } else if (b.kind === 'voice') {
        const text = checked.prompt;
        await paid(`provider:tts-${b.provider}`, t().approvals.generateVoice({ provider: LABEL[b.provider] }), text.slice(0, 300));
        alive();
        const speech = { text, voice: b.options.voice, instructions: b.options.instructions || undefined, format: b.options.format } as const;
        const out = b.provider === 'openai'
          ? await checkedCall('openai', 'tts', 'audio_speech', () => openaiSpeech(http, speech))
          : await checkedCall('elevenlabs', 'tts', 'text_to_speech', () => elevenlabsSpeech(http, speech));
        const model = b.provider === 'openai' ? 'gpt-4o-mini-tts' : 'eleven_multilingual_v2';
        await store('audio', b.options.format, out.bytes, (f) => ({ file: f, origin: 'generated', description: text.slice(0, 2000), tags: [t().providers.voiceTag, b.provider], attribution: t().providers.voiceAttribution({ provider: LABEL[b.provider] }), provider: b.provider, model }));
      } else if (b.kind === 'sfx') {
        await paid('provider:sfx-elevenlabs', t().approvals.generateSfx({ provider: LABEL.elevenlabs }), t().approvals.audioDetail({ provider: LABEL.elevenlabs, seconds: b.options.durationSec ?? null, prompt: checked.prompt.slice(0, 300) }));
        alive();
        const { name: _n, ...o } = b.options;
        const out = await checkedCall('elevenlabs', 'sfx', 'sound_generation', () => elevenlabsSoundEffect(http, { ...o, prompt: checked.prompt }));
        await store('audio', 'mp3', out.bytes, (f) => ({ file: f, origin: 'generated', description: checked.prompt, tags: [t().providers.soundTag, 'elevenlabs'], attribution: attribution('elevenlabs'), provider: 'elevenlabs', model: SFX_MODEL, ...(b.options.loop !== undefined ? { loop: b.options.loop } : {}) }));
      } else {
        await paid('provider:music-elevenlabs', t().approvals.generateMusic({ provider: LABEL.elevenlabs }), t().approvals.audioDetail({ provider: LABEL.elevenlabs, seconds: b.options.durationSec, prompt: checked.prompt.slice(0, 300) }));
        alive();
        const out = await checkedCall('elevenlabs', 'music', 'music_generation', () => elevenlabsMusic(http, { prompt: checked.prompt, durationSec: b.options.durationSec, instrumental: b.options.instrumental }));
        await store('audio', 'mp3', out.bytes, (f) => ({ file: f, origin: 'generated', description: checked.prompt, tags: [t().providers.musicTag, 'elevenlabs'], attribution: attribution('elevenlabs'), provider: 'elevenlabs', model: MUSIC_MODEL }));
      }
    } catch (e) {
      // Once the job is cancelled, whatever failed is reported as the cancellation.
      if (signal.aborted) return 'cancelled';
      throw e;
    }
  }
}

