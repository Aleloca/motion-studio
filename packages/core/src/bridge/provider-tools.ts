import { extname, join } from 'node:path';
import { rm } from 'node:fs/promises';
import { brandKitSchema, effectiveServices, PROVIDER_IDS, relativeFileSchema, webUrlSchema, type BriefServices, type KeyCapability, type ProviderId, type ServerMessage, type ServiceKind, type WorkspaceSettings } from '@motion-studio/shared';
import { MCP_TOOLS } from '../agent/launcher.ts';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { confirmPaid as confirmPaidShared } from '../approvals/confirm-paid.ts';
import { MAX_AGENT_BYTES, readConfinedBytes, readConfinedFile } from '../brand/agent-guard.ts';
import { inspectSiteFonts } from '../brand/site-fonts.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { saveGeneratedFile } from '../providers/files.ts';
import { installGoogleFont } from '../providers/google-fonts.ts';
import { elevenlabsMusic, elevenlabsSoundEffect, elevenlabsVoices, MUSIC_MODEL, SFX_MODEL, validateMusic, validateSoundEffect } from '../providers/elevenlabs-audio.ts';
import { ProviderError } from '../providers/http.ts';
import { KEY_PERMISSIONS, KeyCheckCache } from '../providers/key-check.ts';
import { fetchTransport, nodeTransport, type LookupFn, type Transport } from '../providers/safe-fetch.ts';
import { generateImage, normalizeImageSize } from '../providers/openai-images.ts';
import { stockDownload, stockSearch, type StockProvider } from '../providers/stock.ts';
import { elevenlabsSpeech, openaiSpeech } from '../providers/tts.ts';
import type { SecretsVault } from '../secrets/vault.ts';
import { overrideNote, refusalText, resolveService } from '../services/service-policy.ts';
import type { BridgeContext } from './bridge.ts';
import type { BridgeHandler } from './bridge-routes.ts';
import { t } from '../i18n.ts';

export interface ProviderToolsDeps {
  vault: SecretsVault; approvals: ApprovalBroker; media: MediaTools;
  settings: () => Promise<WorkspaceSettings>; fetch?: typeof fetch; broadcast: (m: ServerMessage) => void;
  /** Downloads of provider-supplied URLs; default: over the injected fetch when there is one, else the pinned-DNS node transport. */
  transport?: Transport; lookup?: LookupFn;
  /** What the app has learned about the keys' capabilities (core memory only). */
  keyChecks?: KeyCheckCache;
}

/** Network access of one job: every request (API call or download) also stops when the job is cancelled. */
export function jobHttp(deps: { fetch?: typeof fetch; transport?: Transport; lookup?: LookupFn }, c: { signal: AbortSignal }) {
  const withJob = (init: RequestInit): RequestInit => ({ ...init, signal: init.signal ? AbortSignal.any([init.signal, c.signal]) : c.signal });
  const baseFetch = deps.fetch ?? globalThis.fetch;
  const baseTransport = deps.transport ?? (deps.fetch ? fetchTransport(deps.fetch) : nodeTransport);
  return {
    fetch: ((url: string | URL | Request, init: RequestInit = {}) => baseFetch(url, withJob(init))) as typeof fetch,
    transport: ((url, init, resolve) => baseTransport(url, withJob(init), resolve)) as Transport,
    lookup: deps.lookup,
  };
}

/** inspect_site_fonts calls allowed per job (each may take up to 30 s and a few MB of reads). */
export const SITE_FONTS_CALLS_PER_JOB = 5;

const LABEL = { openai: 'OpenAI', elevenlabs: 'ElevenLabs', pexels: 'Pexels', unsplash: 'Unsplash' } as const;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VOICE = /^[A-Za-z0-9_-]{1,64}$/;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], label: () => string): T | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new ProviderError(400, t().providers.optionInvalid({ label: label() }));
};
const stockProvider = (v: unknown): StockProvider => oneOf(v, ['pexels', 'unsplash'] as const, () => t().providers.optionProvider) ?? 'pexels';
const cancelled = (): string => t().errors.jobCancelled;
const s = (v: unknown, max = 4000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : typeof v === 'number' ? v : Number.NaN);
const slug = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';

