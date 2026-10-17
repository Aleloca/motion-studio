// @vitest-environment node
/**
 * Decision 915: archive, restore and delete (to a TEMP Trash, injected: never the user's real one) of a creative and of a
 * variant group, on a real server with the controlled runner (no `claude`).
 */
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreativeListItem, CreativeRemovalInfo, JobSummary } from '@motion-studio/shared';
import { creativeBusy } from '../src/creatives/creative-removal.ts';
import { variantApp, variantBrief, type VariantApp } from './helpers/variant-app.ts';
import { rename } from 'node:fs/promises';
import { t } from '../src/i18n.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const P = '/api/projects/acme/creatives';
let s: VariantApp;
let trashDir: string;
const trashed: string[] = [];

const start = async (o: { trash?: boolean } = {}) => {
  trashDir = await mkdtemp(join(tmpdir(), 'ms-test-trash-'));
  trashed.length = 0;
  s = await variantApp(o.trash === false ? {} : { trash: async (p) => { trashed.push(basename(p)); await rename(p, join(trashDir, basename(p))); } });
};
afterEach(async () => { await s?.close(); });

const create = async (title = 'Lancio') => ((await s.app.inject({ method: 'POST', url: P, payload: { title, brief: variantBrief, generate: false } })).json() as { slug: string }).slug;
const list = async (archived = false) => ((await s.app.inject(`${P}${archived ? '?archived=1' : ''}`)).json() as CreativeListItem[]).map((i) => i.slug);
const file = async (slug: string) => JSON.parse(await readFile(join(s.projectDir, 'creatives', slug, 'creative.json'), 'utf8'));
const exists = (slug: string) => lstat(join(s.projectDir, 'creatives', slug)).then(() => true, () => false);
const git = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: s.projectDir })).stdout;
const info = async (slug: string) => (await s.app.inject(`${P}/${slug}/removal`)).json() as CreativeRemovalInfo;

