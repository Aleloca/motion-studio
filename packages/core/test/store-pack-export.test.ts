// @vitest-environment node
/**
 * Store pack export (Phase 12, Task 6, spec §4.3, Review Focus 5): `POST …/versions/:n/store-pack/export` writes
 * `<title>-store-pack/{AppStore,GooglePlay}/[<locale>/]<device>/NN-<caption>.png`, the previews and the feature graphic, and a
 * README with the verified limits and their date, the upload order and the Google Play video note. Every file is checked
 * (size, PNG/JPEG, alpha, preview duration/fps/codec/audio) on the copy written; a failing file is removed and listed with its
 * translated reason, the rest is exported. The existing destination rules apply (absolute, outside the workspace, collisions).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages, STORE_LIMITS, type FormatPreset, type JobSummary, type StorePack } from '@motion-studio/shared';
import type { MediaInfo, MediaTools } from '../src/media/media-tools.ts';
import { currentLocale } from '../src/i18n.ts';
import { H, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';
import { makePng } from './helpers/store-images.ts';

// Store presets with the real ids and small sizes (each device a different size, as shipped: no links).
const STORE: FormatPreset[] = [
  { id: 'appstore-iphone-69', channel: 'App Store', name: 'iPhone', width: 66, height: 144, kind: 'image', extensions: ['png'] },
  { id: 'appstore-ipad-13', channel: 'App Store', name: 'iPad', width: 104, height: 138, kind: 'image', extensions: ['png'] },
  { id: 'appstore-preview', channel: 'App Store', name: 'Preview', width: 44, height: 96, kind: 'video', extensions: ['mp4'], maxDurationSec: 30 },
  { id: 'playstore-phone-9x16', channel: 'Play Store', name: 'Phone', width: 54, height: 96, kind: 'image', extensions: ['png'] },
  { id: 'playstore-tablet', channel: 'Play Store', name: 'Tablet', width: 80, height: 128, kind: 'image', extensions: ['png'] },
  { id: 'playstore-feature', channel: 'Play Store', name: 'Feature', width: 102, height: 50, kind: 'image', extensions: ['png'] },
  { id: 'playstore-promo-16x9', channel: 'Play Store', name: 'Promo', width: 96, height: 54, kind: 'video', extensions: ['mp4'] },
];

let env: InstanceEnv;
let dest: string;
/** What the fake probe reports for videos (the store check and the render's own description use it). */
let video: Partial<MediaInfo>;
/** Ids whose render is written with an alpha channel, or at a wrong size. */
let alphaIds: string[];
let wrongSizeIds: string[];

const fakeMedia: MediaTools = {
  available: true,
  async probe(file) {
    if (file.endsWith('.png')) {
      const b = readFileSync(file);
      return b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20), durationSec: null } : null;
    }
    // A fake video names its preset: `fake mp4 <id>` (the pack renames the file).
    const id = /^fake mp4 ([a-z0-9-]+)/.exec(readFileSync(file, 'latin1'))?.[1];
    const p = STORE.find((x) => x.id === id);
    return p ? { width: p.width, height: p.height, durationSec: 20, fps: 30, videoCodec: 'h264', audio: true, ...video } : null;
  },
  poster: async () => false,
  frame: async () => false,
};

beforeEach(async () => {
  video = {}; alphaIds = []; wrongSizeIds = [];
  env = await startInstanceEnv('ms-test-store-export-', { media: fakeMedia });
  dest = mkdtempSync(join(tmpdir(), 'ms-test-store-export-dest-'));
  const cur = (await env.app.inject({ url: '/api/formats', headers: H })).json() as { presets: FormatPreset[] };
  expect((await env.app.inject({ method: 'PUT', url: '/api/formats', headers: H, payload: { presets: [...cur.presets, ...STORE] } })).statusCode).toBe(200);
  env.fake.content = (o) => {
    if (!o.out.endsWith('.png')) return Buffer.from(`fake mp4 ${o.format.id.replace(/@\d+$/, '')}`);
    const id = o.out.split('/').pop()!.replace(/\.(de\.)?png$/, '');
    const wrong = wrongSizeIds.includes(id);
    return makePng(o.format.width + (wrong ? 2 : 0), o.format.height, alphaIds.includes(id) ? 6 : 2);
  };
  process.env.FAKE_CLAUDE_DURATION = '20';
});
afterEach(async () => { delete process.env.FAKE_CLAUDE_DURATION; await env?.close(); rmSync(dest, { recursive: true, force: true }); });

