// @vitest-environment node
/**
 * Format instances across the core (Phase 12, Task 1; spec §2, Review Focus 3): a brief holding `<preset>@<k>` ids gets its own
 * composition folders, carry-over, followers, renders, picks and export names; a creative without instances behaves byte
 * for byte as before (the baseline below was recorded from the code before instances).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreativeDetail } from '@motion-studio/shared';
import { H, UI_ORIGIN, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

let env: InstanceEnv;
beforeEach(async () => { env = await startInstanceEnv('ms-test-instances-'); });
afterEach(async () => { await env?.close(); });

const detail = async (slug: string) => (await env.app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).json() as CreativeDetail;
const exportTo = (slug: string, payload: object) => env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/export`, headers: H, payload: { date: '2026-10-13', ...payload } });
const names = (r: { json(): unknown }) => ((r.json() as { files: Array<{ to: string }> }).files).map((f) => f.to.split('/').pop()).sort();
/** The "Required formats" lines and the motion-studio block of a prompt. */
const formatPart = (prompt: string) => {
  const lines = prompt.split('\n');
  const at = lines.indexOf('## Required formats');
  const end = lines.indexOf('', at + 1);
  return { required: lines.slice(at + 1, end), block: prompt.slice(prompt.lastIndexOf('```motion-studio')) };
};

