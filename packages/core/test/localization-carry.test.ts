// @vitest-environment node
/**
 * Carry-over of localization overlays into a new version (Phase 12, Task 3, spec §3.3, Review Focus 2): kept, stale,
 * dropped, voice stale, for every way a version is made (turns, duplicates; direct edits share `finishCompositions`).
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Composition, FormatPreset, VersionEntry } from '@motion-studio/shared';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { currentLocale } from '../src/i18n.ts';
import { carryLocalizations } from '../src/localization/carry.ts';
import { emptyOverlay, instanceComposition, readOverlay, writeOverlay, type InstanceComposition } from '../src/localization/store.ts';
import { H, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

const PRESETS: FormatPreset[] = [{ id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'] }];

describe('carryLocalizations', () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ms-test-l10n-carry-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  const comp = (o: { title?: string | null; sub?: string; script?: string }): Composition => ({
    $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 2, background: '#101010', fonts: [{ family: 'Mono', src: 'assets/Mono.woff2', weight: 400 }], scenes: [],
    tracks: [
      { id: 'v', kind: 'visual', clips: [
        ...(o.title === null ? [] : [{ id: 'title', name: 'Title', type: 'text', start: 0, duration: 2, props: { x: 10, y: 10, width: 200, height: 40, text: o.title ?? 'Hello', fontSize: 20, color: '#ffffff' } }]),
        { id: 'sub', type: 'text', start: 0, duration: 2, props: { x: 10, y: 60, width: 200, height: 40, text: o.sub ?? 'World', fontSize: 20, color: '#ffffff' } },
      ] },
      { id: 'a', kind: 'audio', clips: [{ id: 'vo', type: 'audio', role: 'voice', src: 'assets/vo.mp3', start: 0, duration: 2, script: o.script ?? 'Hello world' }] },
    ],
  } as unknown as Composition);
  const folder = async (n: number, c: Composition, files: Record<string, string> = {}) => {
    const dir = join(base, 'outputs', `v${n}`, 'compositions', 'test-wide');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'vo.mp3'), 'mp3');
    writeFileSync(join(dir, 'assets', 'Mono.woff2'), 'wOF2');
    for (const [p, body] of Object.entries(files)) writeFileSync(join(dir, ...p.split('/')), body);
    writeFileSync(join(dir, 'composition.json'), JSON.stringify(c));
    return { n, compositions: [{ format: 'test-wide', dir: 'compositions/test-wide', hash: (await readCompositionFolder(dir)).hash }] } as VersionEntry;
  };
  const ic = async (v: VersionEntry): Promise<InstanceComposition> => (await instanceComposition(base, v, 'test-wide', PRESETS))!;

  /** Version 1 with the German overlay of both texts and the voice, then version 2 from `next`. */
  async function carry(next: Composition, nextFiles: Record<string, string> = {}) {
    const v1 = await folder(1, comp({}), { 'assets/vo-de.mp3': 'de' });
    const overlay = {
      ...emptyOverlay('de', 'test-wide'),
      texts: { title: { source: 'Hello', text: 'Hallo' }, sub: { source: 'World', text: 'Welt' } }, fit: { title: 0.9, sub: 0.95 },
      voices: { vo: { src: 'assets/vo-de.mp3', script: 'Hallo Welt', sourceScript: 'Hello world' } },
    };
    const hash = await writeOverlay(base, 1, overlay);
    v1.localizations = [{ locale: 'de', instanceId: 'test-wide', hash, origin: 'agent', stale: [], voice: 'translated' }];
    const v2 = await folder(2, next, nextFiles);
    const rows = await carryLocalizations({ creativeDir: base, n: 1, version: v1 }, { creativeDir: base, n: 2 }, new Map([['test-wide', await ic(v2)]]), { projectDir: base, uiLocale: currentLocale() });
    return { rows, carried: rows ? await readOverlay(base, 2, 'de', 'test-wide') : null, before: readFileSync(join(base, 'outputs', 'v1', 'locales', 'de', 'test-wide.json'), 'utf8'), overlay };
  }

  it('keeps the entries whose source is unchanged (same file content, a new row with its hash)', async () => {
    const { rows, carried, overlay } = await carry(comp({}), { 'assets/vo-de.mp3': 'de' });
    expect(carried!.overlay).toEqual(overlay);
    expect(rows).toEqual([{ locale: 'de', instanceId: 'test-wide', hash: carried!.hash, origin: 'agent', stale: [], voice: 'translated' }]);
  });

  it('a text whose source changed becomes stale (its translation kept, the source shown); the previous version is untouched', async () => {
    const { rows, carried, before } = await carry(comp({ title: 'Hello there' }), { 'assets/vo-de.mp3': 'de' });
    expect(rows![0]!.stale).toEqual(['title']);
    expect(rows![0]!.issues).toEqual([expect.objectContaining({ code: 'stale', clipId: 'title' })]);
    expect(rows![0]!.problems).toBeUndefined();
    expect(carried!.overlay.texts.title).toEqual({ source: 'Hello', text: 'Hallo' });
    expect(readFileSync(join(base, 'outputs', 'v1', 'locales', 'de', 'test-wide.json'), 'utf8')).toBe(before);
  });

  it('an entry whose clip is gone is dropped, with its fit', async () => {
    const { rows, carried } = await carry(comp({ title: null }), { 'assets/vo-de.mp3': 'de' });
    expect(Object.keys(carried!.overlay.texts)).toEqual(['sub']);
    expect(carried!.overlay.fit).toEqual({ sub: 0.95 });
    expect(rows![0]!.stale).toEqual([]);
  });

  it('a voice whose source script changed is stale; so is one whose file the new version does not have', async () => {
    const changed = await carry(comp({ script: 'Hello, new world' }), { 'assets/vo-de.mp3': 'de' });
    expect(changed.rows![0]!.stale).toEqual(['vo']);
    rmSync(join(base, 'outputs'), { recursive: true, force: true });
    const missing = await carry(comp({}));
    expect(missing.rows![0]!.stale).toEqual(['vo']);
  });

  it('nothing is carried for an instance the new version lacks, or an overlay that is no longer the recorded file', async () => {
    const v1 = await folder(1, comp({}));
    const hash = await writeOverlay(base, 1, { ...emptyOverlay('de', 'test-wide'), texts: { title: { source: 'Hello', text: 'Hallo' } } });
    v1.localizations = [{ locale: 'de', instanceId: 'test-wide', hash, origin: 'agent', stale: [], voice: 'original' }];
    const v2 = await folder(2, comp({}));
    expect(await carryLocalizations({ creativeDir: base, n: 1, version: v1 }, { creativeDir: base, n: 2 }, new Map(), { projectDir: base, uiLocale: currentLocale() })).toBeUndefined();
    v1.localizations[0]!.hash = 'f'.repeat(64);
    expect(await carryLocalizations({ creativeDir: base, n: 1, version: v1 }, { creativeDir: base, n: 2 }, new Map([['test-wide', await ic(v2)]]), { projectDir: base, uiLocale: currentLocale() })).toBeUndefined();
  });
});

