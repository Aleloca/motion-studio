// @vitest-environment node
/**
 * Batch voice generation of a localize turn (Phase 12, Task 4, spec §3.2, Review Focus 4): the core, never the agent, makes
 * the translated voices with the brief's voice service (`resolveService`, F5), after ONE `paid-batch` confirmation for the
 * whole batch ("Always" for tts honoured), sequentially, with the brand voice, into `assets/audio/`. Fake fetch and
 * MemoryVault only: no request ever leaves the machine (the phase 11 network guard stays on).
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { messages, workspaceSettingsSchema, type ApprovalRequest, type BriefServices, type JobSummary, type Localization } from '@motion-studio/shared';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { currentLocale } from '../src/i18n.ts';
import { H, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { PermissionsStore } from '../src/approvals/permissions-store.ts';
import { voiceBatch, type VoiceBatchItem } from '../src/bridge/provider-tools.ts';
import { LibraryStore } from '../src/library/library-store.ts';
import { NoMediaTools, type MediaTools } from '../src/media/media-tools.ts';
import { KeyCheckCache } from '../src/providers/key-check.ts';
import { MemoryVault } from '../src/secrets/vault.ts';

let projectDir: string;
let approvals: ApprovalBroker;
let sent: Array<{ url: string; body: string }>;
let controller: AbortController;

const fakeFetch = (async (url: string, init: RequestInit = {}) => {
  sent.push({ url, body: typeof init.body === 'string' ? init.body : '' });
  if (url.startsWith('https://api.openai.com/v1/audio/speech')) {
    const input = (JSON.parse(String(init.body)) as { input: string }).input;
    return new Response(new TextEncoder().encode(`tts:${input}`), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }
  if (url.startsWith('https://api.elevenlabs.io/v2/voices')) return new Response(JSON.stringify({ voices: [{ voice_id: 'acct1' }] }), { status: 200 });
  if (url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/')) return new Response(new Uint8Array([8, 8]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  return new Response('not found', { status: 404 });
}) as unknown as typeof fetch;

const items: VoiceBatchItem[] = [
  { key: 'de|wide|vo', label: 'German · Wide · Voice', text: 'Willkommen bei Acme', name: 'acme-de-vo' },
  { key: 'de|wide|vo3', label: 'German · Wide · Outro', text: 'Jetzt laden', name: 'acme-de-vo3' },
  { key: 'fr|wide|vo', label: 'French · Wide · Voice', text: 'Bienvenue chez Acme', name: 'acme-fr-vo' },
  { key: 'fr|wide|vo3', label: 'French · Wide · Outro', text: 'Téléchargez', name: 'acme-fr-vo3' },
];

const batch = (o: { settings?: object; env?: Record<string, string>; keyChecks?: KeyCheckCache } = {}) => voiceBatch({
  vault: new MemoryVault(o.env ?? { OPENAI_API_KEY: 'sk-test-0123456789' }), approvals, media: NoMediaTools, fetch: fakeFetch,
  lookup: async () => [{ address: '93.184.216.34', family: 4 as const }], broadcast: () => {},
  settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1, ...o.settings }),
  ...(o.keyChecks ? { keyChecks: o.keyChecks } : {}),
});
const ctx = (services?: BriefServices) => ({ jobId: 'j1', projectSlug: 'acme', projectDir, creativeSlug: 'launch', signal: controller.signal, ...(services ? { services } : {}) });
const speechCalls = () => sent.filter((s) => s.url.includes('/audio/speech') || s.url.includes('/text-to-speech/'));

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ms-voice-batch-'));
  approvals = new ApprovalBroker({ broadcast: () => {} });
  sent = [];
  controller = new AbortController();
});
afterEach(async () => { await rm(projectDir, { recursive: true, force: true }); });

describe('voiceBatch', { timeout: 30_000 }, () => {
  it('asks ONE paid-batch confirmation for N locales × M clips, then generates each voice in order into assets/audio/', async () => {
    const pending = batch()(ctx(), items);
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1), { timeout: 10_000 });
    const [req] = approvals.pending();
    expect(req).toMatchObject({ kind: 'paid-batch', toolName: 'provider:tts-openai', alwaysRule: 'provider:tts-openai' });
    expect(req!.paidBatch).toEqual({ provider: 'openai', calls: items.map((i) => ({ label: i.label, chars: i.text.length })) });
    // Nothing is sent before the answer.
    expect(sent).toEqual([]);
    await approvals.decide(req!.id, 'once');
    const out = await pending;
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    expect(out.provider).toBe('openai');
    // One request per voice, in the order given, with the translated scripts.
    expect(speechCalls().map((c) => (JSON.parse(c.body) as { input: string }).input)).toEqual(items.map((i) => i.text));
    expect(approvals.pending()).toEqual([]);
    for (const it of items) {
      const r = out.files.get(it.key);
      expect(r && 'file' in r ? r.file : null).toMatch(/^assets\/audio\/.+\.mp3$/);
      expect(await readFile(join(projectDir, (r as { file: string }).file), 'utf8')).toBe(`tts:${it.text}`);
    }
    // Registered in the library like any generated voice: description = the translated script.
    const assets = await new LibraryStore(projectDir, NoMediaTools).listAssets();
    expect(assets.map((a) => a.description).sort()).toEqual(items.map((i) => i.text).sort());
    expect(assets.every((a) => a.origin === 'generated' && a.kind === 'audio' && a.provider === 'openai')).toBe(true);
  });

  it('a project "Always" rule for tts covers the batch: no confirmation; "Always" on the card saves the same rule', async () => {
    await new PermissionsStore(projectDir).add('provider:tts-openai', 'x');
    const out = await batch()(ctx(), items.slice(0, 2));
    expect(out.status).toBe('done');
    expect(approvals.pending()).toEqual([]);
    expect(speechCalls()).toHaveLength(2);

    const other = await mkdtemp(join(tmpdir(), 'ms-voice-batch-b-'));
    try {
      const c2 = { ...ctx(), projectDir: other };
      const pending = batch()(c2, items.slice(0, 1));
      await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1), { timeout: 10_000 });
      await approvals.decide(approvals.pending()[0]!.id, 'always');
      expect((await pending).status).toBe('done');
      expect(await new PermissionsStore(other).has('provider:tts-openai')).toBe(true);
      // The next batch of that project asks nothing.
      expect((await batch()(c2, items.slice(1, 2))).status).toBe('done');
      expect(approvals.pending()).toEqual([]);
    } finally { await rm(other, { recursive: true, force: true }); }
  });

  it('a declined batch sends nothing and says so', async () => {
    const pending = batch()(ctx(), items);
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1), { timeout: 10_000 });
    await approvals.decide(approvals.pending()[0]!.id, 'deny');
    const out = await pending;
    expect(out.status).toBe('declined');
    expect(sent).toEqual([]);
    expect(await new LibraryStore(projectDir, NoMediaTools).listAssets()).toEqual([]);
  });

  it('voice `none`, a missing key or a key known to lack text_to_speech (F5): no confirmation and no request at all', async () => {
    const off = await batch()(ctx({ voice: 'none' }), items);
    expect(off).toMatchObject({ status: 'unavailable', reason: 'off' });
    const noKey = await batch({ env: {} })(ctx(), items);
    expect(noKey).toMatchObject({ status: 'unavailable', reason: 'noKey' });
    const forced = await batch()(ctx({ voice: 'elevenlabs' }), items);
    expect(forced).toMatchObject({ status: 'unavailable', reason: 'noKey' });
    const cache = new KeyCheckCache();
    cache.record('openai', 'tts', 'missing', 'model.request');
    const missing = await batch({ keyChecks: cache })(ctx(), items);
    expect(missing).toMatchObject({ status: 'unavailable', reason: 'missingPermission' });
    expect(approvals.pending()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('with confirmations off it generates without a card; the brand voice of the kit is used (ElevenLabs)', async () => {
    await mkdir(join(projectDir, 'brand'), { recursive: true });
    await writeFile(join(projectDir, 'brand', 'brand-kit.json'), JSON.stringify({ schemaVersion: 1, colors: [], fonts: [], logos: [], tone: null, dos: [], donts: [], photoStyle: null, sound: { genre: '', energy: null, instruments: [], avoid: [], voice: { provider: 'elevenlabs', id: 'brandvoice1', name: 'Brand' } } }));
    const out = await batch({ settings: { confirmPaidProviders: false }, env: { ELEVENLABS_API_KEY: 'xi-test-0123456789' } })(ctx(), items.slice(0, 1));
    expect(out).toMatchObject({ status: 'done', provider: 'elevenlabs' });
    expect(approvals.pending()).toEqual([]);
    expect(speechCalls().map((c) => c.url)).toEqual([expect.stringContaining('/v1/text-to-speech/brandvoice1')]);
  });

  it('a text over the provider limit is refused alone, before the confirmation, never sent', async () => {
    const long = { key: 'x', label: 'Long', text: 'a'.repeat(4097), name: 'long' };
    const pending = batch()(ctx(), [long, items[0]!]);
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1), { timeout: 10_000 });
    expect(approvals.pending()[0]!.paidBatch!.calls).toEqual([{ label: items[0]!.label, chars: items[0]!.text.length }]);
    await approvals.decide(approvals.pending()[0]!.id, 'once');
    const out = await pending;
    if (out.status !== 'done') throw new Error(out.status);
    expect(out.files.get('x')).toMatchObject({ error: expect.any(String) });
    expect(speechCalls()).toHaveLength(1);
  });

  it('a cancelled job leaves no card and sends nothing', async () => {
    const pending = batch()(ctx(), items);
    await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1), { timeout: 10_000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 499 });
    expect(approvals.pending()).toEqual([]);
    expect(sent).toEqual([]);
  });
});

// ---------- the voices of a localize turn (integration: fake claude, fake fetch, MemoryVault) ----------

describe('translated voices in a localize turn', { timeout: 120_000 }, () => {
  let env: InstanceEnv;
  let speech: string[];
  let log: string;
  afterEach(async () => { await env?.close(); });

  /** Voices whose script says LANG last 3 s, the others 1 s (the fake TTS writes the script into the file). */
  const media: MediaTools = {
    ...NoMediaTools,
    probeAudio: async (file: string) => {
      try { return { durationSec: (await readFile(file, 'utf8')).includes('LANG') ? 3 : 1 }; } catch { return null; }
    },
  };
  const tts = (async (url: string, init: RequestInit = {}) => {
    if (!url.startsWith('https://api.openai.com/v1/audio/speech')) { speech.push(`unexpected ${url}`); return new Response('no', { status: 404 }); }
    const input = (JSON.parse(String(init.body)) as { input: string }).input;
    speech.push(input);
    return new Response(new TextEncoder().encode(`tts:${input}`), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }) as unknown as typeof fetch;

  async function boot(o: { keys?: Record<string, string> } = {}) {
    speech = [];
    const bridge = new AgentBridge();
    env = await startInstanceEnv('ms-test-l10n-voices-', {
      bridge, media, vault: new MemoryVault(o.keys ?? { OPENAI_API_KEY: 'sk-test-0123456789' }),
      localizeHttp: { fetch: tts, lookup: async () => [{ address: '93.184.216.34', family: 4 as const }] },
    });
    bridge.setOrigin(await env.app.listen({ port: 0, host: '127.0.0.1' }));
    log = join(env.base, 'bridge.jsonl');
    process.env.FAKE_CLAUDE_BRIDGE_LOG = log;
    process.env.FAKE_CLAUDE_VOICE = '1';
  }
  const submit = (locale: string, rest: object) => ['submit_localization', { locale, instanceId: 'test-wide', texts: { title: `T-${locale}` }, params: {}, voiceScripts: {}, fit: {}, ...rest }] as const;
  const create = (brief: Record<string, unknown> = {}) => env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['de', 'fr'] }, brief });
  const startJob = async (slug: string, body: object) => {
    const r = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/localize`, headers: H, payload: body });
    expect(r.statusCode, r.body).toBe(202);
    return (r.json() as { jobId: string }).jobId;
  };
  const finished = async (id: string) => {
    const done = await env.waitJob(id);
    expect(done.state, done.error).toBe('succeeded');
    return done;
  };
  async function answer(decision: 'once' | 'always' | 'deny'): Promise<ApprovalRequest> {
    for (let i = 0; i < 1500; i++) {
      const [req] = (await env.app.inject({ url: '/api/approvals', headers: H })).json() as ApprovalRequest[];
      if (req) {
        expect((await env.app.inject({ method: 'POST', url: `/api/approvals/${req.id}`, headers: H, payload: { decision } })).statusCode).toBe(200);
        return req;
      }
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error('no approval came');
  }
  const rowOf = async (slug: string, locale: string) => (await env.versionOf(slug, 1))!.localizations!.find((r) => r.locale === locale && r.instanceId === 'test-wide')!;
  const overlayOf = async (slug: string, locale: string) =>
    JSON.parse(await readFile(join(env.store().dir(slug), 'outputs', 'v1', 'locales', locale, 'test-wide.json'), 'utf8')) as Localization;
  const vt = () => messages(currentLocale()).variants;

  it('one paid-batch confirmation for every language; the voices land in the overlays; a clip with no script is reported', async () => {
    await boot();
    const slug = await create();
    process.env.FAKE_CLAUDE_LOCALIZE_CALLS = JSON.stringify([submit('de', { voiceScripts: { vo: 'Willkommen bei Acme' } }), submit('fr', { voiceScripts: { vo: 'Bienvenue chez Acme' } })]);
    const id = await startJob(slug, { locales: ['de', 'fr'], voice: { de: 'translate', fr: 'translate' } });
    const req = await answer('once');
    const job = await finished(id);
    expect(req).toMatchObject({ kind: 'paid-batch', toolName: 'provider:tts-openai' });
    expect(req.paidBatch!.calls.map((c) => c.chars)).toEqual([19, 19]);
    expect(speech).toEqual(['Willkommen bei Acme', 'Bienvenue chez Acme']);
    for (const [l, script] of [['de', 'Willkommen bei Acme'], ['fr', 'Bienvenue chez Acme']] as const) {
      const o = await overlayOf(slug, l);
      expect(o.voices.vo).toMatchObject({ sourceScript: 'Welcome to Acme', script });
      expect(o.voices.vo!.src).toMatch(/^assets\/audio\/.+\.mp3$/);
      expect(await readFile(join(env.projectDir(), o.voices.vo!.src), 'utf8')).toBe(`tts:${script}`);
      const row = await rowOf(slug, l);
      expect(row).toMatchObject({ voice: 'translated', noScript: ['vo2'] });
      expect(row.problems).toBeUndefined();
    }
    // The clip without a script: "can't translate voice", in the job's result and the chat.
    const cant = vt().voiceNoScript({ clip: 'Second voice', format: 'test-wide' });
    expect(job.notes).toContain(cant);
    expect((await env.store().readConversation(slug)).some((e) => e.type === 'system' && e.text === cant)).toBe(true);
    // The localized render copies the generated voice into its private copy.
    let copied = false;
    env.fake.after = async (o) => {
      const src = (await overlayOf(slug, 'de')).voices.vo!.src;
      copied = existsSync(join(o.dir, 'outputs', 'v1', 'compositions', 'test-wide', ...src.split('/')));
    };
    const r = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: { locales: ['de'] } });
    expect(r.statusCode, r.body).toBe(202);
    expect((await env.waitJob((r.json() as JobSummary).id)).state).toBe('succeeded');
    expect(copied).toBe(true);
    const rendered = env.fake.renders.at(-1)!;
    expect(JSON.stringify(rendered.composition)).toContain((await overlayOf(slug, 'de')).voices.vo!.src);
  });

  it('Ruling L: the row records the voice\'s hash; a voice replaced afterwards is a problem and is never rendered; carry-over keeps the hash', async () => {
    await boot();
    const slug = await create();
    process.env.FAKE_CLAUDE_LOCALIZE_CALLS = JSON.stringify([submit('de', { voiceScripts: { vo: 'Willkommen bei Acme' } })]);
    const id = await startJob(slug, { locales: ['de'] });
    await answer('once');
    await finished(id);
    const src = (await overlayOf(slug, 'de')).voices.vo!.src;
    const file = join(env.projectDir(), ...src.split('/'));
    const row = await rowOf(slug, 'de');
    expect(row.assetHashes).toEqual({ [src]: createHash('sha256').update(await readFile(file)).digest('hex') });
    // A new version keeps the translation, and the hash with it.
    await env.turn(slug, { text: 'again' });
    const v2 = (await env.versionOf(slug, 2))!.localizations!.find((r) => r.locale === 'de')!;
    expect(v2.assetHashes).toEqual(row.assetHashes);
    // The file is replaced (by anyone): the localized render refuses it and records the problem.
    await writeFile(file, 'someone else');
    const before = env.fake.renders.length;
    const r = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: { locales: ['de'] } });
    expect(r.statusCode, r.body).toBe(202);
    const job = await env.waitJob((r.json() as JobSummary).id);
    expect(job.state).toBe('failed');
    expect(job.error).toContain(vt().assetChanged({ file: src }));
    expect(env.fake.renders.length).toBe(before);
    expect((await rowOf(slug, 'de')).problems).toContain(vt().assetChanged({ file: src }));
  });

  it('a declined batch keeps the original voice, with the reason on the row', async () => {
    await boot();
    const slug = await create();
    process.env.FAKE_CLAUDE_LOCALIZE_CALLS = JSON.stringify([submit('de', { voiceScripts: { vo: 'Willkommen' } })]);
    const id = await startJob(slug, { locales: ['de'] });
    await answer('deny');
    await finished(id);
    expect(speech).toEqual([]);
    expect(await rowOf(slug, 'de')).toMatchObject({ voice: 'original', voiceFallback: 'declined' });
    expect((await overlayOf(slug, 'de')).voices).toEqual({});
    expect((await overlayOf(slug, 'de')).texts.title!.text).toBe('T-de');
  });

  it('voice `none` in the brief: no confirmation, no request; the per-language choice applies and voices are not asked', async () => {
    await boot();
    const slug = await create({ services: { voice: 'none' } });
    process.env.FAKE_CLAUDE_LOCALIZE_CALLS = JSON.stringify([submit('de', {}), submit('fr', {})]);
    await finished(await startJob(slug, { locales: ['de', 'fr'], voice: { de: 'translate', fr: 'muted' } }));
    expect(speech).toEqual([]);
    expect((await env.app.inject({ url: '/api/approvals', headers: H })).json()).toEqual([]);
    expect(await rowOf(slug, 'de')).toMatchObject({ voice: 'original', voiceFallback: 'off' });
    expect(await rowOf(slug, 'fr')).toMatchObject({ voice: 'muted' });
    expect(env.promptTexts().at(-1)).not.toContain('voice "vo"');
  });

  it('no key: no confirmation, no request, the original voice with the reason', async () => {
    await boot({ keys: {} });
    const slug = await create();
    process.env.FAKE_CLAUDE_LOCALIZE_CALLS = JSON.stringify([submit('de', {})]);
    await finished(await startJob(slug, { locales: ['de'] }));
    expect(speech).toEqual([]);
    expect(await rowOf(slug, 'de')).toMatchObject({ voice: 'original', voiceFallback: 'noKey' });
  });

  it('a voice longer than its clip is a problem with both durations; the repair asks a shorter script, regenerated alone in a new batch', async () => {
    await boot();
    const slug = await create();
    process.env.FAKE_CLAUDE_LOCALIZE_CALLS = JSON.stringify([
      submit('de', { voiceScripts: { vo: 'Willkommen LANG LANG' } }), submit('fr', { voiceScripts: { vo: 'Bienvenue' } }),
    ]);
    process.env.FAKE_CLAUDE_LOCALIZE_FIX_CALLS = JSON.stringify([submit('de', { voiceScripts: { vo: 'Willkommen' } })]);
    const runs = env.agentRuns();
    const id = await startJob(slug, { locales: ['de', 'fr'], text: 'Keep it friendly' });
    const first = await answer('once');
    const second = await answer('once');
    await finished(id);
    expect(first.paidBatch!.calls).toHaveLength(2);
    // The regeneration: a new confirmation for that voice only.
    expect(second.paidBatch!.calls).toHaveLength(1);
    expect(speech).toEqual(['Willkommen LANG LANG', 'Bienvenue', 'Willkommen']);
    // The shorter script of attempt 2 is voiced in attempt 2: no third attempt (fix I2).
    expect(env.agentRuns()).toBe(runs + 2);
    const fix = env.promptTexts().at(-1)!;
    const long = vt().voiceTooLong({ clip: 'Voice', voice: 3, clipSec: 2 });
    expect(fix).toContain(long);
    expect(fix).toContain('<user_request>\nKeep it friendly\n</user_request>');
    expect((await overlayOf(slug, 'de')).voices.vo!.script).toBe('Willkommen');
    expect((await rowOf(slug, 'de')).problems).toBeUndefined();
    expect((await rowOf(slug, 'fr')).voice).toBe('translated');
  });

  it('a long voice never fixed stays a reported problem, with the file kept (never cut)', async () => {
    await boot();
    const slug = await create();
    process.env.FAKE_CLAUDE_LOCALIZE_CALLS = JSON.stringify([submit('de', { voiceScripts: { vo: 'LANG' } })]);
    process.env.FAKE_CLAUDE_LOCALIZE_FIX_CALLS = JSON.stringify([submit('de', { voiceScripts: { vo: 'LANG again' } })]);
    const id = await startJob(slug, { locales: ['de'] });
    for (let i = 0; i < 2; i++) await answer('once');
    await finished(id);
    // The third attempt sends the same script again: nothing is regenerated (it would last as long).
    expect(speech).toEqual(['LANG', 'LANG again']);
    const row = await rowOf(slug, 'de');
    expect(row.voice).toBe('translated');
    expect(row.problems).toEqual([vt().voiceTooLong({ clip: 'Voice', voice: 3, clipSec: 2 })]);
    expect((await overlayOf(slug, 'de')).voices.vo!.script).toBe('LANG again');
  });
});
