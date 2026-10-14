// @vitest-environment node
/**
 * Duplicate format (Phase 12, Task 1; spec §2): `POST …/versions/:n/duplicate-format` copies one instance's composition of
 * version n into a new instance of the same preset, saved as a new editor version with no agent, under the creative's lock.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages, type CreativeDetail, type JobSummary, type VersionEntry } from '@motion-studio/shared';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { currentLocale } from '../src/i18n.ts';
import { H, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

let env: InstanceEnv;
beforeEach(async () => { env = await startInstanceEnv('ms-test-duplicate-'); });
afterEach(async () => { await env?.close(); });

const duplicate = (slug: string, n: number, payload: object) =>
  env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/${n}/duplicate-format`, headers: H, payload });
const detail = async (slug: string) => (await env.app.inject({ url: `/api/projects/acme/creatives/${slug}`, headers: H })).json() as CreativeDetail;
const entry = (v: VersionEntry | undefined, f: string) => v?.compositions?.find((c) => c.format === f);
const compDir = (slug: string, n: number, folder: string) => join(env.store().dir(slug), 'outputs', `v${n}`, 'compositions', folder);
const putBrief = async (slug: string, change: (b: CreativeDetail['creative']['brief']) => object) => {
  const d = await detail(slug);
  const r = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}`, headers: H, payload: { brief: change(d.creative.brief) } });
  expect(r.statusCode, r.body).toBe(200);
};
const v = () => messages(currentLocale()).variants;

describe('duplicating a format', { timeout: 120_000 }, () => {
  it('copies the composition of version n into the next instance, right after the source, as an editor version with no agent', async () => {
    const slug = await env.create(['test-wide', 'test-tall'], { links: {} });
    await env.render(slug, 1);
    const runs = env.agentRuns();
    const v1 = (await env.versionOf(slug, 1))!;
    const r = await duplicate(slug, 1, { instanceId: 'test-wide', label: 'Promo B' });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { version: VersionEntry; instanceId: string };
    expect(body.instanceId).toBe('test-wide@2');
    expect(body.version).toMatchObject({ n: 2, origin: 'editor', basedOn: 1, status: 'complete', request: v().duplicatedRequest({ label: 'Promo B' }) });
    expect(env.agentRuns()).toBe(runs);
    const d = await detail(slug);
    expect(d.creative.brief.formats).toEqual(['test-wide', 'test-wide@2', 'test-tall']);
    expect(d.creative.brief.formatLabels).toEqual({ 'test-wide@2': 'Promo B' });
    const v2 = (await env.versionOf(slug, 2))!;
    expect(v2.compositions!.map((c) => [c.format, c.dir, c.followsFormat])).toEqual([
      ['test-wide', 'compositions/test-wide', undefined], ['test-wide@2', 'compositions/test-wide@2', undefined], ['test-tall', 'compositions/test-tall', undefined],
    ]);
    // The copy is the source's content (same files, same hash); the others are carried as in a direct edit, renders included.
    expect(entry(v2, 'test-wide@2')!.hash).toBe(entry(v1, 'test-wide')!.hash);
    expect((await readCompositionFolder(compDir(slug, 2, 'test-wide@2'))).hash).toBe(entry(v1, 'test-wide')!.hash);
    expect(entry(v2, 'test-wide')).toEqual(entry(v1, 'test-wide'));
    expect(entry(v2, 'test-tall')).toEqual(entry(v1, 'test-tall'));
    expect(v2.outputs.map((o) => o.format).sort()).toEqual(['test-tall', 'test-wide']);
    // Version 1 is untouched.
    expect(readdirSync(join(env.store().dir(slug), 'outputs', 'v1', 'compositions')).sort()).toEqual(['test-tall', 'test-wide']);
  });

  it('without a label the request names the new instance; a copy of @2 becomes @3 right after it; gaps are reused', async () => {
    const slug = await env.create(['test-wide', 'test-tall'], { links: {} });
    const a = await duplicate(slug, 1, { instanceId: 'test-wide' });
    expect(a.statusCode, a.body).toBe(200);
    expect((a.json() as { version: VersionEntry }).version.request).toBe(v().duplicatedRequest({ label: 'Test · Wide #2' }));
    expect((await detail(slug)).creative.brief.formatLabels).toBeUndefined();
    const b = await duplicate(slug, 2, { instanceId: 'test-wide@2' });
    expect(b.statusCode, b.body).toBe(200);
    expect((b.json() as { instanceId: string }).instanceId).toBe('test-wide@3');
    expect((await detail(slug)).creative.brief.formats).toEqual(['test-wide', 'test-wide@2', 'test-wide@3', 'test-tall']);
    // @2 removed from the brief: the next copy of the bare one takes @2 again, right after the bare one.
    await putBrief(slug, (br) => ({ ...br, formats: ['test-wide', 'test-wide@3', 'test-tall'] }));
    const c = await duplicate(slug, 3, { instanceId: 'test-wide' });
    expect(c.statusCode, c.body).toBe(200);
    expect((c.json() as { instanceId: string }).instanceId).toBe('test-wide@2');
    expect((await detail(slug)).creative.brief.formats).toEqual(['test-wide', 'test-wide@2', 'test-wide@3', 'test-tall']);
    // Every version keeps its folders.
    expect(existsSync(compDir(slug, 3, 'test-wide@2'))).toBe(true);
    expect(entry(await env.versionOf(slug, 4), 'test-wide@2')!.hash).toBe(entry(await env.versionOf(slug, 3), 'test-wide')!.hash);
  });

  it('a follower in version n is duplicated with what it shows (its primary\'s composition), as a primary of its own', async () => {
    const slug = await env.create(['test-wide', 'test-wide-b'], { links: { 'test-wide-b': 'test-wide' } });
    const v1 = (await env.versionOf(slug, 1))!;
    expect(entry(v1, 'test-wide-b')!.followsFormat).toBe('test-wide');
    const r = await duplicate(slug, 1, { instanceId: 'test-wide-b' });
    expect(r.statusCode, r.body).toBe(200);
    const v2 = (await env.versionOf(slug, 2))!;
    expect(entry(v2, 'test-wide-b@2')).toMatchObject({ dir: 'compositions/test-wide-b@2', hash: entry(v1, 'test-wide')!.hash });
    expect(entry(v2, 'test-wide-b@2')!.followsFormat).toBeUndefined();
    expect(entry(v2, 'test-wide-b')).toMatchObject({ followsFormat: 'test-wide', dir: 'compositions/test-wide' });
    expect((await detail(slug)).creative.brief.links).toEqual({ 'test-wide-b': 'test-wide' });
  });

  it('two duplicates at once are serialised by the creative lock: @2 and @3, two versions', async () => {
    const slug = await env.create(['test-wide'], { links: {} });
    const [a, b] = await Promise.all([duplicate(slug, 1, { instanceId: 'test-wide' }), duplicate(slug, 1, { instanceId: 'test-wide' })]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().instanceId, b.json().instanceId].sort()).toEqual(['test-wide@2', 'test-wide@3']);
    expect((await env.store().readVersions(slug)).map((x) => x.n)).toEqual([1, 2, 3]);
    // Each copy lands right after its source: the later one first.
    expect((await detail(slug)).creative.brief.formats).toEqual(['test-wide', 'test-wide@3', 'test-wide@2']);
  });

  it('refuses while a turn runs (409), without touching the brief', async () => {
    const slug = await env.create(['test-wide'], { links: {} });
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const t = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/turns`, headers: H, payload: { text: 'go' } });
    expect(t.statusCode, t.body).toBe(202);
    const job = t.json() as JobSummary;
    for (let i = 0; i < 500 && ((await env.app.inject({ url: '/api/jobs', headers: H })).json() as JobSummary[]).find((x) => x.id === job.id)?.state !== 'running'; i++) await new Promise((res) => setTimeout(res, 20));
    const r = await duplicate(slug, 1, { instanceId: 'test-wide' });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('duplicate-busy');
    await env.app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel`, headers: H });
    await env.waitJob(job.id);
    expect((await detail(slug)).creative.brief.formats).toEqual(['test-wide']);
  });

  it('refuses while a render runs (409), without touching the brief', async () => {
    const slug = await env.create(['test-wide'], { links: {} });
    let release!: () => void;
    env.fake.gate = new Promise((res) => { release = res; });
    const rr = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/render`, headers: H, payload: {} });
    expect(rr.statusCode, rr.body).toBe(202);
    const job = rr.json() as JobSummary;
    await env.waitRunning(job.id);
    const r = await duplicate(slug, 1, { instanceId: 'test-wide' });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('duplicate-busy');
    release();
    env.fake.gate = null;
    await env.waitJob(job.id);
    expect((await detail(slug)).creative.brief.formats).toEqual(['test-wide']);
    expect((await env.store().readVersions(slug)).map((x) => x.n)).toEqual([1]);
    expect((await duplicate(slug, 1, { instanceId: 'test-wide' })).statusCode).toBe(200);
  });

  it('a freed id taken again is a primary with no pick: link @2 → bare, remove @2, duplicate the bare one (review repro)', async () => {
    const slug = await env.create(['test-wide', 'test-wide@2'], { links: {} });
    await env.turn(slug, { text: 'again' });
    const linked = await env.app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${slug}/links`, headers: H, payload: { follower: 'test-wide@2', primary: 'test-wide' } });
    expect(linked.statusCode, linked.body).toBe(200);
    await putBrief(slug, (br) => ({ ...br, formats: ['test-wide'] }));
    const r = await duplicate(slug, 2, { instanceId: 'test-wide' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().instanceId).toBe('test-wide@2');
    const d = await detail(slug);
    expect(d.creative.brief.links ?? {}).toEqual({});
    expect(d.creative.exportPicks).toBeUndefined();
    const summary = d.formats!.find((f) => f.id === 'test-wide@2')!;
    expect(summary.star).toMatchObject({ follows: null, manual: false });
    // The next turn iterates it as a design of its own.
    await env.turn(slug, { text: 'once more' });
    expect(entry(await env.versionOf(slug, 4), 'test-wide@2')!.followsFormat).toBeUndefined();
  });

  it('stale state stored for a free id (written before the cleanup existed) is dropped by the duplicate, in the same save', async () => {
    const slug = await env.create(['test-wide', 'test-tall'], { links: {} });
    await env.turn(slug, { text: 'again' });
    const file = join(env.store().dir(slug), 'creative.json');
    const c = JSON.parse(readFileSync(file, 'utf8'));
    c.brief.links = { 'test-wide@2': 'test-wide', 'test-tall': 'test-wide@2' };
    c.exportPicks = { 'test-wide@2': 1, 'test-tall': 1 };
    writeFileSync(file, JSON.stringify(c));
    const r = await duplicate(slug, 2, { instanceId: 'test-wide' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().instanceId).toBe('test-wide@2');
    const d = await detail(slug);
    expect(d.creative.brief.links).toEqual({});
    expect(d.creative.exportPicks).toEqual({ 'test-tall': 1 });
    expect(d.formats!.find((f) => f.id === 'test-wide@2')!.star).toMatchObject({ follows: null, manual: false });
    expect(d.formats!.find((f) => f.id === 'test-tall')!.star.follows).toBeNull();
  });

  it('a removal through the partial path ({ formats } alone) clears the removed instance\'s links at either end and its pick; re-adding the id starts clean', async () => {
    const slug = await env.create(['test-wide', 'test-tall'], { links: {} });
    const dup = await duplicate(slug, 1, { instanceId: 'test-wide' });
    expect(dup.statusCode, dup.body).toBe(200);
    const file = join(env.store().dir(slug), 'creative.json');
    const c = JSON.parse(readFileSync(file, 'utf8'));
    c.brief.links = { 'test-wide@2': 'test-wide', 'test-tall': 'test-wide@2' };
    c.exportPicks = { 'test-wide@2': 1, 'test-tall': 1 };
    writeFileSync(file, JSON.stringify(c));
    const url = `/api/projects/acme/creatives/${slug}`;
    const r = await env.app.inject({ method: 'PUT', url, headers: H, payload: { formats: ['test-wide', 'test-tall'] } });
    expect(r.statusCode, r.body).toBe(200);
    const d = await detail(slug);
    expect(d.creative.brief.formats).toEqual(['test-wide', 'test-tall']);
    expect(d.creative.brief.links ?? {}).toEqual({});
    expect(d.creative.exportPicks).toEqual({ 'test-tall': 1 });
    // The id comes back (a duplicate takes the free @2): no link and no pick follow it.
    const again = await duplicate(slug, 2, { instanceId: 'test-wide' });
    expect(again.json().instanceId).toBe('test-wide@2');
    const after = await detail(slug);
    expect(after.creative.brief.links ?? {}).toEqual({});
    expect(after.formats!.find((f) => f.id === 'test-wide@2')!.star).toMatchObject({ follows: null, manual: false });
  });

  it('duplicating from an older version copies that version\'s source; every other instance comes from the latest version', async () => {
    const slug = await env.create(['test-wide', 'test-tall'], { links: {} });
    for (const text of ['two', 'three', 'four', 'five']) await env.turn(slug, { text });
    const v3 = (await env.versionOf(slug, 3))!;
    const v5 = (await env.versionOf(slug, 5))!;
    expect(entry(v3, 'test-wide')!.hash).not.toBe(entry(v5, 'test-wide')!.hash);
    expect(entry(v3, 'test-tall')!.hash).not.toBe(entry(v5, 'test-tall')!.hash);
    const r = await duplicate(slug, 3, { instanceId: 'test-wide' });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { version: VersionEntry; instanceId: string };
    expect(body.version.n).toBe(6);
    const v6 = (await env.versionOf(slug, 6))!;
    expect(entry(v6, body.instanceId)!.hash).toBe(entry(v3, 'test-wide')!.hash);
    expect((await readCompositionFolder(compDir(slug, 6, body.instanceId))).hash).toBe(entry(v3, 'test-wide')!.hash);
    expect(entry(v6, 'test-wide')!.hash).toBe(entry(v5, 'test-wide')!.hash);
    expect(entry(v6, 'test-tall')!.hash).toBe(entry(v5, 'test-tall')!.hash);
  });

  it('refuses 20 instances, a source not in version n (409), a source not in the brief (400), an unknown version (404) and a bad body (400)', async () => {
    const slug = await env.create(['test-wide'], { links: {} });
    const twenty = ['test-wide', ...Array.from({ length: 19 }, (_, i) => `test-wide@${i + 2}`)];
    await putBrief(slug, (br) => ({ ...br, formats: [...twenty, 'test-tall'] }));
    const full = await duplicate(slug, 1, { instanceId: 'test-wide' });
    expect(full.statusCode).toBe(409);
    expect(full.json().code).toBe('format-instances-full');
    const absent = await duplicate(slug, 1, { instanceId: 'test-tall' });
    expect(absent.statusCode).toBe(409);
    expect(absent.json().code).toBe('format-not-in-version');
    await putBrief(slug, (br) => ({ ...br, formats: ['test-wide'] }));
    const notBrief = await duplicate(slug, 1, { instanceId: 'test-tall' });
    expect(notBrief.statusCode).toBe(400);
    expect(notBrief.json().code).toBe('format-not-in-brief');
    expect((await duplicate(slug, 9, { instanceId: 'test-wide' })).statusCode).toBe(404);
    for (const payload of [{}, { instanceId: 'Test Wide' }, { instanceId: 'test-wide', label: '' }, { instanceId: 'test-wide', label: 'x'.repeat(61) }, { instanceId: 'test-wide', extra: 1 }]) {
      expect((await duplicate(slug, 1, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await env.store().readVersions(slug)).map((x) => x.n)).toEqual([1]);
    // No refused duplicate left an instance behind (the ids the brief saves freed are recorded in `freedInstances`, final review I1).
    const stored = JSON.parse(readFileSync(join(env.store().dir(slug), 'creative.json'), 'utf8'));
    expect(JSON.stringify({ brief: stored.brief, exportPicks: stored.exportPicks })).not.toContain('@2"');
  });

  it('a source or carried folder that is no longer the recorded one is refused (409) with nothing saved', async () => {
    const slug = await env.create(['test-wide', 'test-tall'], { links: {} });
    const creativeJson = readFileSync(join(env.store().dir(slug), 'creative.json'), 'utf8');
    const tamper = (folder: string) => writeFileSync(join(compDir(slug, 1, folder), 'composition.json'), `${readFileSync(join(compDir(slug, 1, folder), 'composition.json'), 'utf8')} `);
    tamper('test-tall');
    const carried = await duplicate(slug, 1, { instanceId: 'test-wide' });
    expect(carried.statusCode).toBe(409);
    expect(carried.json().code).toBe('duplicate-carry-failed');
    tamper('test-wide');
    const src = await duplicate(slug, 1, { instanceId: 'test-wide' });
    expect(src.statusCode).toBe(409);
    expect(src.json().code).toBe('duplicate-carry-failed');
    expect((await env.store().readVersions(slug)).map((x) => x.n)).toEqual([1]);
    expect(existsSync(join(env.store().dir(slug), 'outputs', 'v2'))).toBe(false);
    expect(readFileSync(join(env.store().dir(slug), 'creative.json'), 'utf8')).toBe(creativeJson);
  });
});
