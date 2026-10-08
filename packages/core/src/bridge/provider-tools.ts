import { extname, join } from 'node:path';
import { rm } from 'node:fs/promises';
import { relativeFileSchema, type ServerMessage, type WorkspaceSettings } from '@motion-studio/shared';
import { MCP_TOOLS } from '../agent/launcher.ts';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { isAllowedRule, PermissionsStore } from '../approvals/permissions-store.ts';
import { MAX_AGENT_BYTES, readConfinedBytes } from '../brand/agent-guard.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { saveGeneratedFile } from '../providers/files.ts';
import { fetchGoogleFont } from '../providers/google-fonts.ts';
import { ProviderError } from '../providers/http.ts';
import { fetchTransport, nodeTransport, type LookupFn, type Transport } from '../providers/safe-fetch.ts';
import { generateImage, normalizeImageSize } from '../providers/openai-images.ts';
import { stockDownload, stockSearch, type StockProvider } from '../providers/stock.ts';
import { elevenlabsSpeech, openaiSpeech } from '../providers/tts.ts';
import type { SecretsVault } from '../secrets/vault.ts';
import type { BridgeContext } from './bridge.ts';
import type { BridgeHandler } from './bridge-routes.ts';
import { t } from '../i18n.ts';

export interface ProviderToolsDeps {
  vault: SecretsVault; approvals: ApprovalBroker; media: MediaTools;
  settings: () => Promise<WorkspaceSettings>; fetch?: typeof fetch; broadcast: (m: ServerMessage) => void;
  /** Downloads of provider-supplied URLs; default: over the injected fetch when there is one, else the pinned-DNS node transport. */
  transport?: Transport; lookup?: LookupFn;
}

/** Network access of one job: every request (API call or download) also stops when the job is cancelled. */
export function jobHttp(deps: { fetch?: typeof fetch; transport?: Transport; lookup?: LookupFn }, c: BridgeContext) {
  const withJob = (init: RequestInit): RequestInit => ({ ...init, signal: init.signal ? AbortSignal.any([init.signal, c.signal]) : c.signal });
  const baseFetch = deps.fetch ?? globalThis.fetch;
  const baseTransport = deps.transport ?? (deps.fetch ? fetchTransport(deps.fetch) : nodeTransport);
  return {
    fetch: ((url: string | URL | Request, init: RequestInit = {}) => baseFetch(url, withJob(init))) as typeof fetch,
    transport: ((url, init, resolve) => baseTransport(url, withJob(init), resolve)) as Transport,
    lookup: deps.lookup,
  };
}