export function providerTools(deps: ProviderToolsDeps): Record<string, BridgeHandler> {
  const httpFor = (c: BridgeContext) => jobHttp(deps, c);
  // Per job, keyed by the job's own abort signal (one per run): nothing to clean up when the job ends.
  const siteCalls = new WeakMap<AbortSignal, number>();
  const allowed = (c: BridgeContext, tool: string) => {
    if (!MCP_TOOLS[c.kind].includes(tool)) throw new ProviderError(403, t().errors.toolUnavailable);
  };
  const alive = (c: BridgeContext) => { if (c.signal.aborted) throw new ProviderError(499, cancelled()); };
  const keyOf = async (p: keyof typeof LABEL) => {
    const k = await deps.vault.get(p);
    if (!k) throw new ProviderError(400, t().providers.configureKey({ provider: LABEL[p] }));
    return k;
  };
  const confirmPaid = (c: BridgeContext, rule: string, title: string, detail: string) => confirmPaidShared(deps, c, rule, title, detail);
  /** The providers whose key is in the vault (never the key checks: a key that is set counts, Ruling G). */
  const configured = async () => new Set((await Promise.all(PROVIDER_IDS.map(async (p) => ((await deps.vault.get(p)) ? p : null)))).filter((p): p is ProviderId => p !== null));
  /**
   * The brief's word on this call (Task 7), checked first: a refusal comes before any argument check, confirmation, file
   * read or request. Returns the provider to use (the brief's one wins over `requested`).
   */
  const service = async (c: BridgeContext, kind: ServiceKind, requested?: unknown): Promise<string> => {
    const d = resolveService(c.services, kind, typeof requested === 'string' ? requested : undefined, await configured());
    if (!d.ok) throw new ProviderError(d.reason === 'noKey' ? 400 : 403, refusalText(d, kind, c.services));
    return d.provider;
  };
  const keyChecks = deps.keyChecks ?? new KeyCheckCache();
  /**
   * What a real call says about the key (Task 8): a 401/403 means the key lacks this capability's permission, a success that
   * it has it. Remembered in memory only; the error goes on unchanged.
   */
  const withKeyCheck = async <T>(provider: ProviderId, capability: KeyCapability, run: () => Promise<T>): Promise<T> => {
    let out: T;
    try { out = await run(); }
    catch (e) {
      if (e instanceof ProviderError && (e.upstreamStatus === 401 || e.upstreamStatus === 403)) keyChecks.record(provider, capability, 'missing', KEY_PERMISSIONS[provider][capability]);
      throw e;
    }
    keyChecks.record(provider, capability, 'ok');
    return out;
  };
  /** The sound voice of the project's brand kit, when one is set (unreadable or invalid kits count as none). */
  const brandVoice = async (c: BridgeContext) => {
    try {
      const k = await readConfinedFile(c.projectDir, 'brand/brand-kit.json');
      if (!k || !('text' in k)) return null;
      const parsed = brandKitSchema.safeParse(JSON.parse(k.text));
      const v = parsed.success ? parsed.data.sound?.voice : null;
      return v && VOICE.test(v.id) ? v : null;
    } catch { return null; }
  };
  const removeFiles = (c: BridgeContext, files: string[]) =>
    Promise.all(files.map((f) => rm(join(c.projectDir, 'assets', ...f.split('/')), { force: true }).catch(() => {})));
  const register = async (c: BridgeContext, files: string[], item: (f: string) => Parameters<LibraryStore['registerAssets']>[0][number]) => {
    try {
      alive(c);
      await new LibraryStore(c.projectDir, deps.media).registerAssets(files.map(item));
    } catch (e) {
      await removeFiles(c, files);
      throw e;
    }
    deps.broadcast({ type: 'library', project: c.projectSlug });
  };
  const readReferences = async (c: BridgeContext, raw: unknown) => {
    if (!Array.isArray(raw)) return [];
    const out: Array<{ name: string; bytes: Buffer }> = [];
    let total = 0;
    for (const r of raw.slice(0, 16)) {
      const ref = await reference(c, String(r));
      total += ref.bytes.length;
      if (total > MAX_AGENT_BYTES) throw new ProviderError(400, t().providers.referencesTooLarge);
      out.push(ref);
    }
    return out;
  };
  const reference = async (c: BridgeContext, rel: string) => {
    const bad = () => new ProviderError(400, t().providers.invalidReference({ file: rel }));
    if (!relativeFileSchema.safeParse(rel).success || !IMAGE_EXT.has(extname(rel).toLowerCase())) throw bad();
    const read = await readConfinedBytes(c.projectDir, rel, MAX_AGENT_BYTES);
    if (!read || 'skipped' in read) throw bad();
    return { name: rel.split('/').pop()!, bytes: read.bytes };
  };

  const handlers: Record<string, BridgeHandler> = {
    generate_image: async (c, a) => {
      allowed(c, 'generate_image');
      await service(c, 'images');
      const prompt = s(a.prompt, 32_000);
      if (!prompt) throw new ProviderError(400, t().providers.describeImage);
      const apiKey = await keyOf('openai');
      const size = normalizeImageSize(Number(a.width), Number(a.height));
      const quality = oneOf(a.quality, ['low', 'medium', 'high', 'auto'] as const, () => t().providers.optionQuality);
      const background = oneOf(a.background, ['transparent', 'opaque', 'auto'] as const, () => t().providers.optionBackground);
      const refs = await readReferences(c, a.references);
      await confirmPaid(c, 'provider:openai-images', t().approvals.generateImage, t().approvals.imageDetail({ width: size.width, height: size.height, refs: refs.length, prompt: prompt.slice(0, 300) }));
      alive(c);
      const img = await withKeyCheck('openai', 'images', () => generateImage({ ...httpFor(c), apiKey }, { prompt, width: size.width, height: size.height, quality, background, references: refs }));
      alive(c);
      const file = await saveGeneratedFile(c.projectDir, 'generated', `${s(a.name, 60) || slug(prompt)}.png`, img.bytes);
      await register(c, [file], (f) => ({ file: f, origin: 'generated', description: prompt.slice(0, 2000), tags: ['gpt-image-2'] }));
      const changed = size.width !== Number(a.width) || size.height !== Number(a.height);
      return { file: `assets/${file}`, width: img.width, height: img.height, ...(changed ? { note: t().providers.nearestSize } : {}) };
    },
    tts: async (c, a) => {
      allowed(c, 'tts');
      const chosen = await service(c, 'voice', a.provider);
      const text = s(a.text, 5000);
      if (!text) throw new ProviderError(400, t().providers.writeText);
      const requested = oneOf(a.provider, ['openai', 'elevenlabs'] as const, () => t().providers.optionProvider) ?? null;
      // A provider named by the brief wins over the agent's; the agent's voice then belongs to the other provider and is dropped.
      const forced = effectiveServices(c).voice !== 'auto' ? (chosen as 'openai' | 'elevenlabs') : null;
      const overridden = forced !== null && requested !== null && requested !== forced;
      const voice = overridden ? undefined : s(a.voice, 100) || undefined;
      if (voice !== undefined && !VOICE.test(voice)) throw new ProviderError(400, t().providers.invalidVoice);
      // No voice asked: the brand kit's voice, with its provider when the caller did not pick one and that key is set.
      const brand = voice === undefined ? await brandVoice(c) : null;
      const provider = forced ?? requested ?? (brand && (await deps.vault.get(brand.provider)) ? brand.provider : (await deps.vault.get('openai')) ? 'openai' : (await deps.vault.get('elevenlabs')) ? 'elevenlabs' : 'openai');
      const voiceId = voice ?? (brand && brand.provider === provider ? brand.id : undefined);
      const apiKey = await keyOf(provider);
      const format = a.format === 'wav' ? 'wav' : 'mp3';
      await confirmPaid(c, `provider:tts-${provider}`, t().approvals.generateVoice({ provider: LABEL[provider] }), text.slice(0, 300));
      alive(c);
      const req = { text, voice: voiceId, instructions: s(a.instructions, 1000) || undefined, format } as const;
      const http = { ...httpFor(c), apiKey };
      const out = await withKeyCheck(provider, 'tts', () => (provider === 'openai' ? openaiSpeech(http, req) : elevenlabsSpeech(http, req)));
      alive(c);
      const file = await saveGeneratedFile(c.projectDir, 'audio', `${s(a.name, 60) || slug(text)}.${format}`, out.bytes);
      await register(c, [file], (f) => ({ file: f, origin: 'generated', description: text.slice(0, 2000), tags: [t().providers.voiceTag, provider], attribution: t().providers.voiceAttribution({ provider: LABEL[provider] }) }));
      return { file: `assets/${file}`, provider, voice: out.voice, ...(overridden ? { note: overrideNote('voice', requested!, provider) } : {}) };
    },
    sound_effect: async (c, a) => {
      allowed(c, 'sound_effect');
      await service(c, 'sfx');
      const req = { prompt: s(a.prompt, 5000), durationSec: num(a.durationSec), loop: typeof a.loop === 'boolean' ? a.loop : undefined, promptInfluence: num(a.promptInfluence) };
      const prompt = validateSoundEffect(req);
      const apiKey = await keyOf('elevenlabs');
      await confirmPaid(c, 'provider:sfx-elevenlabs', t().approvals.generateSfx({ provider: LABEL.elevenlabs }), t().approvals.audioDetail({ provider: LABEL.elevenlabs, seconds: req.durationSec ?? null, prompt: prompt.slice(0, 300) }));
      alive(c);
      const out = await withKeyCheck('elevenlabs', 'sfx', () => elevenlabsSoundEffect({ ...httpFor(c), apiKey }, { ...req, prompt }));
      alive(c);
      const file = await saveGeneratedFile(c.projectDir, 'audio', `${s(a.name, 60) || slug(prompt)}.mp3`, Buffer.from(out.bytes));
      await register(c, [file], (f) => ({ file: f, origin: 'generated', description: prompt, tags: [t().providers.soundTag, 'elevenlabs'], attribution: t().providers.audioAttribution({ provider: LABEL.elevenlabs }), provider: 'elevenlabs', model: SFX_MODEL, ...(req.loop !== undefined ? { loop: req.loop } : {}) }));
      return { file: `assets/${file}`, provider: 'elevenlabs' };
    },
    music: async (c, a) => {
      allowed(c, 'music');
      await service(c, 'music');
      const req = { prompt: s(a.prompt, 5000), durationSec: num(a.durationSec) ?? Number.NaN, instrumental: typeof a.instrumental === 'boolean' ? a.instrumental : undefined };
      const prompt = validateMusic(req);
      const apiKey = await keyOf('elevenlabs');
      await confirmPaid(c, 'provider:music-elevenlabs', t().approvals.generateMusic({ provider: LABEL.elevenlabs }), t().approvals.audioDetail({ provider: LABEL.elevenlabs, seconds: req.durationSec, prompt: prompt.slice(0, 300) }));
      alive(c);
      const out = await withKeyCheck('elevenlabs', 'music', () => elevenlabsMusic({ ...httpFor(c), apiKey }, { ...req, prompt }));
      alive(c);
      const file = await saveGeneratedFile(c.projectDir, 'audio', `${s(a.name, 60) || slug(prompt)}.mp3`, Buffer.from(out.bytes));
      await register(c, [file], (f) => ({ file: f, origin: 'generated', description: prompt, tags: [t().providers.musicTag, 'elevenlabs'], attribution: t().providers.audioAttribution({ provider: LABEL.elevenlabs }), provider: 'elevenlabs', model: MUSIC_MODEL }));
      return { file: `assets/${file}`, provider: 'elevenlabs' };
    },
    list_voices: async (c, a) => {
      allowed(c, 'list_voices');
      // ElevenLabs voices are of use only when the brief's voice can be ElevenLabs (auto or ElevenLabs).
      if (effectiveServices(c).voice === 'openai') throw new ProviderError(403, t().providers.serviceVoicesUnused);
      await service(c, 'voice', 'elevenlabs');
      const apiKey = await keyOf('elevenlabs');
      const voices = await withKeyCheck('elevenlabs', 'voices', () => elevenlabsVoices({ ...httpFor(c), apiKey }, { search: s(a.search, 100) || undefined, pageSize: num(a.limit) }));
      alive(c);
      return { voices };
    },
    stock_search: async (c, a) => {
      allowed(c, 'stock_search');
      await service(c, 'images', 'stock');
      const provider = stockProvider(a.provider);
      const query = s(a.query, 200);
      if (!query) throw new ProviderError(400, t().providers.searchWhat);
      const orientation = oneOf(a.orientation, ['landscape', 'portrait', 'square'] as const, () => t().providers.optionOrientation);
      const apiKey = await keyOf(provider);
      const results = await withKeyCheck(provider, 'search', () => stockSearch({ ...httpFor(c), apiKey }, { provider, query, kind: a.kind === 'video' ? 'video' : 'photo', orientation, limit: Number(a.limit) || 10 }));
      return { results };
    },
    stock_download: async (c, a) => {
      allowed(c, 'stock_download');
      await service(c, 'images', 'stock');
      const provider = stockProvider(a.provider);
      const id = s(a.id, 64);
      const apiKey = await keyOf(provider);
      const d = await withKeyCheck(provider, 'search', () => stockDownload({ ...httpFor(c), apiKey }, { provider, id, kind: a.kind === 'video' ? 'video' : 'photo' }));
      alive(c);
      const file = await saveGeneratedFile(c.projectDir, 'stock', `${provider}-${id}.${d.ext}`, d.bytes);
      await register(c, [file], (f) => ({ file: f, origin: 'stock', sourceUrl: d.sourceUrl, description: d.attribution, tags: ['stock', provider], attribution: d.attribution }));
      return { file: `assets/${file}`, attribution: d.attribution };
    },
    fonts_fetch: async (c, a) => {
      allowed(c, 'fonts_fetch');
      const family = s(a.family, 60);
      const weights = Array.isArray(a.weights) ? a.weights.map(Number) : [];
      const { files } = await installGoogleFont({ http: httpFor(c), projectDir: c.projectDir, media: deps.media, family, weights, italic: a.italic === true, alive: () => alive(c) });
      deps.broadcast({ type: 'library', project: c.projectSlug });
      return { files: files.map((f) => `assets/${f}`), license: t().providers.fontsLicense };
    },
    // Brand analysis only: the core reads the site's HTML and CSS (safeFetch, caps, deadline) and lists its fonts.
    inspect_site_fonts: async (c, a) => {
      allowed(c, 'inspect_site_fonts');
      const url = a.url;
      if (typeof url !== 'string' || url.length > 2000 || !webUrlSchema.safeParse(url).success) throw new ProviderError(400, t().providers.invalidUrl);
      const used = siteCalls.get(c.signal) ?? 0;
      if (used >= SITE_FONTS_CALLS_PER_JOB) throw new ProviderError(429, t().providers.siteFontsLimit({ max: SITE_FONTS_CALLS_PER_JOB }));
      siteCalls.set(c.signal, used + 1);
      const { transport, lookup } = httpFor(c);
      const out = await inspectSiteFonts({ fetch: { transport, lookup }, signal: c.signal, ...(c.locale ? { locale: c.locale } : {}) }, url);
      alive(c);
      if (out.warnings.length) c.addNotes?.(out.warnings);
      return out;
    },
  };
  // Once the job is cancelled, whatever failed is reported as the cancellation.
  return Object.fromEntries(Object.entries(handlers).map(([name, h]) => [name, (async (c, a) => {
    try { return await h(c, a); }
    catch (e) {
      if (c.signal.aborted) throw new ProviderError(499, cancelled());
      throw e;
    }
  }) as BridgeHandler]));
}