describe('carry-over on every new version', { timeout: 120_000 }, () => {
  let env: InstanceEnv;
  beforeEach(async () => { env = await startInstanceEnv('ms-test-l10n-carry-int-'); });
  afterEach(async () => { await env?.close(); });
  const put = (slug: string, n: number, payload: object) =>
    env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/versions/${n}/localizations/de/test-wide`, headers: H, payload });

  it('a turn carries the overlays (kept); a turn that removes the clip drops the entry', async () => {
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['de'] } });
    expect((await put(slug, 1, { texts: { title: 'Hallo' } })).statusCode).toBe(200);
    await env.turn(slug, { text: 'again' });
    const v2 = (await env.versionOf(slug, 2))!;
    expect(v2.localizations).toEqual([expect.objectContaining({ locale: 'de', instanceId: 'test-wide', origin: 'editor', stale: [], voice: 'original' })]);
    expect((await readOverlay(env.store().dir(slug), 2, 'de', 'test-wide'))!.overlay.texts).toEqual({ title: { source: 'Hello', text: 'Hallo' } });
    delete process.env.FAKE_CLAUDE_TEXT;
    await env.turn(slug, { text: 'no title' });
    expect((await env.versionOf(slug, 3))!.localizations).toBeUndefined();
  });

  it('the agent cannot plant an overlay in the version it writes: its locales/ entry is removed, the core writes the carried one', async () => {
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['de'] } });
    expect((await put(slug, 1, { texts: { title: 'Hallo' } })).statusCode).toBe(200);
    const outside = join(env.base, 'outside.json');
    writeFileSync(outside, '{"planted":true}');
    process.env.FAKE_CLAUDE_SYMLINKS = JSON.stringify([['locales/de/test-wide.json', outside], ['locales/fr/test-wide.json', outside]]);
    try { await env.turn(slug, { text: 'again' }); } finally { delete process.env.FAKE_CLAUDE_SYMLINKS; }
    const dir = join(env.store().dir(slug), 'outputs', 'v2', 'locales');
    expect(readdirSync(dir)).toEqual(['de']);
    expect(lstatSync(join(dir, 'de', 'test-wide.json')).isFile()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('{"planted":true}');
    expect((await readOverlay(env.store().dir(slug), 2, 'de', 'test-wide'))!.hash).toBe((await env.versionOf(slug, 2))!.localizations![0]!.hash);
  });

  it('a direct edit that changes the source text carries the overlay with the entry stale', async () => {
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['de'] } });
    expect((await put(slug, 1, { texts: { title: 'Hallo' } })).statusCode).toBe(200);
    const view = (await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/compositions/test-wide`, headers: H })).json() as { hash: string; composition: Composition };
    const c = structuredClone(view.composition);
    (c.tracks.flatMap((t) => t.clips).find((k) => k.id === 'title') as unknown as { props: { text: string } }).props.text = 'Goodbye';
    const r = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/edits`, headers: H,
      payload: { baseVersion: 1, format: 'test-wide', baseHash: view.hash, composition: c, staged: [], ops: [], token: 'A'.repeat(43) } });
    expect(r.statusCode, r.body).toBe(200);
    const v2 = (await env.versionOf(slug, 2))!;
    expect(v2.origin).toBe('editor');
    expect(v2.localizations).toEqual([expect.objectContaining({ locale: 'de', instanceId: 'test-wide', stale: ['title'] })]);
    // The preview shows the source text for it, flagged.
    const loc = (await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/2/compositions/test-wide?locale=de`, headers: H })).json();
    expect(loc.localization.stale).toEqual(['title']);
    expect(JSON.stringify(loc.composition)).toContain('Goodbye');
    expect(JSON.stringify(loc.composition)).not.toContain('Hallo');
  });

  it('a duplicate carries the overlays of the other instances', async () => {
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['de'] } });
    expect((await put(slug, 1, { texts: { title: 'Hallo' } })).statusCode).toBe(200);
    const r = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/duplicate-format`, headers: H, payload: { instanceId: 'test-wide' } });
    expect(r.statusCode, r.body).toBe(200);
    const v2 = (await env.versionOf(slug, 2))!;
    expect(v2.localizations?.map((x) => `${x.locale}/${x.instanceId}`)).toEqual(['de/test-wide']);
    expect((await readOverlay(env.store().dir(slug), 2, 'de', 'test-wide'))!.hash).toBe(v2.localizations![0]!.hash);
  });
});