const LABEL = { openai: 'OpenAI', elevenlabs: 'ElevenLabs', pexels: 'Pexels', unsplash: 'Unsplash' } as const;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VOICE = /^[A-Za-z0-9_-]{1,64}$/;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], label: string): T | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new ProviderError(400, `${label} non valido`);
};
const stockProvider = (v: unknown): StockProvider => oneOf(v, ['pexels', 'unsplash'] as const, 'Provider') ?? 'pexels';
const CANCELLED = 'Il lavoro è stato annullato.';
const s = (v: unknown, max = 4000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const slug = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';

export function providerTools(deps: ProviderToolsDeps): Record<string, BridgeHandler> {
  const httpFor = (c: BridgeContext) => jobHttp(deps, c);
  const allowed = (c: BridgeContext, tool: string) => {
    if (!MCP_TOOLS[c.kind].includes(tool)) throw new ProviderError(403, 'Strumento non disponibile in questo lavoro');
  };
  const alive = (c: BridgeContext) => { if (c.signal.aborted) throw new ProviderError(499, CANCELLED); };
  const keyOf = async (p: keyof typeof LABEL) => {
    const k = await deps.vault.get(p);
    if (!k) throw new ProviderError(400, `Configura la chiave ${LABEL[p]} nelle Impostazioni di Motion Studio`);
    return k;
  };
  const confirmPaid = async (c: BridgeContext, rule: string, title: string, detail: string) => {
    if (!(await deps.settings()).confirmPaidProviders) return;
    // A stored rule counts only when it is one "Sempre" could have produced; an unreadable store means ask.
    if (isAllowedRule(rule) && await new PermissionsStore(c.projectDir).has(rule).catch(() => false)) return;
    // No await between the check and the request: a cancelled job must never leave a prompt behind.
    alive(c);
    const pending = deps.approvals.request({ jobId: c.jobId, projectSlug: c.projectSlug, projectDir: c.projectDir, creativeSlug: c.creativeSlug, kind: 'provider', toolName: rule, input: {}, title, detail });
    const onAbort = () => deps.approvals.cancelJob(c.jobId);
    c.signal.addEventListener('abort', onAbort, { once: true });
    let decision: Awaited<typeof pending>['decision'];
    try { ({ decision } = await pending); } finally { c.signal.removeEventListener('abort', onAbort); }
    alive(c);
    if (decision !== 'once' && decision !== 'always') throw new ProviderError(403, t().approvals.providerNotApproved);
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
      if (total > MAX_AGENT_BYTES) throw new ProviderError(400, 'Riferimenti troppo grandi');
      out.push(ref);
    }
    return out;
  };
  const reference = async (c: BridgeContext, rel: string) => {
    const bad = () => new ProviderError(400, `Riferimento non valido: ${rel}`);
    if (!relativeFileSchema.safeParse(rel).success || !IMAGE_EXT.has(extname(rel).toLowerCase())) throw bad();
    const read = await readConfinedBytes(c.projectDir, rel, MAX_AGENT_BYTES);
    if (!read || 'skipped' in read) throw bad();
    return { name: rel.split('/').pop()!, bytes: read.bytes };
  };

  const handlers: Record<string, BridgeHandler> = {
    generate_image: async (c, a) => {
      allowed(c, 'generate_image');
      const prompt = s(a.prompt, 32_000);
      if (!prompt) throw new ProviderError(400, "Descrivi l'immagine da generare");
      const apiKey = await keyOf('openai');
      const size = normalizeImageSize(Number(a.width), Number(a.height));
      const quality = oneOf(a.quality, ['low', 'medium', 'high', 'auto'] as const, 'Qualità');
      const background = oneOf(a.background, ['transparent', 'opaque', 'auto'] as const, 'Sfondo');
      const refs = await readReferences(c, a.references);
      await confirmPaid(c, 'provider:openai-images', t().approvals.generateImage, t().approvals.imageDetail({ width: size.width, height: size.height, refs: refs.length, prompt: prompt.slice(0, 300) }));
      alive(c);
      const img = await generateImage({ ...httpFor(c), apiKey }, { prompt, width: size.width, height: size.height, quality, background, references: refs });
      alive(c);
      const file = await saveGeneratedFile(c.projectDir, 'generated', `${s(a.name, 60) || slug(prompt)}.png`, img.bytes);
      await register(c, [file], (f) => ({ file: f, origin: 'generated', description: prompt.slice(0, 2000), tags: ['gpt-image-2'] }));
      const changed = size.width !== Number(a.width) || size.height !== Number(a.height);
      return { file: `assets/${file}`, width: img.width, height: img.height, ...(changed ? { note: "Dimensione supportata più vicina: ridimensiona o ritaglia l'immagine se serve" } : {}) };
    },
    tts: async (c, a) => {
      allowed(c, 'tts');
      const text = s(a.text, 5000);
      if (!text) throw new ProviderError(400, 'Scrivi il testo da leggere');
      const requested = oneOf(a.provider, ['openai', 'elevenlabs'] as const, 'Provider') ?? null;
      const voice = s(a.voice, 100) || undefined;
      if (voice !== undefined && !VOICE.test(voice)) throw new ProviderError(400, 'Voce non valida');
      const provider = requested ?? ((await deps.vault.get('openai')) ? 'openai' : (await deps.vault.get('elevenlabs')) ? 'elevenlabs' : 'openai');
      const apiKey = await keyOf(provider);
      const format = a.format === 'wav' ? 'wav' : 'mp3';
      await confirmPaid(c, `provider:tts-${provider}`, t().approvals.generateVoice({ provider: LABEL[provider] }), text.slice(0, 300));
      alive(c);
      const req = { text, voice, instructions: s(a.instructions, 1000) || undefined, format } as const;
      const http = { ...httpFor(c), apiKey };
      const out = provider === 'openai' ? await openaiSpeech(http, req) : await elevenlabsSpeech(http, req);
      alive(c);
      const file = await saveGeneratedFile(c.projectDir, 'audio', `${s(a.name, 60) || slug(text)}.${format}`, out.bytes);
      await register(c, [file], (f) => ({ file: f, origin: 'generated', description: text.slice(0, 2000), tags: ['voce', provider], attribution: `Voce generata con AI (${LABEL[provider]})` }));
      return { file: `assets/${file}`, provider, voice: out.voice };
    },
    stock_search: async (c, a) => {
      allowed(c, 'stock_search');
      const provider = stockProvider(a.provider);
      const query = s(a.query, 200);
      if (!query) throw new ProviderError(400, 'Indica cosa cercare');
      const orientation = oneOf(a.orientation, ['landscape', 'portrait', 'square'] as const, 'Orientamento');
      const results = await stockSearch({ ...httpFor(c), apiKey: await keyOf(provider) }, { provider, query, kind: a.kind === 'video' ? 'video' : 'photo', orientation, limit: Number(a.limit) || 10 });
      return { results };
    },
    stock_download: async (c, a) => {
      allowed(c, 'stock_download');
      const provider = stockProvider(a.provider);
      const id = s(a.id, 64);
      const d = await stockDownload({ ...httpFor(c), apiKey: await keyOf(provider) }, { provider, id, kind: a.kind === 'video' ? 'video' : 'photo' });
      alive(c);
      const file = await saveGeneratedFile(c.projectDir, 'stock', `${provider}-${id}.${d.ext}`, d.bytes);
      await register(c, [file], (f) => ({ file: f, origin: 'stock', sourceUrl: d.sourceUrl, description: d.attribution, tags: ['stock', provider], attribution: d.attribution }));
      return { file: `assets/${file}`, attribution: d.attribution };
    },
    fonts_fetch: async (c, a) => {
      allowed(c, 'fonts_fetch');
      const family = s(a.family, 60);
      const weights = Array.isArray(a.weights) ? a.weights.map(Number) : [];
      const fonts = await fetchGoogleFont(httpFor(c), { family, weights, italic: a.italic === true });
      alive(c);
      const files: string[] = [];
      try {
        for (const f of fonts) files.push(await saveGeneratedFile(c.projectDir, 'fonts', `${family.replace(/ /g, '')}-${f.weight}${f.italic ? '-italic' : ''}.${f.ext}`, f.bytes));
      } catch (e) {
        await removeFiles(c, files);
        throw e;
      }
      await register(c, files, (f) => ({ file: f, origin: 'website', sourceUrl: `https://fonts.google.com/specimen/${family.replace(/ /g, '+')}`, description: `Font ${family}`, tags: ['font', family] }));
      return { files: files.map((f) => `assets/${f}`), license: 'Google Fonts: licenza OFL o Apache 2.0, uso commerciale consentito' };
    },
  };
  // Once the job is cancelled, whatever failed is reported as the cancellation.
  return Object.fromEntries(Object.entries(handlers).map(([name, h]) => [name, (async (c, a) => {
    try { return await h(c, a); }
    catch (e) {
      if (c.signal.aborted) throw new ProviderError(499, CANCELLED);
      throw e;
    }
  }) as BridgeHandler]));
}

export async function availableTools(vault: SecretsVault): Promise<string[]> {
  const has = async (p: keyof typeof LABEL) => Boolean(await vault.get(p));
  const st = (ok: boolean, missing: string) => (ok ? '(pronto)' : `(non configurato: ${missing})`);
  const [openai, eleven, pexels, unsplash] = await Promise.all([has('openai'), has('elevenlabs'), has('pexels'), has('unsplash')]);
  return [
    `- generate_image: immagini con gpt-image-2 ${st(openai, 'la chiave OpenAI manca')}`,
    `- tts: voce fuori campo con OpenAI o ElevenLabs ${st(openai || eleven, 'nessuna chiave TTS')}`,
    `- stock_search / stock_download: foto e video da Pexels e Unsplash ${st(pexels || unsplash, 'nessuna chiave Pexels o Unsplash')}`,
    '- fonts_fetch: font di Google Fonts (pronto)',
    '- report_progress, validate_output, read_brand_kit (pronti)',
  ];
}
