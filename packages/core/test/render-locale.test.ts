// @vitest-environment node
/**
 * Render and export per language (Phase 12, Task 3, spec §3.5): `outputs/vN/<instanceId>.<locale>.<ext>` through the usual
 * pipeline on the localized composition; 409 with the list without `force` when a translation has open problems or stale
 * entries; the manifest records `locale`, `forced` and `stale`; no locale = today's file and manifest; export `locales` and
 * the `{locale}` token.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages, type JobSummary, type ManifestV2, type VersionEntry } from '@motion-studio/shared';
import { currentLocale } from '../src/i18n.ts';
import { H, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

let env: InstanceEnv;
let dest: string;
beforeEach(async () => { env = await startInstanceEnv('ms-test-render-locale-'); dest = mkdtempSync(join(tmpdir(), 'ms-test-render-locale-dest-')); });
afterEach(async () => { await env?.close(); rmSync(dest, { recursive: true, force: true }); });

const v = () => messages(currentLocale()).variants;
const put = (slug: string, n: number, locale: string, inst: string, payload: object) =>
  env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/versions/${n}/localizations/${locale}/${encodeURIComponent(inst)}`, headers: H, payload });
const render = (slug: string, n: number, payload: object) => env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/${n}/render`, headers: H, payload });
const manifest = (slug: string, n: number) => JSON.parse(readFileSync(join(env.store().dir(slug), 'outputs', `v${n}`, 'manifest.json'), 'utf8')) as ManifestV2;
const create = () => env.create(['test-wide', 'test-tall'], { links: {}, locales: { primary: 'en', extra: ['de', 'fr'] } });
const done = async (r: { statusCode: number; body: string; json(): unknown }) => {
  expect(r.statusCode, r.body).toBe(202);
  const j = await env.waitJob((r.json() as JobSummary).id);
  expect(j.state, j.error).toBe('succeeded');
  return j;
};
const title = (c: { tracks: Array<{ clips: Array<{ id: string; props: { text?: string; fontSize?: number } }> }> }) => c.tracks.flatMap((t) => t.clips).find((x) => x.id === 'title')!.props;

describe('render per language', { timeout: 120_000 }, () => {
  it('renders the localized composition into <instanceId>.<locale>.<ext>, records the row render and the manifest entry', async () => {
    const slug = await create();
    expect((await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } })).statusCode).toBe(200);
    const job = await done(await render(slug, 1, { formats: ['test-wide'], locales: ['de'] }));
    expect(job.formats).toEqual(['test-wide.de']);
    const call = env.fake.renders.at(-1)!;
    expect(call.out).toBe(join(env.store().dir(slug), 'outputs', 'v1', 'test-wide.de.mp4'));
    expect(call.format.id).toBe('test-wide');
    expect(title(call.composition as never).text).toBe('Hallo');
    // From a private copy outside the creative, removed afterwards.
    expect(call.dir.startsWith(join(env.projectDir(), '.studio', 'cache', 'locale-render'))).toBe(true);
    expect(existsSync(call.dir)).toBe(false);
    expect(existsSync(call.out)).toBe(true);
    const ver = (await env.versionOf(slug, 1))!;
    const row = ver.localizations!.find((r) => r.locale === 'de')!;
    expect(row.render).toMatchObject({ file: 'test-wide.de.mp4', overlayHash: row.hash, fromComposition: ver.compositions!.find((c) => c.format === 'test-wide')!.hash, forced: false, stale: [] });
    expect(manifest(slug, 1).renders).toEqual([expect.objectContaining({ format: 'test-wide', file: 'test-wide.de.mp4', locale: 'de', forced: false, stale: [] })]);
    // The primary-language records are not touched.
    expect(ver.outputs).toEqual([]);
  });

  it('without a locale: today\'s file and manifest entry (no language fields), and a later render keeps the localized entries', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    await done(await render(slug, 1, { locales: ['de'], formats: ['test-wide'] }));
    await done(await render(slug, 1, {}));
    const renders = manifest(slug, 1).renders;
    const plain = renders.filter((r) => r.locale === undefined);
    expect(plain.map((r) => r.file).sort()).toEqual(['test-tall.mp4', 'test-wide.mp4']);
    for (const r of plain) expect(Object.keys(r).sort()).toEqual(['durationSec', 'file', 'format', 'fromComposition', 'height', 'renderedAt', 'sha256', 'width']);
    expect(renders.filter((r) => r.locale === 'de').map((r) => r.file)).toEqual(['test-wide.de.mp4']);
    expect(title(env.fake.renders.find((x) => x.out.endsWith('/test-wide.mp4'))!.composition as never).text).toBe('Hello');
  });

  it('open problems or stale entries need force (409 with the list); with force the render is marked forced and stale', async () => {
    const slug = await create();
    const long = 'Herzlich willkommen zur brandneuen Version unserer wunderbaren Anwendung für alle Geräte';
    expect((await put(slug, 1, 'de', 'test-wide', { texts: { title: long } })).json().problems).toHaveLength(1);
    const refused = await render(slug, 1, { formats: ['test-wide'], locales: ['de'] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'localization-needs-force', problems: ['Test · Wide (de)'] });
    expect(env.fake.renders).toHaveLength(0);
    await done(await render(slug, 1, { formats: ['test-wide'], locales: ['de'], force: true }));
    expect(manifest(slug, 1).renders[0]).toMatchObject({ locale: 'de', forced: true, stale: [] });
    expect(title(env.fake.renders[0]!.composition as never)).toMatchObject({ text: long, fontSize: 14 });
    // A stale entry: rendered with the source text, recorded as stale.
    const vfile = join(env.store().dir(slug), 'versions.json');
    await put(slug, 1, 'fr', 'test-wide', { texts: { title: 'Bonjour' } });
    const vf = JSON.parse(readFileSync(vfile, 'utf8')) as { versions: VersionEntry[] };
    vf.versions[0]!.localizations!.find((r) => r.locale === 'fr')!.stale = ['title'];
    writeFileSync(vfile, JSON.stringify(vf));
    expect((await render(slug, 1, { formats: ['test-wide'], locales: ['fr'] })).json().code).toBe('localization-needs-force');
    await done(await render(slug, 1, { formats: ['test-wide'], locales: ['fr'], force: true }));
    expect(title(env.fake.renders.at(-1)!.composition as never).text).toBe('Hello');
    expect(manifest(slug, 1).renders.find((r) => r.locale === 'fr')).toMatchObject({ forced: true, stale: ['title'] });
  });

  it('refuses a language without translation (409), an RTL or unknown tag (400), before anything renders', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    const missing = await render(slug, 1, { locales: ['de'] });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ code: 'localization-missing', problems: ['Test · Tall (de)'] });
    const rtl = await render(slug, 1, { locales: ['ar'] });
    expect(rtl.statusCode).toBe(400);
    expect(rtl.json()).toMatchObject({ code: 'locale-rtl', error: v().localeRtl({ tag: 'ar' }) });
    expect((await render(slug, 1, { locales: ['../x'] })).json().code).toBe('locale-unsupported');
    expect(env.fake.renders).toHaveLength(0);
  });
});

describe('export per language', { timeout: 120_000 }, () => {
  const exportPicks = (slug: string, payload: object) => env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { destination: dest, ...payload } });

  it('exports the chosen languages; the default pattern gains {locale} for a creative with extra languages, rendering first', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    const r = await exportPicks(slug, { picks: { 'test-wide': 1 }, locales: ['en', 'de'], date: '2026-10-13' });
    expect(r.statusCode, r.body).toBe(200);
    expect(readdirSync(dest).sort()).toEqual(['launch-test-wide-de-v1.mp4', 'launch-test-wide-en-v1.mp4']);
    // Only the German file was rendered for the translation, from the localized composition.
    expect(env.fake.renders.map((x) => x.out.split('/').pop()).sort()).toEqual(['test-wide.de.mp4', 'test-wide.mp4']);
  });

  it('a custom pattern with {locale}, and one without it (each translation then named with its language)', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    await put(slug, 1, 'fr', 'test-wide', { texts: { title: 'Bonjour' } });
    const a = await exportPicks(slug, { picks: { 'test-wide': 1 }, locales: ['de', 'fr'], pattern: '{locale}_{format}' });
    expect(a.statusCode, a.body).toBe(200);
    expect(readdirSync(dest).sort()).toEqual(['de_test-wide.mp4', 'fr_test-wide.mp4']);
    rmSync(dest, { recursive: true, force: true });
    const b = await exportPicks(slug, { picks: { 'test-wide': 1 }, locales: ['en', 'de', 'fr'], pattern: '{title}' });
    expect(b.statusCode, b.body).toBe(200);
    expect(readdirSync(dest).sort()).toEqual(['launch-de.mp4', 'launch-fr.mp4', 'launch.mp4']);
  });

  it('a translation with problems needs force; a format without translation is refused; RTL refused', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Herzlich willkommen zur brandneuen Version unserer wunderbaren Anwendung für alle Geräte' } });
    const r = await exportPicks(slug, { picks: { 'test-wide': 1 }, locales: ['de'] });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('localization-needs-force');
    expect(readdirSync(dest)).toEqual([]);
    const ok = await exportPicks(slug, { picks: { 'test-wide': 1 }, locales: ['de'], force: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(readdirSync(dest)).toEqual([expect.stringMatching(/^launch-test-wide-de-v1\.mp4$/)]);
    const none = await exportPicks(slug, { picks: { 'test-tall': 1 }, locales: ['de'] });
    expect(none.statusCode).toBe(409);
    expect(none.json().code).toBe('localization-missing');
    expect((await exportPicks(slug, { picks: { 'test-wide': 1 }, locales: ['he'] })).json().code).toBe('locale-rtl');
  });

  it('without extra languages the names are today\'s', async () => {
    const slug = await env.create(['test-wide'], { links: {} });
    const r = await exportPicks(slug, { picks: { 'test-wide': 1 }, date: '2026-10-13' });
    expect(r.statusCode, r.body).toBe(200);
    expect(readdirSync(dest)).toEqual(['launch-test-wide-v1.mp4']);
  });
});
