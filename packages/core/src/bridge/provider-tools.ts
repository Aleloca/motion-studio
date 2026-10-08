import { extname, join } from 'node:path';
import { rm } from 'node:fs/promises';
import { relativeFileSchema, type ServerMessage, type WorkspaceSettings } from '@motion-studio/shared';
import { MCP_TOOLS } from '../agent/launcher.ts';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { isAllowedRule, PermissionsStore } from '../approvals/permissions-store.ts';
import { readConfinedBytes } from '../brand/agent-guard.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { saveGeneratedFile } from '../providers/files.ts';
import { fetchGoogleFont } from '../providers/google-fonts.ts';
import { ProviderError } from '../providers/http.ts';
import { generateImage, normalizeImageSize } from '../providers/openai-images.ts';
import { stockDownload, stockSearch, type StockProvider } from '../providers/stock.ts';
import { elevenlabsSpeech, openaiSpeech } from '../providers/tts.ts';
import type { SecretsVault } from '../secrets/vault.ts';
import type { BridgeContext } from './bridge.ts';
import type { BridgeHandler } from './bridge-routes.ts';

export interface ProviderToolsDeps {
  vault: SecretsVault; approvals: ApprovalBroker; media: MediaTools;
  settings: () => Promise<WorkspaceSettings>; fetch?: typeof fetch; broadcast: (m: ServerMessage) => void;
}

const LABEL = { openai: 'OpenAI', elevenlabs: 'ElevenLabs', pexels: 'Pexels', unsplash: 'Unsplash' } as const;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;
const CANCELLED = 'Il lavoro è stato annullato.';
const s = (v: unknown, max = 4000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const slug = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';

export function providerTools(deps: ProviderToolsDeps): Record<string, BridgeHandler> {
  const baseFetch = deps.fetch ?? globalThis.fetch;
  /** Every request of a job also stops when the job is cancelled. */
  const httpFor = (c: BridgeContext) => ({
    fetch: ((url: string | URL | Request, init: RequestInit = {}) =>
      baseFetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, c.signal]) : c.signal })) as typeof fetch,
  });
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
    const { decision } = await deps.approvals.request({ jobId: c.jobId, projectSlug: c.projectSlug, projectDir: c.projectDir, creativeSlug: c.creativeSlug, kind: 'provider', toolName: rule, input: {}, title, detail });
    if (decision !== 'once' && decision !== 'always') throw new ProviderError(403, "L'utente non ha approvato l'uso del provider");
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
  const reference = async (c: BridgeContext, rel: string) => {
    const bad = () => new ProviderError(400, `Riferimento non valido: ${rel}`);
    if (!relativeFileSchema.safeParse(rel).success || !IMAGE_EXT.has(extname(rel).toLowerCase())) throw bad();
    const read = await readConfinedBytes(c.projectDir, rel, MAX_REFERENCE_BYTES);
    if (!read || 'skipped' in read) throw bad();
    return { name: rel.split('/').pop()!, bytes: read.bytes };
  };

  return {
    generate_image: async (c, a) => {
      allowed(c, 'generate_image');
      const prompt = s(a.prompt, 32_000);
      if (!prompt) throw new ProviderError(400, "Descrivi l'immagine da generare");
      const apiKey = await keyOf('openai');
      const size = normalizeImageSize(Number(a.width), Number(a.height));
      const refs = Array.isArray(a.references) ? await Promise.all(a.references.slice(0, 16).map((r) => reference(c, String(r)))) : [];
      await confirmPaid(c, 'provider:openai-images', "Generare un'immagine con gpt-image-2", `${size.width}×${size.height}${refs.length ? `, ${refs.length} riferimenti` : ''}: ${prompt.slice(0, 300)}`);
      alive(c);
      const img = await generateImage({ ...httpFor(c), apiKey }, { prompt, width: size.width, height: size.height, quality: a.quality as never, background: a.background as never, references: refs });
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
      const requested = a.provider === 'openai' || a.provider === 'elevenlabs' ? a.provider : null;
      const provider = requested ?? ((await deps.vault.get('openai')) ? 'openai' : (await deps.vault.get('elevenlabs')) ? 'elevenlabs' : 'openai');
      const apiKey = await keyOf(provider);
      const format = a.format === 'wav' ? 'wav' : 'mp3';
      await confirmPaid(c, `provider:tts-${provider}`, `Generare una voce con ${LABEL[provider]}`, text.slice(0, 300));
      alive(c);
      const req = { text, voice: s(a.voice, 100) || undefined, instructions: s(a.instructions, 1000) || undefined, format } as const;
      const http = { ...httpFor(c), apiKey };
      const out = provider === 'openai' ? await openaiSpeech(http, req) : await elevenlabsSpeech(http, req);
      alive(c);
      const file = await saveGeneratedFile(c.projectDir, 'audio', `${s(a.name, 60) || slug(text)}.${format}`, out.bytes);
      await register(c, [file], (f) => ({ file: f, origin: 'generated', description: text.slice(0, 2000), tags: ['voce', provider], attribution: `Voce generata con AI (${LABEL[provider]})` }));
      return { file: `assets/${file}`, provider, voice: out.voice };
    },
    stock_search: async (c, a) => {
      allowed(c, 'stock_search');
      const provider = (a.provider === 'unsplash' ? 'unsplash' : 'pexels') as StockProvider;
      const query = s(a.query, 200);
      if (!query) throw new ProviderError(400, 'Indica cosa cercare');
      const results = await stockSearch({ ...httpFor(c), apiKey: await keyOf(provider) }, { provider, query, kind: a.kind === 'video' ? 'video' : 'photo', orientation: a.orientation as never, limit: Number(a.limit) || 10 });
      return { results };
    },
    stock_download: async (c, a) => {
      allowed(c, 'stock_download');
      const provider = (a.provider === 'unsplash' ? 'unsplash' : 'pexels') as StockProvider;
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
