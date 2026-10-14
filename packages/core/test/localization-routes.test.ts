// @vitest-environment node
/**
 * Localization routes (Phase 12, Task 3, spec §3.3): list, read and edit an overlay (origin `editor`, under the creative's
 * lock, checks again, no new version), path segments checked first, and the localized composition for the preview.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages, type JobSummary, type Localization, type VersionEntry } from '@motion-studio/shared';
import { currentLocale } from '../src/i18n.ts';
import { H, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

let env: InstanceEnv;
beforeEach(async () => { env = await startInstanceEnv('ms-test-l10n-routes-'); });
afterEach(async () => { await env?.close(); });

const v = () => messages(currentLocale()).variants;
const url = (slug: string, n: number, rest = '') => `/api/projects/acme/creatives/${slug}/versions/${n}/localizations${rest}`;
const put = (slug: string, n: number, locale: string, inst: string, payload: unknown) =>
  env.app.inject({ method: 'PUT', url: url(slug, n, `/${encodeURIComponent(locale)}/${encodeURIComponent(inst)}`), headers: H, payload: payload as object });
const get = (slug: string, n: number, locale: string, inst: string) => env.app.inject({ url: url(slug, n, `/${encodeURIComponent(locale)}/${encodeURIComponent(inst)}`), headers: H });
const create = () => env.create(['test-wide', 'test-tall'], { links: {}, locales: { primary: 'en', extra: ['de', 'fr', 'ja'] } });

describe('localization routes', { timeout: 120_000 }, () => {
  it('a manual edit writes the overlay (sources from the composition), its row, and no new version', async () => {
    const slug = await create();
    const before = await env.store().readVersions(slug);
    const r = await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { overlay: Localization; problems: string[]; stale: string[]; origin: string; voice: string; hash: string };
    expect(body.overlay.texts).toEqual({ title: { source: 'Hello', text: 'Hallo' } });
    expect(body).toMatchObject({ problems: [], stale: [], origin: 'editor', voice: 'original' });
    const after = await env.store().readVersions(slug);
    expect(after.map((x) => x.n)).toEqual(before.map((x) => x.n));
    expect(after[0]!.localizations).toEqual([{ locale: 'de', instanceId: 'test-wide', hash: body.hash, origin: 'editor', stale: [], voice: 'original' }]);
    // Everything else of the version is untouched.
    const { localizations: _l, ...rest } = after[0]!;
    expect(rest).toEqual(before[0]);
    const file = join(env.store().dir(slug), 'outputs', 'v1', 'locales', 'de', 'test-wide.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(body.overlay);
    expect(readdirSync(join(env.store().dir(slug), 'outputs', 'v1', 'locales', 'de'))).toEqual(['test-wide.json']);
    const g = await get(slug, 1, 'de', 'test-wide');
    expect(g.statusCode).toBe(200);
    // The PUT also returns the advisory warnings of the checks (Ruling K); the GET only the stored view.
    const { warnings: _w, ...stored } = body as typeof body & { warnings?: string[] };
    expect(g.json()).toEqual(stored);
    const list = await env.app.inject({ url: url(slug, 1), headers: H });
    expect(list.json()).toEqual({ entries: after[0]!.localizations, available: ['de', 'fr', 'ja'] });
    // A later edit merges: the voice choice and a removal.
    const r2 = await put(slug, 1, 'de', 'test-wide', { voice: 'muted' });
    expect(r2.json()).toMatchObject({ voice: 'muted', overlay: { texts: { title: { text: 'Hallo' } } } });
    const r3 = await put(slug, 1, 'de', 'test-wide', { texts: { title: null } });
    expect(r3.json().overlay.texts).toEqual({});
  });

  it('a text that overflows even at 0.7 is stored with the problem, not refused', async () => {
    const slug = await create();
    const long = 'Herzlich willkommen zur brandneuen Version unserer wunderbaren Anwendung für alle Geräte';
    const r = await put(slug, 1, 'de', 'test-wide', { texts: { title: long } });
    expect(r.statusCode, r.body).toBe(200);
    // A renderer is free: the browser's measure decides (P5), at the 70% the core tried last.
    const measured = v().textOverflowMeasured({ clip: 'Title', fit: 70 });
    expect(r.json()).toMatchObject({ problems: [measured], overlay: { fit: { title: 0.7 }, texts: { title: { text: long } } } });
    expect((await env.versionOf(slug, 1))!.localizations![0]!.problems).toEqual([measured]);
    // Shorter: the core picks the fit, no problem.
    const ok = await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Willkommen zur neuen Version unserer App' } });
    expect(ok.json().problems).toEqual([]);
    expect(ok.json().overlay.fit.title).toBeGreaterThanOrEqual(0.7);
    expect(ok.json().overlay.fit.title).toBeLessThan(1);
  });

  it('a manual edit gets the browser\'s measure when a renderer is free: it decides the fit and the overflow both ways (P5)', async () => {
    const slug = await create();
    // The browser lays the long text out inside the box at 100%: the estimate's overflow is cleared, no fit is needed.
    env.fake.measure = () => [];
    const long = 'Herzlich willkommen zur brandneuen Version unserer wunderbaren Anwendung für alle Geräte';
    const a = await put(slug, 1, 'de', 'test-wide', { texts: { title: long } });
    expect(a.json().problems).toEqual([]);
    expect(a.json().overlay.fit).toEqual({});
    expect((await env.versionOf(slug, 1))!.localizations![0]!.issues).toBeUndefined();
    // The browser needs 85% for a short text the estimate fits at 100%: the core's fit is 85%, with no problem.
    env.fake.measure = (c) => ((c.tracks.flatMap((t) => t.clips).find((x) => x.id === 'title') as { props: { fontSize: number } }).props.fontSize > 17 + 1e-6 ? ['title'] : []);
    const b = await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    expect(b.json()).toMatchObject({ problems: [], overlay: { fit: { title: 0.85 } } });
    // A fit given by hand is measured as it is: at 100% the browser says it overflows.
    const c = await put(slug, 1, 'de', 'test-wide', { fit: { title: 1 } });
    expect(c.json().problems).toEqual([v().textOverflowMeasured({ clip: 'Title', fit: 100 })]);
    expect(c.json().issues).toEqual([{ code: 'textOverflowMeasured', clipId: 'title', message: v().textOverflowMeasured({ clip: 'Title', fit: 100 }) }]);
  });

  it('refuses unknown ids, fields the spec does not allow and bad fits (400), with nothing written', async () => {
    const slug = await create();
    const bad: Array<[unknown, string]> = [
      [{ texts: { nope: 'x' } }, 'localization-mismatch'], [{ texts: { bg: 'x' } }, 'localization-mismatch'],
      [{ params: { 'title.x': 'x' } }, 'localization-mismatch'], [{ fit: { title: 0.9 } }, 'localization-mismatch'],
      [{ texts: { title: 'x' }, props: {} }, 'localization-invalid'], [{ fit: { title: 0.5 } }, 'localization-invalid'],
      [{ voice: 'translated' }, 'localization-invalid'], [{ voices: { vo: { src: 'assets/x.mp3' } } }, 'localization-invalid'],
      [{ texts: { title: 5 } }, 'localization-invalid'],
    ];
    for (const [payload, code] of bad) {
      const r = await put(slug, 1, 'de', 'test-wide', payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().code, JSON.stringify(payload)).toBe(code);
    }
    expect(existsSync(join(env.store().dir(slug), 'outputs', 'v1', 'locales'))).toBe(false);
    expect((await env.versionOf(slug, 1))!.localizations).toBeUndefined();
  });

  it('checks the locale and instance segments before any path: RTL and unknown tags with a translated reason, unknown or hostile instances', async () => {
    const slug = await create();
    const rtl = await put(slug, 1, 'ar', 'test-wide', { texts: { title: 'x' } });
    expect(rtl.statusCode).toBe(400);
    expect(rtl.json()).toMatchObject({ code: 'locale-rtl', error: v().localeRtl({ tag: 'ar' }) });
    const xx = await get(slug, 1, 'xx', 'test-wide');
    expect(xx.statusCode).toBe(400);
    expect(xx.json()).toMatchObject({ code: 'locale-unsupported', error: v().localeUnsupported({ tag: 'xx' }) });
    // `..` is resolved by the router before any handler: never a 200.
    expect([400, 404]).toContain((await get(slug, 1, '..', 'test-wide')).statusCode);
    expect((await get(slug, 1, '%2E%2E', 'test-wide')).statusCode).toBe(400);
    for (const inst of ['nope', '..', 'test-wide@2', '..%2F..%2Fx', 'test-wide.json']) {
      const r = await put(slug, 1, 'de', inst, { texts: { title: 'x' } });
      expect([400, 404], inst).toContain(r.statusCode);
    }
    // A supported language that is not one of the creative's: 409.
    const it_ = await put(slug, 1, 'it', 'test-wide', { texts: { title: 'Ciao' } });
    expect(it_.statusCode).toBe(409);
    expect(it_.json().code).toBe('locale-not-in-brief');
    expect(existsSync(join(env.store().dir(slug), 'outputs', 'v1', 'locales'))).toBe(false);
    // Nothing yet for a valid pair: 404.
    expect((await get(slug, 1, 'fr', 'test-wide')).json().code).toBe('localization-not-found');
    expect((await env.app.inject({ url: url(slug, 9), headers: H })).statusCode).toBe(404);
  });

  it('edits run under the creative lock: concurrent edits are serialised, none lost; refused while a turn runs', async () => {
    const slug = await create();
    const rs = await Promise.all([
      put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } }),
      put(slug, 1, 'fr', 'test-wide', { texts: { title: 'Bonjour' } }),
      put(slug, 1, 'de', 'test-tall', { texts: { title: 'Hallo hoch' } }),
      put(slug, 1, 'fr', 'test-tall', { texts: { title: 'Bonjour haut' } }),
    ]);
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    const rows = (await env.versionOf(slug, 1))!.localizations!;
    expect(rows.map((r) => `${r.locale}/${r.instanceId}`).sort()).toEqual(['de/test-tall', 'de/test-wide', 'fr/test-tall', 'fr/test-wide']);
    for (const r of rs) expect(rows.find((x) => x.hash === r.json().hash)).toBeDefined();
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const t = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/turns`, headers: H, payload: { text: 'go' } });
    const job = t.json() as JobSummary;
    await env.waitRunning(job.id);
    const busy = await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Servus' } });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().code).toBe('localization-busy');
    await env.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: H });
    await env.waitJob(job.id);
    expect((await get(slug, 1, 'de', 'test-wide')).json().overlay.texts.title.text).toBe('Hallo');
  });

  it('the preview endpoint returns the localized composition (only the text changes), with the stale ids and problems', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    const plain = await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/compositions/test-wide`, headers: H });
    const loc = await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/compositions/test-wide?locale=de`, headers: H });
    expect(loc.statusCode, loc.body).toBe(200);
    const a = plain.json();
    const b = loc.json();
    expect(b.localization).toEqual({ locale: 'de', stale: [], problems: [], voice: 'original' });
    const title = (c: { tracks: Array<{ clips: Array<{ id: string; props: { text?: string } }> }> }) => c.tracks.flatMap((t) => t.clips).find((x) => x.id === 'title')!.props.text;
    expect(title(b.composition)).toBe('Hallo');
    expect(title(a.composition)).toBe('Hello');
    const strip = (c: unknown) => JSON.parse(JSON.stringify(c).replace(/"Hallo"|"Hello"/g, '"T"'));
    expect(strip(b.composition)).toEqual(strip(a.composition));
    expect((await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/compositions/test-wide?locale=ar`, headers: H })).json().code).toBe('locale-rtl');
    expect((await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/compositions/test-tall?locale=de`, headers: H })).statusCode).toBe(404);
    // A stale entry shows the source text, flagged.
    const vfile = join(env.store().dir(slug), 'versions.json');
    const vf = JSON.parse(readFileSync(vfile, 'utf8')) as { versions: VersionEntry[] };
    vf.versions[0]!.localizations![0]!.stale = ['title'];
    writeFileSync(vfile, JSON.stringify(vf));
    const stale = (await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/compositions/test-wide?locale=de`, headers: H })).json();
    expect(title(stale.composition)).toBe('Hello');
    expect(stale.localization.stale).toEqual(['title']);
  });

  it('a non-Latin language without the network: the overlay is stored with "fallback font unavailable" (no request leaves the machine)', async () => {
    const slug = await create();
    const r = await put(slug, 1, 'ja', 'test-wide', { texts: { title: 'こんにちは' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().problems).toEqual([v().fallbackFontUnavailable({ family: 'Noto Sans JP' })]);
    expect(r.json().overlay.fonts).toEqual([]);
  });
});