/** Agent-facing lines (English): which Motion Studio tools can be used this turn, and which the brief's services turn off. */
export async function availableTools(vault: SecretsVault, services?: BriefServices): Promise<string[]> {
  const has = async (p: keyof typeof LABEL) => Boolean(await vault.get(p));
  const st = (ok: boolean, missing: string) => (ok ? '(ready)' : `(not configured: ${missing})`);
  const s = effectiveServices({ services });
  const off = (isOff: boolean, status: string, why = '') => (isOff ? `(off for this creative${why})` : status);
  const [openai, eleven, pexels, unsplash] = await Promise.all([has('openai'), has('elevenlabs'), has('pexels'), has('unsplash')]);
  return [
    `- generate_image: images with gpt-image-2 ${s.images === 'stock' ? off(true, '', ': stock images only') : off(s.images === 'none', st(openai, 'the OpenAI key is missing'))}`,
    `- tts: voice-over with OpenAI or ElevenLabs ${off(s.voice === 'none', st(openai || eleven, 'no TTS key'))}`,
    `- sound_effect: sound effects with ElevenLabs ${off(s.sfx === 'none', st(eleven, 'the ElevenLabs key is missing'))}`,
    `- music: music tracks with ElevenLabs ${off(s.music === 'none', st(eleven, 'the ElevenLabs key is missing'))}`,
    `- list_voices: ElevenLabs voices of the account (free) ${off(s.voice === 'none' || s.voice === 'openai', st(eleven, 'the ElevenLabs key is missing'))}`,
    `- stock_search / stock_download: photos and videos from Pexels and Unsplash ${off(s.images === 'none', st(pexels || unsplash, 'no Pexels or Unsplash key'))}`,
    '- fonts_fetch: Google Fonts fonts (ready)',
    '- report_progress, validate_composition, preview_frames, read_brand_kit (ready)',
  ];
}