describe('creative archive and delete', () => {
  it('archives: out of the lists, under ?archived=1, committed; unarchive brings it back', async () => {
    await start();
    const slug = await create();
    const other = await create('Altro');
    expect(await info(slug)).toMatchObject({ role: 'single', members: 1, archived: false, blocked: null, title: 'Lancio' });
    const res = await s.app.inject({ method: 'POST', url: `${P}/${slug}/archive` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ archived: [slug] });
    expect(await list()).toEqual([other]);
    expect(await list(true)).toEqual([slug]);
    expect(((await s.app.inject('/api/recent-creatives?limit=12')).json() as Array<{ slug: string }>).map((i) => i.slug)).toEqual([other]);
    expect((await file(slug)).archivedAt).toEqual(expect.any(String));
    expect(await git('log', '-1', '--format=%s', '--', `creatives/${slug}/creative.json`)).toContain(t().jobs.creativeArchivedCommit({ title: 'Lancio' }));
    // The page still opens (a link from elsewhere): the detail says it is archived.
    expect((await s.app.inject(`${P}/${slug}`)).json().creative.archivedAt).toEqual(expect.any(String));
    expect((await info(slug)).archived).toBe(true);
    expect((await s.app.inject({ method: 'POST', url: `${P}/${slug}/unarchive` })).json()).toEqual({ restored: [slug] });
    expect((await list()).sort()).toEqual([slug, other].sort());
    expect(await list(true)).toEqual([]);
    expect((await file(slug)).archivedAt).toBeUndefined();
  });

  it('deletes: the folder goes to the (temp) Trash, its removal is committed, history keeps it', async () => {
    await start();
    const slug = await create();
    await s.app.inject({ method: 'POST', url: `${P}/${slug}/archive` }); // commits creative.json: the folder is in git
    const res = await s.app.inject({ method: 'DELETE', url: `${P}/${slug}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ deleted: [slug] });
    expect(await exists(slug)).toBe(false);
    expect(await readdir(trashDir)).toEqual([slug]);
    expect(await list()).toEqual([]);
    expect(await list(true)).toEqual([]);
    expect(await git('ls-files', `creatives/${slug}`)).toBe('');
    expect(await git('log', '-1', '--format=%s')).toContain(t().jobs.creativeDeletedCommit({ title: 'Lancio' }));
    expect(await git('log', '--format=%s', '--', `creatives/${slug}/creative.json`)).toContain(t().jobs.creativeArchivedCommit({ title: 'Lancio' }));
    expect((await s.app.inject(`${P}/${slug}`)).statusCode).toBe(404);
  });

  it('a server without a Trash refuses to delete and moves nothing', async () => {
    await start({ trash: false });
    const slug = await create();
    const res = await s.app.inject({ method: 'DELETE', url: `${P}/${slug}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('trash-unavailable');
    expect(await exists(slug)).toBe(true);
  });

  it('both are refused while a turn of the creative is queued or running, with the reason', async () => {
    await start();
    const slug = await create();
    expect((await s.app.inject({ method: 'POST', url: `${P}/${slug}/turns`, payload: { text: 'Vai' } })).statusCode).toBe(202);
    const run = await s.runOf(slug);
    const blocked = await info(slug);
    expect(blocked.blocked).toMatchObject({ code: 'creative-busy' });
    for (const req of [{ method: 'POST' as const, url: `${P}/${slug}/archive` }, { method: 'DELETE' as const, url: `${P}/${slug}` }]) {
      const res = await s.app.inject(req);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'creative-busy', error: blocked.blocked!.message });
    }
    expect(await exists(slug)).toBe(true);
    expect((await file(slug)).archivedAt).toBeUndefined();
    run.finish();
    await s.waitIdle();
    expect((await info(slug)).blocked).toBeNull();
  });

  it('creativeBusy: a turn, the group\'s directions turn or a render of that creative, queued or running; never another one', () => {
    const ref = { root: '/w', projectSlug: 'acme', projectDir: '/w/acme', creativeSlug: 'x' };
    const job = (key: string, state: JobSummary['state'] = 'running') => ({ key, state }) as JobSummary;
    expect(creativeBusy([job('creative:/w:acme:x')], ref)).toBe('turn');
    expect(creativeBusy([job('variant-directions:creative:/w:acme:x', 'queued')], ref)).toBe('turn');
    expect(creativeBusy([job('render:/w:acme:x:v3:2', 'queued')], ref)).toBe('render');
    expect(creativeBusy([job('creative:/w:acme:x', 'succeeded'), job('render:/w:acme:x-2:v1'), job('creative:/w:acme:x~b')], ref)).toBeNull();
  });

  it('a group from variant A: refused without all=1; with it every variant is archived, restored, then deleted', async () => {
    await start();
    const slug = await s.group([null, null, null]);
    expect(await info(slug)).toMatchObject({ role: 'host', members: 3, letter: 'a' });
    const no = await s.app.inject({ method: 'POST', url: `${P}/${slug}/archive` });
    expect(no.statusCode).toBe(409);
    expect(no.json().code).toBe('creative-group');
    expect((await s.app.inject({ method: 'POST', url: `${P}/${slug}/archive?all=1` })).json().archived.sort()).toEqual([slug, `${slug}~b`, `${slug}~c`].sort());
    expect(await list()).toEqual([]);
    expect(await list(true)).toEqual([slug]);
    expect((await file(`${slug}~b`)).archivedAt).toEqual(expect.any(String));
    // The group itself is untouched: restoring A brings every variant back.
    expect((await file(slug)).variantGroup.members).toHaveLength(3);
    expect((await s.app.inject({ method: 'POST', url: `${P}/${slug}/unarchive` })).json().restored.sort()).toEqual([slug, `${slug}~b`, `${slug}~c`].sort());
    expect((await file(`${slug}~c`)).archivedAt).toBeUndefined();
    expect((await s.app.inject({ method: 'DELETE', url: `${P}/${slug}` })).json().code).toBe('creative-group');
    expect((await s.app.inject({ method: 'DELETE', url: `${P}/${slug}?all=1` })).json().deleted).toEqual([`${slug}~b`, `${slug}~c`, slug]);
    expect((await readdir(join(s.projectDir, 'creatives'))).filter((n) => n.startsWith(slug))).toEqual([]);
    expect(await git('ls-files', `creatives/${slug}`, `creatives/${slug}~b`, `creatives/${slug}~c`)).toBe('');
  });

  it('a sister alone leaves the group: archived it is a single creative under Archiviate, its letter is not reused; deleted it frees it', async () => {
    await start();
    const slug = await s.group([null, null, null]);
    expect(await info(`${slug}~b`)).toMatchObject({ role: 'sister', members: 3, letter: 'b' });
    expect((await s.app.inject({ method: 'POST', url: `${P}/${slug}~b/archive` })).json()).toEqual({ archived: [`${slug}~b`] });
    expect((await file(slug)).variantGroup.members.map((m: { letter: string }) => m.letter)).toEqual(['a', 'c']);
    expect(await list()).toEqual([slug]);
    expect(await list(true)).toEqual([`${slug}~b`]);
    // A new variant takes the next free letter (b's folder is still there).
    expect((await s.app.inject({ method: 'POST', url: `${P}/${slug}/variants`, payload: { count: 1 } })).statusCode).toBe(201);
    expect((await file(slug)).variantGroup.members.map((m: { letter: string }) => m.letter)).toEqual(['a', 'c', 'd']);
    // Restored, it stays out of the group: a single (orphan) creative.
    await s.app.inject({ method: 'POST', url: `${P}/${slug}~b/unarchive` });
    expect((await list()).sort()).toEqual([slug, `${slug}~b`].sort());
    expect((await s.detail(`${slug}~b`)).variants).toMatchObject({ orphan: true });
    // Deleting a sister: out of the group, folder in the Trash; with A alone left, no group any more.
    expect((await s.app.inject({ method: 'DELETE', url: `${P}/${slug}~c` })).json()).toEqual({ deleted: [`${slug}~c`] });
    expect((await file(slug)).variantGroup.members.map((m: { letter: string }) => m.letter)).toEqual(['a', 'd']);
    await s.app.inject({ method: 'DELETE', url: `${P}/${slug}~d` });
    expect((await file(slug)).variantGroup).toBeUndefined();
    expect(trashed).toEqual([`${slug}~c`, `${slug}~d`]);
    expect(await info(slug)).toMatchObject({ role: 'single', members: 1 });
  });

  it('the last active variant cannot leave its group', async () => {
    await start();
    const slug = await s.group([null, null]);
    expect((await s.app.inject({ method: 'POST', url: `${P}/${slug}/variants/a/discard` })).statusCode).toBe(200);
    for (const req of [{ method: 'POST' as const, url: `${P}/${slug}~b/archive` }, { method: 'DELETE' as const, url: `${P}/${slug}~b` }]) {
      const res = await s.app.inject(req);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('variant-last-active');
    }
    expect(await exists(`${slug}~b`)).toBe(true);
    expect((await file(slug)).variantGroup.members).toHaveLength(2);
  });
});
