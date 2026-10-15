// @vitest-environment node
/**
 * The store pack as an entry of the formats list (Phase 14, Task 6, spec §3, Review Focus 4): `mergeStorePack` recomputes only
 * the pack's instances (those `storePackFormats(prev)` lists); a hand-picked store preset and the other formats keep their place
 * and labels; the versions of removed instances stay in the history; a pack is edited through `storePack`, and only one exists.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { storePackFormats, type Brief, type CreativeFile, type StorePack } from '@motion-studio/shared';
import { mergeStorePack, storePackBrief } from '../src/store-pack/brief.ts';
import { H, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

const shots = (n: number) => Array.from({ length: n }, (_, i) => ({ caption: `Caption ${i + 1}`, screen: null }));
const pack = (n: number, over: Partial<StorePack> = {}): StorePack => ({
  app: { name: 'Tasky', tagline: '' }, stores: ['playstore'], devices: { playstore: ['phone'] }, screenshots: shots(n), preview: false, ...over,
});
const PHONE = (n: number) => (n === 1 ? 'playstore-phone-9x16' : `playstore-phone-9x16@${n}`);
const YT = 'youtube-16x9';
const HAND = 'appstore-iphone-69@3';

/** A mixed brief: YouTube first, a hand-picked store screenshot, then a 5-screenshot Google Play pack. */
const mixed = (): Brief => {
  const p = pack(5);
  const f = storePackFormats(p);
  return {
    goal: 'g', message: '', durationSec: null, assets: [], notes: '', storePack: p,
    formats: [YT, HAND, ...f.formats], formatLabels: { [HAND]: 'My own', [YT]: 'Teaser', ...f.formatLabels }, links: {},
  };
};

describe('mergeStorePack (Review Focus 4)', () => {
  it('mixed creative: reducing 5 to 3 removes only pack instances; the hand-picked one and YouTube keep place and label', () => {
    const r = mergeStorePack(mixed(), pack(3));
    expect(r.removed).toEqual([PHONE(4), PHONE(5)]);
    expect(r.added).toEqual([]);
    expect(r.brief.formats).toEqual([YT, HAND, PHONE(1), PHONE(2), PHONE(3)]);
    expect(r.brief.formatLabels).toEqual({ [HAND]: 'My own', [YT]: 'Teaser', [PHONE(1)]: '1 · Caption 1', [PHONE(2)]: '2 · Caption 2', [PHONE(3)]: '3 · Caption 3' });
    expect(r.brief.storePack).toEqual(pack(3));
  });

  it('growing adds instances after the last pack instance and relabels the captions that changed', () => {
    const grown = { ...pack(4), screenshots: [{ caption: 'Renamed', screen: null }, ...shots(4).slice(1)] };
    const r = mergeStorePack(mixed(), grown);
    expect(r.added).toEqual([]);
    const shrunk = mergeStorePack(mixed(), pack(3)).brief;
    const again = mergeStorePack(shrunk, grown);
    expect(again.added).toEqual([PHONE(4)]);
    expect(again.brief.formats).toEqual([YT, HAND, PHONE(1), PHONE(2), PHONE(3), PHONE(4)]);
    expect(again.brief.formatLabels![PHONE(1)]).toBe('1 · Renamed');
    expect(again.brief.formatLabels![HAND]).toBe('My own');
  });

  it('removing the pack takes out every pack instance and its labels and nothing else', () => {
    const r = mergeStorePack(mixed(), null);
    expect(r.removed).toEqual([1, 2, 3, 4, 5].map(PHONE));
    expect(r.brief.formats).toEqual([YT, HAND]);
    expect(r.brief.formatLabels).toEqual({ [HAND]: 'My own', [YT]: 'Teaser' });
    expect(r.brief.storePack).toBeUndefined();
  });

  it('setting a pack on a creative without one appends its instances and keeps the other formats', () => {
    const b: Brief = { ...mixed(), storePack: undefined, formats: [YT, HAND], formatLabels: { [HAND]: 'My own' } };
    const r = mergeStorePack(b, pack(2));
    expect(r.added).toEqual([PHONE(1), PHONE(2)]);
    expect(r.brief.formats).toEqual([YT, HAND, PHONE(1), PHONE(2)]);
    expect(r.brief.formatLabels).toEqual({ [HAND]: 'My own', [PHONE(1)]: '1 · Caption 1', [PHONE(2)]: '2 · Caption 2' });
  });

  it('a hand-picked instance the pack would need is refused, never taken over; the last format cannot go', () => {
    const b: Brief = { ...mixed(), storePack: undefined, formats: [YT, PHONE(2)], formatLabels: {} };
    expect(() => mergeStorePack(b, pack(3))).toThrowError(/playstore-phone-9x16@2/);
    const only = storePackBrief(pack(2), { locale: 'en' });
    expect(() => mergeStorePack(only, null)).toThrowError();
  });

  it('a legacy store-pack brief (made by the old route) is edited the same way', () => {
    const legacy = storePackBrief(pack(3), { locale: 'en' });
    const r = mergeStorePack(legacy, pack(3, { preview: true }));
    expect(r.added).toEqual(['playstore-promo-16x9']);
    expect(r.brief.formats).toEqual([PHONE(1), PHONE(2), PHONE(3), 'playstore-promo-16x9']);
  });
});