describe('a creative without instances', { timeout: 120_000 }, () => {
  it('produces byte-identical folders, prompts, render files, picks and export names to the code before instances', async () => {
    const slug = await env.create(['test-wide', 'test-tall', 'test-wide-b']);
    const v1 = (await env.versionOf(slug, 1))!;
    await env.render(slug, 1);
    await env.turn(slug, { text: 'Only the tall one', formats: ['test-tall'] });
    const v2 = (await env.versionOf(slug, 2))!;
    const pick = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/export-picks`, headers: H, payload: { format: 'test-tall', version: 1 } });
    expect(pick.statusCode, pick.body).toBe(200);
    const d = await detail(slug);
    const dest = join(env.base, 'out-default');
    const def = await exportTo(slug, { destination: dest, picks: { 'test-wide': 1 }, follow: ['test-wide-b'] });
    expect(def.statusCode, def.body).toBe(200);
    const custom = await exportTo(slug, { destination: join(env.base, 'out-custom'), picks: { 'test-wide': 1 }, follow: ['test-wide-b'], pattern: '{title}-{ratio}-v{v}' });
    const prompts = env.promptTexts().map(formatPart);
    const snapshot = {
      links: d.creative.brief.links,
      exportPicks: d.creative.exportPicks,
      v1: v1.compositions!.map(({ format, dir, followsFormat }) => ({ format, dir, followsFormat })),
      v1Files: readdirSync(join(env.store().dir(slug), 'outputs', 'v1')).sort(),
      v1Outputs: (await env.versionOf(slug, 1))!.outputs.map((o) => ({ format: o.format, file: o.file })),
      v2: v2.compositions!.map(({ format, dir, followsFormat }) => ({ format, dir, followsFormat })),
      v2Request: v2.request,
      exported: names(def),
      custom: [custom.statusCode, (custom.json() as { code?: string }).code],
      prompts,
      renders: env.fake.renders.map((r) => [r.format.id, r.out.split('/').slice(-2).join('/')]),
    };
    // The slug carries today's date: the only part that differs between runs.
    const recorded = JSON.parse(JSON.stringify(snapshot).replaceAll(slug, '<slug>')) as unknown;
    expect(recorded).toEqual(BASELINE);
  });
});


const SAME_SIZE = 'These are separate designs of the same size on the same brief: make each one a different image or video (another subject, scene or moment), never the same picture repeated; keep them distinct unless the request says otherwise';
const compsOf = (v: { compositions?: Array<{ format: string; dir: string; hash: string; followsFormat?: string }> } | undefined) =>
  (v?.compositions ?? []).map(({ format, dir, followsFormat }) => ({ format, dir, ...(followsFormat ? { followsFormat } : {}) }));
const hashOf = (v: { compositions?: Array<{ format: string; hash: string }> } | undefined, f: string) => v?.compositions?.find((c) => c.format === f)?.hash;
const filesOf = (slug: string, n: number, folder: string) => {
  const dir = join(env.store().dir(slug), 'outputs', `v${n}`, 'compositions', folder);
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else out[r] = readFileSync(join(dir, r)).toString('base64');
    }
  };
  walk('');
  return out;
};

describe('two instances of the same preset (Review Focus 3)', { timeout: 120_000 }, () => {
  it('a first generation gives each instance its own folder, a labelled prompt line and the same-size note; no default link between them', async () => {
    const slug = await env.create(['test-wide', 'test-wide@2', 'test-tall'], { formatLabels: { 'test-wide@2': 'Promo B' } });
    const d = await detail(slug);
    expect(d.creative.brief.links ?? {}).toEqual({});
    const v1 = (await env.versionOf(slug, 1))!;
    expect(compsOf(v1)).toEqual([
      { format: 'test-wide', dir: 'compositions/test-wide' },
      { format: 'test-wide@2', dir: 'compositions/test-wide@2' },
      { format: 'test-tall', dir: 'compositions/test-tall' },
    ]);
    const [first] = env.promptTexts().map(formatPart);
    const folder = (f: string) => `creatives/${slug}/outputs/v1/compositions/${f}/`;
    expect(first!.required).toEqual([
      `- test-wide: Test · Wide — 320×180, video — folder ${folder('test-wide')}`,
      `- test-wide@2: Test · Wide #2, labelled "Promo B" — 320×180, video — folder ${folder('test-wide@2')}`,
      `- test-tall: Test · Tall — 180×320, video — folder ${folder('test-tall')}`,
      `- test-wide, test-wide@2: ${SAME_SIZE}.`,
    ]);
    expect(first!.block).toContain(`"id":"test-wide@2","width":320,"height":180`);
    expect(first!.block).toContain(`"compositionDir":"creatives/${slug}/outputs/v1/compositions/test-wide@2"`);
    // The summaries name each instance on its own.
    expect(d.formats!.map((f) => f.id)).toEqual(['test-wide', 'test-wide@2', 'test-tall']);
  });

  it('a turn targeting only @2 delivers @2 and carries the bare instance byte-identical', async () => {
    const slug = await env.create(['test-wide', 'test-wide@2', 'test-tall'], { links: {} });
    const v1 = (await env.versionOf(slug, 1))!;
    const before = filesOf(slug, 1, 'test-wide');
    await env.turn(slug, { text: 'Change only the second one', formats: ['test-wide@2'] });
    const v2 = (await env.versionOf(slug, 2))!;
    expect(hashOf(v2, 'test-wide')).toBe(hashOf(v1, 'test-wide'));
    expect(filesOf(slug, 2, 'test-wide')).toEqual(before);
    expect(hashOf(v2, 'test-tall')).toBe(hashOf(v1, 'test-tall'));
    expect(hashOf(v2, 'test-wide@2')).not.toBe(hashOf(v1, 'test-wide@2'));
    const second = formatPart(env.promptTexts()[1]!);
    expect(second.required).toEqual([`- test-wide@2: Test · Wide #2 — 320×180, video — folder creatives/${slug}/outputs/v2/compositions/test-wide@2/`]);
    // The other way round: only the bare one, @2 carried.
    const at2 = filesOf(slug, 2, 'test-wide@2');
    await env.turn(slug, { text: 'Now only the first', formats: ['test-wide'] });
    const v3 = (await env.versionOf(slug, 3))!;
    expect(hashOf(v3, 'test-wide@2')).toBe(hashOf(v2, 'test-wide@2'));
    expect(filesOf(slug, 3, 'test-wide@2')).toEqual(at2);
    expect(hashOf(v3, 'test-wide')).not.toBe(hashOf(v2, 'test-wide'));
  });

  it('@2 can follow its bare primary: the link is checked, the entry follows, the render copies the primary under its own name', async () => {
    const slug = await env.create(['test-wide', 'test-wide@2'], { links: {} });
    const linked = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/links`, headers: H, payload: { follower: 'test-wide@2', primary: 'test-wide' } });
    expect(linked.statusCode, linked.body).toBe(200);
    const d = linked.json() as CreativeDetail;
    expect(d.creative.brief.links).toEqual({ 'test-wide@2': 'test-wide' });
    expect(d.formats!.find((f) => f.id === 'test-wide@2')!.star.follows).toBe('test-wide');
    await env.turn(slug, { text: 'Again' });
    const v2 = (await env.versionOf(slug, 2))!;
    expect(compsOf(v2)).toEqual([
      { format: 'test-wide', dir: 'compositions/test-wide' },
      { format: 'test-wide@2', dir: 'compositions/test-wide', followsFormat: 'test-wide' },
    ]);
    expect(formatPart(env.promptTexts()[1]!).required).toEqual([`- test-wide: Test · Wide — 320×180, video — folder creatives/${slug}/outputs/v2/compositions/test-wide/`]);
    await env.render(slug, 2);
    const outs = (await env.versionOf(slug, 2))!.outputs;
    expect(outs.map((o) => [o.format, o.file]).sort()).toEqual([['test-wide', 'test-wide.mp4'], ['test-wide@2', 'test-wide@2.mp4']]);
    // An instance of another size cannot follow (size), whatever its preset.
    const tall = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, headers: H, payload: { brief: { ...d.creative.brief, formats: ['test-wide', 'test-wide@2', 'test-tall@2'] } } });
    expect(tall.statusCode, tall.body).toBe(200);
    const bad = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/links`, headers: H, payload: { follower: 'test-tall@2', primary: 'test-wide' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('link-incompatible');
  });

  it('renders write outputs/vN/<instanceId>.<ext>, picks and export names keep instances apart (default and custom patterns)', async () => {
    const slug = await env.create(['test-wide', 'test-wide@2', 'test-wide-b', 'test-tall'], { links: {} });
    await env.render(slug, 1);
    const v1 = (await env.versionOf(slug, 1))!;
    expect(v1.outputs.map((o) => [o.format, o.file]).sort()).toEqual([
      ['test-tall', 'test-tall.mp4'], ['test-wide', 'test-wide.mp4'], ['test-wide-b', 'test-wide-b.mp4'], ['test-wide@2', 'test-wide@2.mp4'],
    ]);
    expect(env.fake.renders.map((r) => r.out.split('/').pop()).sort()).toEqual(['test-tall.mp4', 'test-wide-b.mp4', 'test-wide.mp4', 'test-wide@2.mp4']);
    // Served to the UI under its own name.
    expect((await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/files/outputs/v1/test-wide@2.mp4`, headers: H })).statusCode).toBe(200);
    expect((await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/files/outputs/v1/test-wide%402.mp4`, headers: H })).statusCode).toBe(200);
    await env.turn(slug, { text: 'Again, the second only', formats: ['test-wide@2'] });
    const pick = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/export-picks`, headers: H, payload: { format: 'test-wide@2', version: 1 } });
    expect(pick.statusCode, pick.body).toBe(200);
    expect((pick.json() as CreativeDetail).creative.exportPicks).toEqual({ 'test-wide@2': 1 });
    const def = await exportTo(slug, { destination: join(env.base, 'a'), picks: { 'test-wide': 1, 'test-wide@2': 1, 'test-tall': 1 } });
    expect(def.statusCode, def.body).toBe(200);
    expect(names(def)).toEqual(['launch-test-tall-v1.mp4', 'launch-test-wide-2-v1.mp4', 'launch-test-wide-v1.mp4']);
    // A pattern without {format}: the bare instance keeps its name, @2 gets its slugged id.
    const custom = await exportTo(slug, { destination: join(env.base, 'b'), picks: { 'test-wide': 1, 'test-wide@2': 1 }, pattern: '{title}-{ratio}-v{v}' });
    expect(custom.statusCode, custom.body).toBe(200);
    expect(names(custom)).toEqual(['launch-16x9-v1-test-wide-2.mp4', 'launch-16x9-v1.mp4']);
    // Two different presets still collide under such a pattern: refused as before.
    const clash = await exportTo(slug, { destination: join(env.base, 'c'), picks: { 'test-wide': 1, 'test-wide-b': 1 }, pattern: '{title}-{ratio}-v{v}' });
    expect(clash.statusCode).toBe(400);
    expect(clash.json().code).toBe('export-name-collision');
  });

  it('a user preset foo-2 next to the instance foo@2: both files are exported under distinct names', async () => {
    const slug = await env.create(['foo', 'foo-2', 'foo@2'], { links: {} });
    await env.render(slug, 1);
    const r = await exportTo(slug, { destination: join(env.base, 'd'), picks: { foo: 1, 'foo-2': 1, 'foo@2': 1 } });
    expect(r.statusCode, r.body).toBe(200);
    expect(names(r)).toEqual(['launch-foo-2-v1-foo-2.mp4', 'launch-foo-2-v1.mp4', 'launch-foo-v1.mp4']);
    const sources = (r.json() as { files: Array<{ from: string; to: string }> }).files.map((f) => [f.from.split('/').pop(), f.to.split('/').pop()]).sort();
    expect(sources).toEqual([['foo-2.mp4', 'launch-foo-2-v1.mp4'], ['foo.mp4', 'launch-foo-v1.mp4'], ['foo@2.mp4', 'launch-foo-2-v1-foo-2.mp4']]);
  });

  it('removing an instance from the brief keeps the saved versions; the next turn leaves it out', async () => {
    const slug = await env.create(['test-wide', 'test-wide@2'], { links: {}, formatLabels: { 'test-wide@2': 'Promo B' } });
    const versionsFile = join(env.store().dir(slug), 'versions.json');
    const saved = readFileSync(versionsFile, 'utf8');
    const d = await detail(slug);
    const { formatLabels: _labels, ...rest } = d.creative.brief;
    const r = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, headers: H, payload: { brief: { ...rest, formats: ['test-wide'] } } });
    expect(r.statusCode, r.body).toBe(200);
    expect(readFileSync(versionsFile, 'utf8')).toBe(saved);
    expect(Object.keys(filesOf(slug, 1, 'test-wide@2'))).toContain('composition.json');
    await env.turn(slug, { text: 'Again' });
    expect(compsOf(await env.versionOf(slug, 2))).toEqual([{ format: 'test-wide', dir: 'compositions/test-wide' }]);
    expect(formatPart(env.promptTexts()[1]!).required.join('\n')).not.toContain('@2');
    expect(compsOf(await env.versionOf(slug, 1)).map((c) => c.format)).toEqual(['test-wide', 'test-wide@2']);
  });

  it('removing an instance drops its links (either end) and its manual pick; the others stay', async () => {
    const slug = await env.create(['test-wide', 'test-wide@2', 'test-wide-b', 'test-tall'], { links: {} });
    await env.turn(slug, { text: 'again' });
    for (const [follower, primary] of [['test-wide@2', 'test-wide'], ['test-wide-b', 'test-wide']]) {
      const r = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/links`, headers: H, payload: { follower, primary } });
      expect(r.statusCode, r.body).toBe(200);
    }
    for (const format of ['test-wide', 'test-tall']) {
      const r = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/export-picks`, headers: H, payload: { format, version: 1 } });
      expect(r.statusCode, r.body).toBe(200);
    }
    const versions = readFileSync(join(env.store().dir(slug), 'versions.json'), 'utf8');
    // Removing the primary: both links that name it go, and its pick; the tall pick stays.
    let d = await detail(slug);
    let r = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, headers: H, payload: { brief: { ...d.creative.brief, formats: ['test-wide@2', 'test-wide-b', 'test-tall'] } } });
    expect(r.statusCode, r.body).toBe(200);
    d = await detail(slug);
    expect(d.creative.brief.links).toEqual({});
    expect(d.creative.exportPicks).toEqual({ 'test-tall': 1 });
    // Removing the last picked format: no picks at all.
    r = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, headers: H, payload: { brief: { ...d.creative.brief, formats: ['test-wide@2', 'test-wide-b'] } } });
    expect(r.statusCode, r.body).toBe(200);
    expect((await detail(slug)).creative.exportPicks).toBeUndefined();
    expect(readFileSync(join(env.store().dir(slug), 'versions.json'), 'utf8')).toBe(versions);
  });

  it('the editor, the storyboards and the live preview serve an instance under its own folder', async () => {
    const slug = await env.create(['test-wide', 'test-wide@2'], { links: {} });
    const v1 = (await env.versionOf(slug, 1))!;
    // The storyboard of @2: its own folder, served through a signed URL.
    const sb = await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/storyboards/test-wide@2`, headers: H });
    expect(sb.statusCode, sb.body).toBe(200);
    const board = sb.json() as { format: string; hash: string; frames: Array<{ url: string }> };
    expect(board.format).toBe('test-wide@2');
    expect(board.hash).toBe(hashOf(v1, 'test-wide@2'));
    const img = await env.app.inject({ url: board.frames[0]!.url });
    expect(img.statusCode).toBe(200);
    const live = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/preview-session`, headers: H, payload: { format: 'test-wide@2', parentOrigin: UI_ORIGIN } });
    expect(live.statusCode, live.body).toBe(200);
    // The editor's view of @2, then a direct edit of @2 alone: the bare instance is carried byte-identical.
    const view = await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/compositions/test-wide@2`, headers: H });
    expect(view.statusCode, view.body).toBe(200);
    const vw = view.json() as { hash: string; composition: { tracks: Array<{ clips: Array<{ id: string; props: Record<string, unknown> }> }> } };
    const comp = structuredClone(vw.composition);
    comp.tracks.flatMap((t) => t.clips).find((k) => k.id === 'title')!.props.text = 'Second';
    const before = filesOf(slug, 1, 'test-wide');
    const saved = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/edits`, headers: H, payload: {
      baseVersion: 1, format: 'test-wide@2', baseHash: vw.hash, composition: comp, staged: [], ops: [], token: 'A'.repeat(43),
    } });
    expect(saved.statusCode, saved.body).toBe(200);
    const v2 = (await env.versionOf(slug, 2))!;
    expect(hashOf(v2, 'test-wide')).toBe(hashOf(v1, 'test-wide'));
    expect(filesOf(slug, 2, 'test-wide')).toEqual(before);
    expect(hashOf(v2, 'test-wide@2')).not.toBe(hashOf(v1, 'test-wide@2'));
    expect(JSON.parse(readFileSync(join(env.store().dir(slug), 'outputs', 'v2', 'compositions', 'test-wide@2', 'composition.json'), 'utf8')).tracks
      .flatMap((t: { clips: Array<{ id: string; props: { text?: string } }> }) => t.clips).find((k: { id: string }) => k.id === 'title').props.text).toBe('Second');
  });
});

// Recorded from the code before format instances (HEAD 7760a3b).
const BASELINE: unknown = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'no-instances-baseline.json'), 'utf8'));
