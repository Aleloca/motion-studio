// @vitest-environment node
/**
 * The store pack as an entry of the formats list (Phase 14, Task 6, spec §3, Review Focus 4): `mergeStorePack` recomputes only
 * the pack's instances (those `storePackFormats(prev)` lists); a hand-picked store preset and the other formats keep their place
 * and labels; the versions of removed instances stay in the history; a pack is edited through `storePack`, and only one exists.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { storePackFormats, withAgentNames, type Brief, type CreativeFile, type StorePack } from '@motion-studio/shared';
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

describe('mergeStorePack keeps the agent\'s screenshot names (report 55)', () => {
  it('a wizard edit keeps the names the agent gave screenshots with no caption; a caption the user types wins', () => {
    const p = pack(3, { screenshots: [{ caption: '', screen: null }, { caption: '', screen: null }, { caption: 'Mine', screen: null }] });
    const f = storePackFormats(p);
    const start: Brief = { goal: 'g', message: '', durationSec: null, assets: [], notes: '', storePack: { ...p, instances: f.formats }, formats: f.formats, formatLabels: f.formatLabels };
    const named = withAgentNames(start, { [PHONE(1)]: 'Tutti i clienti', [PHONE(2)]: 'Promemoria' }).brief;
    const r = mergeStorePack(named, { ...p, screenshots: [{ caption: '', screen: null }, { caption: 'Avvisi puntuali', screen: null }, { caption: 'Mine', screen: null }, { caption: '', screen: null }] });
    expect(r.brief.formatLabels).toEqual({ [PHONE(1)]: '1 · Tutti i clienti', [PHONE(2)]: '2 · Avvisi puntuali', [PHONE(3)]: '3 · Mine', [PHONE(4)]: '4' });
    expect(r.brief.agentFormatLabels).toEqual({ [PHONE(1)]: '1 · Tutti i clienti' });
    // The pack taken out: its labels and the agent's record of them go.
    const out = mergeStorePack({ ...r.brief, formats: [YT, ...r.brief.formats] }, null);
    expect(out.brief.agentFormatLabels).toBeUndefined();
  });

  it('review: a wizard edit keeps the user\'s own name of a screenshot without a caption, and of one whose caption did not change', () => {
    const p = pack(3, { screenshots: [{ caption: '', screen: null }, { caption: 'Two', screen: null }, { caption: 'Three', screen: null }] });
    const f = storePackFormats(p);
    const start: Brief = {
      goal: 'g', message: '', durationSec: null, assets: [], notes: '', storePack: { ...p, instances: f.formats }, formats: f.formats,
      formatLabels: { ...f.formatLabels, [PHONE(1)]: 'Mio uno', [PHONE(2)]: 'Mio due', [PHONE(3)]: 'Mio tre' },
    };
    // Screenshot 1 still has no caption, 2 keeps its caption, 3 gets a new one (the new caption wins); a 4th is added.
    const r = mergeStorePack(start, { ...p, screenshots: [{ caption: '', screen: null }, { caption: 'Two', screen: null }, { caption: 'Three, new', screen: null }, { caption: '', screen: null }] });
    expect(r.brief.formatLabels).toEqual({ [PHONE(1)]: 'Mio uno', [PHONE(2)]: 'Mio due', [PHONE(3)]: '3 · Three, new', [PHONE(4)]: '4' });
    // A caption taken away: the user's own name stays too.
    const r2 = mergeStorePack(start, { ...p, screenshots: [{ caption: '', screen: null }, { caption: '', screen: null }, { caption: 'Three', screen: null }] });
    expect(r2.brief.formatLabels).toMatchObject({ [PHONE(2)]: 'Mio due', [PHONE(3)]: 'Mio tre' });
  });
});

describe('mergeStorePack (Review Focus 4)', () => {
  it('mixed creative: reducing 5 to 3 removes only pack instances; the hand-picked one and YouTube keep place and label', () => {
    const r = mergeStorePack(mixed(), pack(3));
    expect(r.removed).toEqual([PHONE(4), PHONE(5)]);
    expect(r.added).toEqual([]);
    expect(r.brief.formats).toEqual([YT, HAND, PHONE(1), PHONE(2), PHONE(3)]);
    expect(r.brief.formatLabels).toEqual({ [HAND]: 'My own', [YT]: 'Teaser', [PHONE(1)]: '1 · Caption 1', [PHONE(2)]: '2 · Caption 2', [PHONE(3)]: '3 · Caption 3' });
    expect(r.brief.storePack).toEqual({ ...pack(3), instances: [1, 2, 3].map(PHONE) });
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

  it('never adopts: an old pack (no instances) grown over a hand-picked @6 gets the next free ids; shrinking and removing touch only owned ids', () => {
    const b: Brief = { ...mixed(), formats: [...mixed().formats, PHONE(6)], formatLabels: { ...mixed().formatLabels, [PHONE(6)]: 'Mine' } };
    const grown = mergeStorePack(b, pack(7));
    expect(grown.added).toEqual([PHONE(7), PHONE(8)]);
    expect(grown.brief.storePack!.instances).toEqual([1, 2, 3, 4, 5, 7, 8].map(PHONE));
    expect(grown.brief.formatLabels![PHONE(6)]).toBe('Mine');
    expect(grown.brief.formatLabels![PHONE(7)]).toBe('6 · Caption 6');
    expect(grown.brief.formatLabels![PHONE(8)]).toBe('7 · Caption 7');
    // Shrink to 3: the owned @4 @5 @7 @8 go, the hand-picked @6 stays with its label.
    const shrunk = mergeStorePack(grown.brief, pack(3));
    expect(shrunk.removed).toEqual([PHONE(4), PHONE(5), PHONE(7), PHONE(8)]);
    expect(shrunk.brief.formats).toEqual([YT, HAND, PHONE(1), PHONE(2), PHONE(3), PHONE(6)]);
    expect(shrunk.brief.formatLabels![PHONE(6)]).toBe('Mine');
    const gone = mergeStorePack(shrunk.brief, null);
    expect(gone.removed).toEqual([1, 2, 3].map(PHONE));
    expect(gone.brief.formats).toEqual([YT, HAND, PHONE(6)]);
    expect(gone.brief.formatLabels).toEqual({ [HAND]: 'My own', [YT]: 'Teaser', [PHONE(6)]: 'Mine' });
  });

  it('refuses only a real impossibility: a preset with no free instance left, and the last format', () => {
    const full: Brief = { ...mixed(), storePack: undefined, formats: [YT, ...Array.from({ length: 20 }, (_, i) => PHONE(i + 1))], formatLabels: {} };
    expect(() => mergeStorePack(full, pack(2))).toThrowError(expect.objectContaining({ apiCode: 'store-pack-collision', message: expect.stringContaining('playstore-phone-9x16') }));
    const only = storePackBrief(pack(2), { locale: 'en' });
    expect(() => mergeStorePack(only, null)).toThrowError(expect.objectContaining({ apiCode: 'store-pack-last-format' }));
  });

  it('recomputes what the pack derived: assets, the preview length, goal and message (only while the user has not changed them)', () => {
    const old = pack(2, { screenshots: [{ caption: 'A', screen: 'assets/a.png' }, { caption: 'B', screen: 'assets/b.png' }] });
    const made = storePackBrief(old, { locale: 'en' });
    const b: Brief = { ...made, assets: [...made.assets, 'assets/mine.png'] };
    const next = pack(2, { preview: true, screenshots: [{ caption: 'A2', screen: 'assets/a.png' }, { caption: 'B', screen: 'assets/c.png' }] });
    const r = mergeStorePack(b, next, undefined, 'en');
    expect(r.brief.durationSec).toBe(20);
    expect(r.brief.assets).toEqual(['assets/mine.png', 'assets/a.png', 'assets/c.png']);
    expect(r.brief.message).toBe(storePackBrief(next, { locale: 'en' }).message);
    expect(r.kept).toEqual([]);
    // Preview off again: the pack's 20 s goes; a manual message is kept and named.
    const edited = mergeStorePack({ ...r.brief, message: 'My own message' }, pack(2), undefined, 'en');
    expect(edited.brief.durationSec).toBeNull();
    expect(edited.brief.message).toBe('My own message');
    expect(edited.kept).toContain('message');
    // A length the user set (not null) is not replaced by the preview's.
    const own = mergeStorePack({ ...b, durationSec: 12 }, next, undefined, 'en');
    expect(own.brief.durationSec).toBe(12);
    expect(own.kept).toContain('durationSec');
  });

  it('switching a pack from the App Store to Google Play removes the App Store instances and adds the Play ones', () => {
    const apple = pack(2, { stores: ['appstore'], devices: { appstore: ['iphone-69'] } });
    const b: Brief = { ...storePackBrief(apple, { locale: 'en' }), formats: [YT, ...storePackFormats(apple).formats] };
    const r = mergeStorePack(b, pack(2));
    expect(r.removed).toEqual(['appstore-iphone-69', 'appstore-iphone-69@2']);
    expect(r.added).toEqual([PHONE(1), PHONE(2)]);
    expect(r.brief.formats).toEqual([YT, PHONE(1), PHONE(2)]);
    expect(r.brief.formatLabels).toEqual({ [PHONE(1)]: '1 · Caption 1', [PHONE(2)]: '2 · Caption 2' });
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
    expect(creative.brief.storePack).toEqual({ ...pack(2), instances: [PHONE(1), PHONE(2)] });

    // With explicit instances (a picked PHONE(1) sits beside the pack's), they must match the slots.
    const mine = await create({ ...pack(2), instances: [PHONE(2), PHONE(3)] }, [YT, PHONE(1), PHONE(2), PHONE(3)]);
    expect(mine.statusCode, mine.body).toBe(201);
    expect((mine.json() as { creative: CreativeFile }).creative.brief.storePack!.instances).toEqual([PHONE(2), PHONE(3)]);
    const wrong = await create({ ...pack(2), instances: [PHONE(2), 'instagram-post-1x1'] }, [YT, PHONE(2), 'instagram-post-1x1']);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe('store-pack-instances');
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
    const second = await put(slug, { brief: { ...sent, storePack: pack(2) } });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('store-pack-second');
    const same = await put(slug, { brief: { ...sent, goal: 'new goal' } });
    expect(same.statusCode, same.body).toBe(200);
    expect((same.json() as CreativeFile).brief.storePack).toEqual({ ...pack(3), instances: [1, 2, 3].map(PHONE) });

    // A screen that is not in the library is refused before anything changes.
    const badScreen = await put(slug, { storePack: pack(3, { screenshots: [{ caption: 'A', screen: 'assets/missing.png' }, ...shots(2)] }) });
    expect(badScreen.statusCode).toBe(400);

    const gone = await put(slug, { storePack: null });
    expect(gone.statusCode, gone.body).toBe(200);
    const final = gone.json() as CreativeFile;
    expect(final.brief.formats).toEqual([YT, HAND]);
    expect(final.brief.storePack).toBeUndefined();
    expect(final.brief.formatLabels).toEqual({ [HAND]: 'My own' });
    // The last format cannot go; a pack sent with a whole brief on a creative without one says to use the entry.
    const lone = await env.app.inject({ method: 'POST', url: '/api/projects/acme/creatives/store-pack', headers: H, payload: { title: 'Lone', storePack: pack(2) } });
    expect(lone.statusCode).toBe(201);
    const loneSlug = (lone.json() as { slug: string }).slug;
    const last = await put(loneSlug, { storePack: null });
    expect(last.statusCode).toBe(409);
    expect(last.json().code).toBe('store-pack-last-format');
    const plain = await create(pack(2), [YT]).then((r) => (r.json() as { slug: string }).slug);
    await put(plain, { storePack: null });
    const nopack = await put(plain, { brief: { goal: 'g', message: '', formats: [YT], durationSec: null, assets: [], notes: '', storePack: pack(2) } });
    expect(nopack.statusCode).toBe(409);
    expect(nopack.json().message ?? nopack.json().error).toMatch(/storePack/);
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
