// @vitest-environment node
/**
 * Render and export per language (Phase 12, Task 3, spec §3.5): `outputs/vN/<instanceId>.<locale>.<ext>` through the usual
 * pipeline on the localized composition; 409 with the list without `force` when a translation has open problems or stale
 * entries; the manifest records `locale`, `forced` and `stale`; no locale = today's file and manifest; export `locales` and
 * the `{locale}` token.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_NAME_PATTERN, messages, type JobSummary, type ManifestV2, type VersionEntry } from '@motion-studio/shared';
import { currentLocale } from '../src/i18n.ts';
import { H, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';
import { FONT } from './helpers/render-env.ts';
import { LibraryStore } from '../src/library/library-store.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';

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

  it('a localized render job reports its progress under the <instance>.<locale> format (Q6)', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    let release: () => void = () => {};
    env.fake.gate = new Promise<void>((res) => { release = res; });
    try {
      const r = await render(slug, 1, { formats: ['test-wide'], locales: ['de'] });
      expect(r.statusCode, r.body).toBe(202);
      const id = (r.json() as JobSummary).id;
      await env.waitRunning(id);
      for (let i = 0; i < 500 && env.fake.renders.length === 0; i++) await new Promise((res) => setTimeout(res, 20));
      const call = env.fake.renders.at(-1)!;
      expect(typeof call.onProgress).toBe('function');
      call.onProgress!({ frames: 4, total: 30 } as never);
      const seen = ((await env.app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === id)!;
      expect(seen.progress).toEqual({ format: 'test-wide.de', phase: 'frames', done: 4, total: 30 });
    } finally { release(); env.fake.gate = null; }
  });

  it('refuses a language that is not in the brief, for the render and the export, with the translated reason (Q6)', async () => {
    const slug = await create();
    const reason = v().localeNotInBrief({ tag: 'ja' });
    const r = await render(slug, 1, { formats: ['test-wide'], locales: ['ja'] });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json()).toMatchObject({ code: 'locale-not-in-brief', error: reason });
    const body = { picks: { 'test-wide': 1 }, destination: dest, locales: ['ja'] };
    const e = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: body });
    expect(e.statusCode, e.body).toBe(400);
    expect(e.json()).toMatchObject({ code: 'locale-not-in-brief' });
    const p = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export/prepare`, headers: H, payload: { picks: { 'test-wide': 1 }, locales: ['ja'] } });
    expect(p.statusCode, p.body).toBe(400);
    expect(p.json()).toMatchObject({ code: 'locale-not-in-brief' });
  });

  it('without a locale: today\'s file and manifest entry (no language fields), and a later render keeps the localized entries', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    await done(await render(slug, 1, { locales: ['de'], formats: ['test-wide'] }));
    await done(await render(slug, 1, {}));
    const renders = manifest(slug, 1).renders;
    const plain = renders.filter((r) => r.locale === undefined);
    expect(plain.map((r) => r.file).sort()).toEqual(['test-tall.mp4', 'test-wide.mp4']);
    // Decision 974: a video's render also records its quality, size and encoder (`render`); still no language fields.
    for (const r of plain) expect(Object.keys(r).sort()).toEqual(['durationSec', 'file', 'format', 'fromComposition', 'height', 'render', 'renderedAt', 'sha256', 'width']);
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

  it('with no v2 manifest yet, the localized render starts one from the version\'s compositions', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    rmSync(join(env.store().dir(slug), 'outputs', 'v1', 'manifest.json'));
    await done(await render(slug, 1, { formats: ['test-wide'], locales: ['de'] }));
    const m = manifest(slug, 1);
    expect(m.compositions.map((c) => c.format)).toEqual(['test-wide', 'test-tall']);
    expect(m.renders).toEqual([expect.objectContaining({ file: 'test-wide.de.mp4', locale: 'de' })]);
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

describe('render problems of a translation (Rulings I, J)', { timeout: 120_000 }, () => {
  it('a measured overflow is a problem of the language (row and render), never of the primary render', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    env.fake.overflows = ['title'];
    await done(await render(slug, 1, { formats: ['test-wide'], locales: ['de'] }));
    await done(await render(slug, 1, { formats: ['test-wide'] }));
    const ver = (await env.versionOf(slug, 1))!;
    const text = v().textOverflowMeasured({ clip: 'Title', fit: 100 });
    const row = ver.localizations!.find((r) => r.locale === 'de')!;
    expect(row.render!.problems).toEqual([text]);
    expect(row.problems).toEqual([text]);
    expect(row.issues).toEqual([{ code: 'textOverflowMeasured', clipId: 'title', message: text }]);
    expect(ver.outputs.find((o) => o.format === 'test-wide')!.problems).toEqual([]);
    expect(ver.problems).toEqual([]);
    // Now it has an open problem: a new render needs force.
    expect((await render(slug, 1, { formats: ['test-wide'], locales: ['de'] })).json().code).toBe('localization-needs-force');
  });

  it('a measured overflow of a clip that shows the source text (outdated) is "source text overflows": never a problem of the translation (live F4)', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    // A direct edit changes the source title: in v2 the German title is outdated, the render shows the new English text.
    const view = (await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/compositions/test-wide`, headers: H })).json() as { hash: string; composition: { tracks: Array<{ clips: Array<{ id: string; props: { text?: string } }> }> } };
    const c = structuredClone(view.composition);
    c.tracks.flatMap((t) => t.clips).find((k) => k.id === 'title')!.props.text = 'A much longer English title that wraps';
    const e = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/edits`, headers: H,
      payload: { baseVersion: 1, format: 'test-wide', baseHash: view.hash, composition: c, staged: [], ops: [], token: 'A'.repeat(43) } });
    expect(e.statusCode, e.body).toBe(200);
    expect((await env.versionOf(slug, 2))!.localizations!.find((r) => r.locale === 'de')!.stale).toEqual(['title']);
    env.fake.overflows = ['title'];
    await done(await render(slug, 2, { formats: ['test-wide'], locales: ['de'], force: true }));
    const row = (await env.versionOf(slug, 2))!.localizations!.find((r) => r.locale === 'de')!;
    const text = v().sourceTextOverflow({ clip: 'Title' });
    expect(row.issues).toEqual(expect.arrayContaining([{ code: 'sourceTextOverflow', clipId: 'title', message: text }]));
    expect(row.issues!.some((i) => i.code === 'textOverflowMeasured')).toBe(false);
    // Not a problem of the translation: the row and its render have none (only the outdated entry asks for "render anyway").
    expect(row.problems).toBeUndefined();
    expect(row.render!.problems).toBeUndefined();
    // Translated again (current): the new English source still overflows its box (the fake browser agrees with the estimate),
    // so the short German title is judged against it (N1): only the note, no problem, and the render keeps it a note.
    env.fake.overflows = [];
    await put(slug, 2, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    await done(await render(slug, 2, { formats: ['test-wide'], locales: ['de'] }));
    const after = (await env.versionOf(slug, 2))!.localizations!.find((r) => r.locale === 'de')!;
    // Translated now, the note says the original's layout overflows (not "untranslated or outdated").
    expect(after.issues).toEqual([{ code: 'sourceTextOverflow', clipId: 'title', message: v().sourceLayoutOverflow({ clip: 'Title' }) }]);
    expect(after.problems).toBeUndefined();
    expect(after.render!.problems).toBeUndefined();
  });

  it('the note of an outdated clip is cleared by the next render once the clip is translated and its source fits (F4)', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    const view = (await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/compositions/test-wide`, headers: H })).json() as { hash: string; composition: { tracks: Array<{ clips: Array<{ id: string; props: { text?: string } }> }> } };
    const c = structuredClone(view.composition);
    c.tracks.flatMap((t) => t.clips).find((k) => k.id === 'title')!.props.text = 'Goodbye';
    const e = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/edits`, headers: H,
      payload: { baseVersion: 1, format: 'test-wide', baseHash: view.hash, composition: c, staged: [], ops: [], token: 'A'.repeat(43) } });
    expect(e.statusCode, e.body).toBe(200);
    // The preview measure says the source fits; the render (showing the outdated clip's source) says it overflows.
    env.fake.measure = () => [];
    env.fake.overflows = ['title'];
    await done(await render(slug, 2, { formats: ['test-wide'], locales: ['de'], force: true }));
    const row = (await env.versionOf(slug, 2))!.localizations!.find((r) => r.locale === 'de')!;
    expect(row.issues).toEqual(expect.arrayContaining([{ code: 'sourceTextOverflow', clipId: 'title', message: v().sourceTextOverflow({ clip: 'Title' }) }]));
    env.fake.overflows = [];
    await put(slug, 2, 'de', 'test-wide', { texts: { title: 'Tschüss' } });
    await done(await render(slug, 2, { formats: ['test-wide'], locales: ['de'] }));
    const after = (await env.versionOf(slug, 2))!.localizations!.find((r) => r.locale === 'de')!;
    expect(after.issues ?? []).toEqual([]);
    expect(after.problems).toBeUndefined();
  });

  it('a carried row of a clip whose source already overflows: no problem and no force at render (fix round 2, N1, reviewer probe)', async () => {
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['de'] } });
    env.fake.measure = () => ['title'];
    const p = await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    expect(p.json().problems).toEqual([]);
    const dup = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/duplicate-format`, headers: H, payload: { instanceId: 'test-wide' } });
    expect(dup.statusCode, dup.body).toBe(200);
    // The carried row keeps the source note (its source text did not change).
    const carried = (await env.versionOf(slug, 2))!.localizations!.find((x) => x.locale === 'de' && x.instanceId === 'test-wide')!;
    expect(carried.issues).toEqual([{ code: 'sourceTextOverflow', clipId: 'title', message: v().sourceLayoutOverflow({ clip: 'Title' }) }]);
    env.fake.overflows = ['title'];
    // No force: the render's own measure of the source says it overflows too.
    await done(await render(slug, 2, { formats: ['test-wide'], locales: ['de'] }));
    const row = (await env.versionOf(slug, 2))!.localizations!.find((x) => x.locale === 'de' && x.instanceId === 'test-wide')!;
    expect(row.problems).toBeUndefined();
    expect(row.render!.problems).toBeUndefined();
  });

  it('the render takes the source verdict from the browser itself: a row with no note is not blamed for an overflowing source (fix round 2)', async () => {
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['de'] } });
    env.fake.measure = () => [];
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    expect((await env.versionOf(slug, 1))!.localizations![0]!.issues).toBeUndefined();
    // A new version of the same composition hash is not needed: the preset changes the verdict (another cache key), so the
    // render measures the source again. Here the browser now says the title overflows whatever its text.
    const f = await env.app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: [{ id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'], safeZone: { top: 0, bottom: 150, left: 0, right: 0 } }, { id: 'test-tall', channel: 'Test', name: 'Tall', width: 180, height: 320, kind: 'video', extensions: ['mp4'] }] } });
    expect(f.statusCode, f.body).toBe(200);
    env.fake.measure = () => ['title'];
    env.fake.overflows = ['title'];
    await done(await render(slug, 1, { formats: ['test-wide'], locales: ['de'] }));
    const row = (await env.versionOf(slug, 1))!.localizations!.find((x) => x.locale === 'de')!;
    expect(row.problems).toBeUndefined();
    expect(row.issues).toEqual([{ code: 'sourceTextOverflow', clipId: 'title', message: v().sourceLayoutOverflow({ clip: 'Title' }) }]);
  });

  it('the source measure of a follower\'s localized render uses the follower\'s own preset, as its render does (Q9)', async () => {
    // Two presets of the same size (a link needs it) whose safe zones differ (a follower's may only be the larger).
    const safeZone = { top: 5, bottom: 7, left: 11, right: 13 };
    const wide = { id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'], safeZone: { top: 20, bottom: 20, left: 20, right: 20 } };
    const f = await env.app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: [wide, { ...wide, id: 'test-wide-b', name: 'Wide B', safeZone }, { id: 'test-tall', channel: 'Test', name: 'Tall', width: 180, height: 320, kind: 'video', extensions: ['mp4'] }] } });
    expect(f.statusCode, f.body).toBe(200);
    const slug = await env.create(['test-wide', 'test-wide-b'], { links: { 'test-wide-b': 'test-wide' }, locales: { primary: 'en', extra: ['de'] } });
    expect((await put(slug, 1, 'de', 'test-wide-b', { texts: { title: 'Hallo' } })).statusCode).toBe(200);
    env.fake.frameCalls.length = 0;
    await done(await render(slug, 1, { formats: ['test-wide-b'], locales: ['de'] }));
    // Every measure of the source (the original text) carries the follower's safe zone, never the lead's.
    const sourceMeasures = env.fake.frameCalls.filter((c) => c.composition.tracks.flatMap((t) => t.clips).some((x) => x.type === 'text' && x.props.text === 'Hello'));
    expect(sourceMeasures.length).toBeGreaterThan(0);
    for (const c of sourceMeasures) expect(c.format.safeZone).toEqual(safeZone);
  });

  it('after carry, a source that fits while its translation overflows is still flagged at render (fix round 2)', async () => {
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['de'] } });
    // The browser: only a translated title overflows (the source "Hello" fits).
    env.fake.measure = (c) => (c.tracks.flatMap((t) => t.clips).some((x) => x.id === 'title' && x.type === 'text' && x.props.text !== 'Hello') ? ['title'] : []);
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' }, fit: { title: 1 } });
    const dup = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/duplicate-format`, headers: H, payload: { instanceId: 'test-wide' } });
    expect(dup.statusCode, dup.body).toBe(200);
    env.fake.overflows = ['title'];
    await done(await render(slug, 2, { formats: ['test-wide'], locales: ['de'], force: true }));
    const row = (await env.versionOf(slug, 2))!.localizations!.find((x) => x.locale === 'de' && x.instanceId === 'test-wide')!;
    expect(row.render!.problems).toEqual([v().textOverflowMeasured({ clip: 'Title', fit: 100 })]);
    expect(row.problems).toContain(v().textOverflowMeasured({ clip: 'Title', fit: 100 }));
  });

  it('a check that cannot run after the render is a problem, never a clean record', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    env.fake.after = (o) => { rmSync(o.out); };
    await done(await render(slug, 1, { formats: ['test-wide'], locales: ['de'] }));
    const row = (await env.versionOf(slug, 1))!.localizations!.find((r) => r.locale === 'de')!;
    expect(row.render!.problems).toEqual([v().renderCheckFailed({ file: 'test-wide.de.mp4' })]);
  });

  it('a translation rendered by the export with problems is excluded and listed (as the primary I2 rule), copied once seen', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    env.fake.overflows = ['title'];
    const r = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { destination: dest, picks: { 'test-wide': 1 }, locales: ['en', 'de'] } });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(readdirSync(dest)).toEqual(['launch-test-wide-v1.mp4']);
    expect(body.excluded).toEqual([{ format: 'test-wide', version: 1, locale: 'de', problems: [v().textOverflowMeasured({ clip: 'Title', fit: 100 })], issues: [] }]);
    expect(body.rendered).toEqual(expect.arrayContaining([{ version: 1, formats: ['test-wide'], locale: 'de' }]));
    // Asked again (the user has seen the problems): copied.
    const again = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { destination: dest, picks: { 'test-wide': 1 }, locales: ['de'] } });
    expect(again.statusCode, again.body).toBe(200);
    expect(readdirSync(dest).sort()).toEqual(['launch-test-wide-v1-de.mp4', 'launch-test-wide-v1.mp4']);
  });
});

describe('fallback font hashes (Ruling L)', { timeout: 120_000 }, () => {
  it('the row records the attached font\'s hash; a font file replaced afterwards fails the render and the export, never silently', async () => {
    const projectDir = env.projectDir();
    mkdirSync(join(projectDir, 'assets', 'fonts'), { recursive: true });
    const font = join(projectDir, 'assets', 'fonts', 'NotoSansJP-400.woff2');
    copyFileSync(FONT, font);
    await new LibraryStore(projectDir, NoMediaTools).registerAssets([{ file: 'fonts/NotoSansJP-400.woff2', origin: 'google-fonts', tags: ['font', 'Noto Sans JP'], description: 'Font Noto Sans JP' }]);
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['ja'] } });
    const p = await put(slug, 1, 'ja', 'test-wide', { texts: { title: 'こんにちは' } });
    expect(p.statusCode, p.body).toBe(200);
    const path = 'assets/fonts/NotoSansJP-400.woff2';
    const row = (await env.versionOf(slug, 1))!.localizations!.find((r) => r.locale === 'ja')!;
    expect(row.assetHashes).toEqual({ [path]: createHash('sha256').update(readFileSync(font)).digest('hex') });
    await done(await render(slug, 1, { locales: ['ja'], force: true }));
    writeFileSync(font, 'not the font any more');
    const r = await render(slug, 1, { locales: ['ja'], force: true });
    expect(r.statusCode, r.body).toBe(202);
    const job = await env.waitJob((r.json() as JobSummary).id);
    expect(job.state).toBe('failed');
    expect(job.error).toContain(v().assetChanged({ file: path }));
    expect((await env.versionOf(slug, 1))!.localizations!.find((x) => x.locale === 'ja')!.problems).toContain(v().assetChanged({ file: path }));
    // The export does not take the earlier render as current: it renders again, which fails, and says so.
    const e = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { destination: dest, picks: { 'test-wide': 1 }, locales: ['ja'], force: true } });
    expect(e.statusCode, e.body).toBe(409);
    expect(readdirSync(dest)).toEqual([]);
  });
});

describe('export per language', { timeout: 120_000 }, () => {
  const exportPicks = (slug: string, payload: object) => env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { destination: dest, ...payload } });

  it('exports the chosen languages with no pattern sent: the workspace default, as the dialog (Ruling R), rendering first', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    const r = await exportPicks(slug, { picks: { 'test-wide': 1 }, locales: ['en', 'de'], date: '2026-10-13' });
    expect(r.statusCode, r.body).toBe(200);
    // The original keeps today's name; the translation gets its language (the same names the dialog sends and shows).
    expect(readdirSync(dest).sort()).toEqual(['launch-test-wide-v1-de.mp4', 'launch-test-wide-v1.mp4']);
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
    expect(readdirSync(dest)).toEqual(['launch-test-wide-v1-de.mp4']);
    const none = await exportPicks(slug, { picks: { 'test-tall': 1 }, locales: ['de'] });
    expect(none.statusCode).toBe(409);
    expect(none.json().code).toBe('localization-missing');
    expect((await exportPicks(slug, { picks: { 'test-wide': 1 }, locales: ['he'] })).json().code).toBe('locale-rtl');
  });

  it('the primary tag of a creative without extra languages exports today\'s file', async () => {
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: [] } });
    const r = await exportPicks(slug, { picks: { 'test-wide': 1 }, locales: ['en'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(readdirSync(dest)).toEqual(['launch-test-wide-v1.mp4']);
  });

  it('a translated file replaced on disk is no longer current: rendered again before export', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    await done(await render(slug, 1, { formats: ['test-wide'], locales: ['de'] }));
    const before = env.fake.renders.length;
    writeFileSync(join(env.store().dir(slug), 'outputs', 'v1', 'test-wide.de.mp4'), 'replaced');
    const r = await exportPicks(slug, { picks: { 'test-wide': 1 }, locales: ['de'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(env.fake.renders.slice(before).map((x) => x.out.split('/').pop())).toContain('test-wide.de.mp4');
    expect(readFileSync(join(dest, readdirSync(dest)[0]!), 'utf8')).not.toBe('replaced');
  });

  it('export/prepare starts the translations\' renders too', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    const r = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export/prepare`, headers: H, payload: { picks: { 'test-wide': 1 }, locales: ['de'] } });
    expect(r.statusCode, r.body).toBe(200);
    const renders = r.json().renders as Array<{ version: number; formats: string[]; locales?: string[]; job: JobSummary }>;
    expect(renders.map((x) => [x.version, x.formats, x.locales])).toEqual([[1, ['test-wide'], ['de']]]);
    await env.waitJob(renders[0]!.job.id);
    expect(existsSync(join(env.store().dir(slug), 'outputs', 'v1', 'test-wide.de.mp4'))).toBe(true);
  });

  it('a translation exported alone with the workspace pattern is named with its language; the original keeps today\'s name (final review I2)', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    const pattern = '{title}-{format}-v{v}';
    const de = await exportPicks(slug, { picks: { 'test-wide': 1 }, locales: ['de'], pattern });
    expect(de.statusCode, de.body).toBe(200);
    expect(readdirSync(dest)).toEqual(['launch-test-wide-v1-de.mp4']);
    const en = await exportPicks(slug, { picks: { 'test-wide': 1 }, pattern });
    expect(en.statusCode, en.body).toBe(200);
    expect(readdirSync(dest).sort()).toEqual(['launch-test-wide-v1-de.mp4', 'launch-test-wide-v1.mp4']);
  });

  it('the default pattern sent by the dialog: with extra languages each translation gains its language, the original is unchanged', async () => {
    const slug = await create();
    await put(slug, 1, 'de', 'test-wide', { texts: { title: 'Hallo' } });
    const r = await exportPicks(slug, { picks: { 'test-wide': 1 }, locales: ['en', 'de'], pattern: DEFAULT_EXPORT_NAME_PATTERN });
    expect(r.statusCode, r.body).toBe(200);
    expect(readdirSync(dest).sort()).toEqual(['launch-test-wide-v1-de.mp4', 'launch-test-wide-v1.mp4']);
    rmSync(dest, { recursive: true, force: true });
    const plain = await env.create(['test-wide'], { links: {} });
    const p = await exportPicks(plain, { picks: { 'test-wide': 1 }, pattern: DEFAULT_EXPORT_NAME_PATTERN });
    expect(p.statusCode, p.body).toBe(200);
    expect(readdirSync(dest)).toEqual(['launch-test-wide-v1.mp4']);
  });

  it('without extra languages the names are today\'s', async () => {
    const slug = await env.create(['test-wide'], { links: {} });
    const r = await exportPicks(slug, { picks: { 'test-wide': 1 }, date: '2026-10-13' });
    expect(r.statusCode, r.body).toBe(200);
    expect(readdirSync(dest)).toEqual(['launch-test-wide-v1.mp4']);
  });
});