const c = () => messages(currentLocale()).variants.storePack.check;
const pack = (o: Partial<StorePack> = {}): StorePack => ({
  app: { name: 'Tasky', tagline: 'Plan your day' },
  stores: ['appstore', 'playstore'],
  devices: { appstore: ['iphone-69', 'ipad-13'], playstore: ['phone', 'feature'] },
  screenshots: [{ caption: 'All your tasks', screen: null }, { caption: 'Share with your team', screen: null }],
  preview: true,
  ...o,
});
async function createPack(p: StorePack, extra: object = {}): Promise<string> {
  const r = await env.app.inject({ method: 'POST', url: '/api/projects/acme/creatives/store-pack', headers: H, payload: { title: 'Tasky', storePack: p, generate: true, ...extra } });
  expect(r.statusCode, r.body).toBe(201);
  const job = r.json().job as JobSummary;
  const done = await env.waitJob(job.id);
  expect(done.state, done.error).toBe('succeeded');
  return r.json().slug as string;
}
const renderAll = async (slug: string, payload: object = {}) => {
  const r = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload });
  expect(r.statusCode, r.body).toBe(202);
  const done = await env.waitJob((r.json() as JobSummary).id);
  expect(done.state, done.error).toBe('succeeded');
};
const exportPack = (slug: string, payload: object = {}) =>
  env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/store-pack/export`, headers: H, payload: { destination: dest, ...payload } });
const tree = (root: string): string[] => readdirSync(root, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => relative(root, join(d.parentPath, d.name))).sort();

describe('store pack export', { timeout: 120_000 }, () => {
  it('without languages: the layout of spec §4.3 (no language level), NN-<caption> names, previews, feature graphic, README', async () => {
    const slug = await createPack(pack());
    const r = await exportPack(slug);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { folder: string; written: string[]; failed: unknown[]; rendered?: unknown[] };
    expect(body.folder).toBe(join(dest, 'tasky-store-pack'));
    expect(body.failed).toEqual([]);
    const files = [
      'AppStore/iPhone-6.9/01-all-your-tasks.png', 'AppStore/iPhone-6.9/02-share-with-your-team.png',
      'AppStore/iPad-13/01-all-your-tasks.png', 'AppStore/iPad-13/02-share-with-your-team.png',
      'AppStore/preview.mp4',
      'GooglePlay/Phone/01-all-your-tasks.png', 'GooglePlay/Phone/02-share-with-your-team.png',
      'GooglePlay/feature-graphic.png', 'GooglePlay/promo-video.mp4',
    ];
    expect([...body.written].sort()).toEqual([...files].sort());
    expect(tree(body.folder)).toEqual([...files, 'README.txt'].sort());
    // Rendered first (nothing was rendered yet), through the render pipeline.
    expect(body.rendered).toBeTruthy();
    // The bytes are the renders'.
    const ipad = readFileSync(join(body.folder, 'AppStore/iPad-13/02-share-with-your-team.png'));
    expect([ipad.readUInt32BE(16), ipad.readUInt32BE(20), ipad[25]]).toEqual([104, 138, 2]);
  });

  it('Phase 14: a store preset picked by hand in the same creative is not part of the pack export', async () => {
    const slug = await createPack(pack({ stores: ['appstore'], devices: { appstore: ['iphone-69'] }, preview: false }));
    const got = await env.app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H });
    const brief = (got.json() as { creative: { brief: Record<string, unknown> & { formats: string[] } } }).creative.brief;
    const put = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, headers: H, payload: { brief: { ...brief, links: undefined, formats: [...brief.formats, 'playstore-tablet'] } } });
    expect(put.statusCode, put.body).toBe(200);
    const r = await exportPack(slug);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { folder: string; written: string[]; failed: unknown[] };
    expect([...body.written].sort()).toEqual(['AppStore/iPhone-6.9/01-all-your-tasks.png', 'AppStore/iPhone-6.9/02-share-with-your-team.png']);
    expect(body.failed).toEqual([]);
  });

  it('with languages: one folder per language from the localized renders; a language without a translation is listed, the rest exported', async () => {
    const slug = await createPack(pack({ stores: ['appstore'], devices: { appstore: ['iphone-69'] }, preview: false }), { locales: { primary: 'en', extra: ['de'] } });
    // Only the first screenshot is translated.
    const put = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/versions/1/localizations/de/appstore-iphone-69`, headers: H, payload: { texts: { title: 'Hallo' } } });
    expect(put.statusCode, put.body).toBe(200);
    const r = await exportPack(slug);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { folder: string; written: string[]; failed: Array<{ file: string; reason: string }> };
    expect([...body.written].sort()).toEqual([
      'AppStore/de/iPhone-6.9/01-all-your-tasks.png',
      'AppStore/en/iPhone-6.9/01-all-your-tasks.png', 'AppStore/en/iPhone-6.9/02-share-with-your-team.png',
    ]);
    expect(body.failed).toEqual([{ file: 'AppStore/de/iPhone-6.9/02-share-with-your-team.png', reason: c().noTranslation({ locale: 'de' }) }]);
    // The German file is the localized render (outputs/v1/<instance>.de.png), not the English one.
    expect(env.fake.renders.some((x) => x.out.endsWith('/appstore-iphone-69.de.png'))).toBe(true);
    // Only the asked languages.
    const onlyDe = await exportPack(slug, { locales: ['de'] });
    expect(onlyDe.statusCode, onlyDe.body).toBe(200);
    expect((onlyDe.json() as { written: string[] }).written).toEqual(['AppStore/de/iPhone-6.9/01-all-your-tasks.png']);
  });

  it('Ruling J: a translation with open problems is not rendered silently: listed with its reason, the rest exported', async () => {
    const slug = await createPack(pack({ stores: ['appstore'], devices: { appstore: ['iphone-69'] }, preview: false, screenshots: [{ caption: 'One', screen: null }] }),
      { locales: { primary: 'en', extra: ['de'] } });
    const long = 'Herzlich willkommen zur brandneuen Version unserer wunderbaren Anwendung für alle Geräte';
    expect((await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/versions/1/localizations/de/appstore-iphone-69`, headers: H, payload: { texts: { title: long } } })).json().problems).toHaveLength(1);
    const body = (await exportPack(slug)).json() as { written: string[]; failed: Array<{ file: string; reason: string }> };
    expect(body.written).toEqual(['AppStore/en/iPhone-6.9/01-one.png']);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]!.file).toBe('AppStore/de/iPhone-6.9/01-one.png');
    expect(body.failed[0]!.reason.startsWith(c().renderFailed({ reason: '' }))).toBe(true);
    // A language that is not one of the creative's is refused before anything is written.
    expect((await exportPack(slug, { locales: ['fr'] })).statusCode).toBe(400);
  });

  it('partial failure: alpha, a wrong size and a 12 s preview are listed with their reasons and left out; the rest is exported', async () => {
    alphaIds = ['appstore-ipad-13'];
    wrongSizeIds = ['playstore-phone-9x16@2'];
    const slug = await createPack(pack());
    await renderAll(slug);
    video = { durationSec: 12 };
    const r = await exportPack(slug);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { folder: string; written: string[]; failed: Array<{ file: string; reason: string }> };
    const { minSec, maxSec } = STORE_LIMITS.appstore.preview;
    expect(body.failed).toEqual(expect.arrayContaining([
      { file: 'AppStore/iPad-13/01-all-your-tasks.png', reason: c().hasAlpha },
      { file: 'GooglePlay/Phone/02-share-with-your-team.png', reason: c().wrongSize({ width: 56, height: 96, expectedWidth: 54, expectedHeight: 96 }) },
      { file: 'AppStore/preview.mp4', reason: c().duration({ seconds: 12, min: minSec, max: maxSec }) },
    ]));
    expect(body.failed).toHaveLength(3);
    expect(body.written).toHaveLength(6);
    // A failing file is never left in the pack.
    const files = tree(body.folder);
    expect(files).not.toContain('AppStore/iPad-13/01-all-your-tasks.png');
    expect(files).not.toContain('AppStore/preview.mp4');
    expect(files).toContain('AppStore/iPad-13/02-share-with-your-team.png');
    expect(files).toContain('GooglePlay/promo-video.mp4');
    // The README lists them too.
    const readme = readFileSync(join(body.folder, 'README.txt'), 'utf8');
    expect(readme).toContain('AppStore/preview.mp4');
    expect(readme).toContain(c().hasAlpha);
  });

  it('I1: a pack format of the brief that the version lacks is listed as "not in version N" (and in the README)', async () => {
    const slug = await createPack(pack({ stores: ['appstore'], devices: { appstore: ['iphone-69'] }, preview: false }), { locales: { primary: 'en', extra: ['de'] } });
    // The pack gained a third screenshot after v1 (Phase 14: edited in the brief): v1 does not have its instance.
    const edited = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, headers: H,
      payload: { storePack: pack({ stores: ['appstore'], devices: { appstore: ['iphone-69'] }, preview: false, screenshots: [...pack().screenshots, { caption: 'Third', screen: null }] }) } });
    expect(edited.statusCode, edited.body).toBe(200);
    for (const inst of ['appstore-iphone-69', 'appstore-iphone-69@2']) {
      await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/versions/1/localizations/de/${encodeURIComponent(inst)}`, headers: H, payload: { texts: { title: 'Hallo' } } });
    }
    const body = (await exportPack(slug)).json() as { folder: string; written: string[]; failed: Array<{ file: string; reason: string }> };
    expect(body.written).toHaveLength(4);
    expect(body.failed).toEqual([
      { file: 'AppStore/en/iPhone-6.9/03-third.png', reason: c().notInVersion({ n: 1 }) },
      { file: 'AppStore/de/iPhone-6.9/03-third.png', reason: c().notInVersion({ n: 1 }) },
    ]);
    const readme = readFileSync(join(body.folder, 'README.txt'), 'utf8');
    expect(readme).toContain(`AppStore/en/iPhone-6.9/03-third.png: ${c().notInVersion({ n: 1 })}`);
  });

  const editBrief = (slug: string, f: (b: { formats: string[] }) => void) => {
    const file = join(env.store().dir(slug), 'creative.json');
    const cf = JSON.parse(readFileSync(file, 'utf8')) as { brief: { formats: string[]; formatLabels?: Record<string, string>; links?: Record<string, string> } };
    f(cf.brief);
    for (const k of ['formatLabels', 'links'] as const) {
      if (cf.brief[k]) cf.brief[k] = Object.fromEntries(Object.entries(cf.brief[k]!).filter(([a, b]) => cf.brief.formats.includes(a) && (k === 'formatLabels' || cf.brief.formats.includes(b))));
    }
    writeFileSync(file, JSON.stringify(cf));
  };
  const threeShots = () => pack({ stores: ['appstore'], devices: { appstore: ['iphone-69'] }, preview: false,
    screenshots: [{ caption: 'One', screen: null }, { caption: 'Two', screen: null }, { caption: 'Three', screen: null }] });

  it('numbers the screenshots by their place in the brief, and a removed one leaves no gap (Q6)', async () => {
    const slug = await createPack(threeShots());
    editBrief(slug, (b) => { b.formats = ['appstore-iphone-69@3', 'appstore-iphone-69']; });
    const res = await exportPack(slug);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { written: string[]; failed: unknown[] };
    // The caption stays with its instance; the number is the upload order of the brief.
    expect([...body.written].sort()).toEqual(['AppStore/iPhone-6.9/01-three.png', 'AppStore/iPhone-6.9/02-one.png']);
    expect(body.failed).toEqual([]);
  });

  it('checks the number of screenshots per device against the store (Q6)', async () => {
    const slug = await createPack(pack({ stores: ['playstore'], devices: { playstore: ['phone'] }, preview: false }));
    editBrief(slug, (b) => { b.formats = ['playstore-phone-9x16']; });
    const few = (await exportPack(slug)).json() as { failed: Array<{ file: string; reason: string }> };
    expect(few.failed).toEqual([{ file: 'GooglePlay/Phone', reason: c().tooFewScreenshots({ count: 1, min: 2 }) }]);
    // More screenshots than a store takes cannot come from a pack any more (its schema stops at 8): the check stays in `exportStorePack`.
  });

  it('a preview without an audio track is refused at export (the render adds one: store-flatten)', async () => {
    const slug = await createPack(pack({ stores: ['appstore'], devices: { appstore: ['iphone-69'] } }));
    await renderAll(slug);
    video = { audio: false };
    const body = (await exportPack(slug)).json() as { failed: Array<{ file: string; reason: string }> };
    expect(body.failed).toEqual([{ file: 'AppStore/preview.mp4', reason: c().noAudio }]);
  });

  it('README: verified limits and their date, the sources, the upload order, the Google Play video note', async () => {
    const slug = await createPack(pack());
    const body = (await exportPack(slug)).json() as { folder: string };
    const readme = readFileSync(join(body.folder, 'README.txt'), 'utf8');
    const rm = messages(currentLocale()).variants.storePack.readme;
    expect(readme).toContain(rm.title({ app: 'Tasky' }));
    expect(readme).toContain(rm.limits({ date: STORE_LIMITS.checkedOn }));
    for (const url of STORE_LIMITS.sources) expect(readme).toContain(url);
    const pv = STORE_LIMITS.appstore.preview;
    expect(readme).toContain(rm.appStorePreview({ min: pv.minSec, max: pv.maxSec, fps: pv.fps, maxMB: pv.maxFileMB, perDevice: pv.maxPerDevice }));
    expect(readme).toContain('66×144'); // the iPhone size of the catalog
    expect(readme).toContain(rm.order);
    expect(readme).toContain(rm.orderAppStore);
    expect(readme).toContain(rm.orderPlay);
    expect(readme).toContain(rm.playVideo);
    expect(readme).not.toContain(rm.failedTitle);
  });

  it('a pack without Google Play has no Play video note; without a preview no preview line', async () => {
    const slug = await createPack(pack({ stores: ['appstore'], devices: { appstore: ['iphone-69'] }, preview: false }));
    const body = (await exportPack(slug)).json() as { folder: string };
    const readme = readFileSync(join(body.folder, 'README.txt'), 'utf8');
    const rm = messages(currentLocale()).variants.storePack.readme;
    expect(readme).not.toContain(rm.playVideo);
    expect(readme).not.toContain(rm.orderPreview);
  });

  it('captions never traverse: hostile captions become plain names inside the pack', async () => {
    const slug = await createPack(pack({ stores: ['appstore'], devices: { appstore: ['iphone-69'] }, preview: false,
      screenshots: [{ caption: '../../../etc/passwd', screen: null }, { caption: '..\\..\\évasion/ÜBER', screen: null }, { caption: '...', screen: null }] }));
    const body = (await exportPack(slug)).json() as { folder: string; written: string[] };
    expect(body.written).toEqual(['AppStore/iPhone-6.9/01-etc-passwd.png', 'AppStore/iPhone-6.9/02-evasion-uber.png', 'AppStore/iPhone-6.9/03-screenshot.png']);
    expect(tree(dest).every((f) => f.startsWith('tasky-store-pack/'))).toBe(true);
  });

  it('a second export never overwrites: a new pack folder (-2)', async () => {
    const slug = await createPack(pack({ stores: ['appstore'], devices: { appstore: ['iphone-69'] }, preview: false }));
    expect((await exportPack(slug)).statusCode).toBe(200);
    const second = (await exportPack(slug)).json() as { folder: string };
    expect(second.folder).toBe(join(dest, 'tasky-store-pack-2'));
    expect(existsSync(join(dest, 'tasky-store-pack', 'README.txt'))).toBe(true);
  });

  it('destination rules: relative or inside the workspace refused; a creative that is not a pack refused', async () => {
    const slug = await createPack(pack({ stores: ['appstore'], devices: { appstore: ['iphone-69'] }, preview: false }));
    expect((await exportPack(slug, { destination: 'relative/dir' })).statusCode).toBe(400);
    expect((await exportPack(slug, { destination: join(env.ws, 'inside') })).statusCode).toBe(400);
    expect(existsSync(join(env.ws, 'inside'))).toBe(false);
    const plain = await env.create(['test-wide'], { links: {} });
    const r = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${plain}/versions/1/store-pack/export`, headers: H, payload: { destination: dest } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('not-store-pack');
    expect((await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/9/store-pack/export`, headers: H, payload: { destination: dest } })).statusCode).toBe(404);
  });
});