describe('the routes', { timeout: 60_000 }, () => {
  let env: InstanceEnv;
  afterEach(async () => { await env?.close(); });
  const put = (c: string, payload: object) => env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${c}`, headers: H, payload });
  const create = (storePack: StorePack, formats: string[]) => env.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', headers: H,
    payload: { title: 'Mixed', generate: false, brief: { goal: 'g', message: '', formats, durationSec: null, assets: [], notes: '', storePack } } });

  it('create with a pack: the pack route is not needed; a pack missing its instances is completed; a bad screen is refused', async () => {
    env = await startInstanceEnv('ms-test-store-merge-');
    const bad = await create(pack(2, { screenshots: [{ caption: 'A', screen: 'assets/nope.png' }, ...shots(1)] }), [YT]);
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().code).toBe('store-pack-screen');
    const r = await create(pack(2), [YT]);
    expect(r.statusCode, r.body).toBe(201);
    const { creative } = r.json() as { creative: CreativeFile };
    expect(creative.brief.formats).toEqual([YT, PHONE(1), PHONE(2)]);
    expect(creative.brief.formatLabels).toEqual({ [PHONE(1)]: '1 · Caption 1', [PHONE(2)]: '2 · Caption 2' });
    expect(creative.brief.storePack).toEqual(pack(2));
  });

  it('edit and remove through PUT { storePack }; versions of removed instances stay; a second pack is refused', async () => {
    env = await startInstanceEnv('ms-test-store-merge-');
    const p5 = pack(5);
    const made = await create(p5, [YT, HAND, ...storePackFormats(p5).formats]);
    const slug = (made.json() as { slug: string }).slug;
    await put(slug, { formatLabels: { [HAND]: 'My own' } });
    const out = (format: string) => ({ format, file: `${format}.png`, width: 10, height: 10, durationSec: null, verified: true, preview: null, sha256: 'b'.repeat(64), problems: [] });
    await env.store().appendVersion(slug, { n: 1, commit: null, sessionId: null, status: 'complete', createdAt: new Date().toISOString(), request: 'r', problems: [], tools: [],
      renderCommand: null, basedOn: null, outputs: [out(PHONE(5)), out(HAND)] });

    const r = await put(slug, { storePack: pack(3) });
    expect(r.statusCode, r.body).toBe(200);
    const after = r.json() as CreativeFile;
    expect(after.brief.formats).toEqual([YT, HAND, PHONE(1), PHONE(2), PHONE(3)]);
    expect(after.brief.formatLabels![HAND]).toBe('My own');
    // History keeps the version of the removed instance; the freed id starts clean.
    expect((await env.store().readVersions(slug))[0]!.outputs.map((o) => o.format)).toEqual([PHONE(5), HAND]);
    expect(after.freedInstances).toMatchObject({ [PHONE(5)]: 1, [PHONE(4)]: 1 });

    // A full brief save with another pack is a second pack: refused. The same pack (an editor's save) is kept.
    const sent = { ...after.brief, links: undefined };
    expect((await put(slug, { brief: { ...sent, storePack: pack(2) } })).statusCode).toBe(409);
    const same = await put(slug, { brief: { ...sent, goal: 'new goal' } });
    expect(same.statusCode, same.body).toBe(200);
    expect((same.json() as CreativeFile).brief.storePack).toEqual(pack(3));

    // A screen that is not in the library is refused before anything changes.
    const badScreen = await put(slug, { storePack: pack(3, { screenshots: [{ caption: 'A', screen: 'assets/missing.png' }, ...shots(2)] }) });
    expect(badScreen.statusCode).toBe(400);

    const gone = await put(slug, { storePack: null });
    expect(gone.statusCode, gone.body).toBe(200);
    const final = gone.json() as CreativeFile;
    expect(final.brief.formats).toEqual([YT, HAND]);
    expect(final.brief.storePack).toBeUndefined();
    expect(final.brief.formatLabels).toEqual({ [HAND]: 'My own' });
    // The partial field does not mix with a full brief.
    expect((await put(slug, { storePack: pack(2), formats: [YT] })).statusCode).toBe(400);
  });

  it('the old store-pack route still creates a pack creative', async () => {
    env = await startInstanceEnv('ms-test-store-merge-');
    const r = await env.app.inject({ method: 'POST', url: '/api/projects/acme/creatives/store-pack', headers: H, payload: { title: 'Old way', storePack: pack(2) } });
    expect(r.statusCode, r.body).toBe(201);
    const { creative, slug } = r.json() as { creative: CreativeFile; slug: string };
    expect(creative.brief.formats).toEqual([PHONE(1), PHONE(2)]);
    // ...and it edits like any other.
    const e = await put(slug, { storePack: pack(2, { preview: true }) });
    expect((e.json() as CreativeFile).brief.formats).toEqual([PHONE(1), PHONE(2), 'playstore-promo-16x9']);
  });
});
