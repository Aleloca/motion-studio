import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { armTripwire } from '../src/agent/run-tripwire.ts';
import { BrandStore } from '../src/brand/brand-store.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { writeJsonFileAtomic } from '../src/json-file.ts';

const cleanup: string[] = [];
afterEach(async () => { for (const d of cleanup.splice(0)) await rm(d, { recursive: true, force: true }); });
const brief = { goal: 'g', message: '', formats: ['instagram-post-1x1'], durationSec: 3, assets: [], notes: '' };
/** Folder times have sub-ms resolution but a change in the same instant as the snapshot could look unchanged. */
const tick = () => new Promise((r) => setTimeout(r, 15));

async function project() {
  const p = await mkdtemp(join(tmpdir(), 'ms-trip [x] '));
  cleanup.push(p);
  const store = new CreativeStore(p);
  const { slug } = await store.create({ title: 'uno', brief });
  return { p, store, slug, c: join(p, 'creatives', slug) };
}

describe('armTripwire (decisions log 141)', () => {
  it('sees a creative folder moved out, edited and moved back', async () => {
    const { p, c, slug } = await project();
    const trip = await armTripwire(p, { logs: false });
    await tick();
    await rename(c, join(p, 'out'));
    await appendFile(join(p, 'out', 'conversation.jsonl'), 'forged\n');
    await rename(join(p, 'out'), c);
    expect((await trip.check()).moved.sort()).toEqual(['creatives', join('creatives', slug)]);
  });
  it('sees outputs/ moved out and back through the creative folder', async () => {
    const { p, c, slug } = await project();
    await mkdir(join(c, 'outputs', 'v1'), { recursive: true });
    const trip = await armTripwire(p, { logs: false });
    await tick();
    await rename(join(c, 'outputs'), join(p, 'o'));
    await rename(join(p, 'o'), join(c, 'outputs'));
    expect((await trip.check()).moved).toEqual([join('creatives', slug)]);
  });
  it('leaves out the core\'s own changes: atomic writes, a creative or a proposal created during the run, appends', async () => {
    const { p, store, c, slug } = await project();
    await mkdir(join(p, 'brand', 'proposals'), { recursive: true });
    const trip = await armTripwire(p, { logs: true });
    await tick();
    await writeJsonFileAtomic(join(c, 'versions.json'), { schemaVersion: 1, versions: [] });
    await store.update(slug, { status: 'ready' });
    await store.create({ title: 'due', brief });
    await new BrandStore(p).newProposalId();
    await store.appendConversation(slug, { type: 'system', at: new Date().toISOString(), level: 'info', text: 'core' });
    expect(await trip.check()).toEqual({ moved: [], rewritten: [] });
  });
  it('sees a file the core did not make at the top of a creative, and a folder replaced', async () => {
    const { p, c, slug } = await project();
    const trip = await armTripwire(p, { logs: false });
    await tick();
    await writeFile(join(c, 'stray.txt'), 'x');
    expect((await trip.check()).moved).toEqual([join('creatives', slug)]);
  });
  it('with logs: a rewritten or cut history is reported, an append is not', async () => {
    const { p, store, c, slug } = await project();
    await store.appendConversation(slug, { type: 'system', at: new Date().toISOString(), level: 'info', text: 'one' });
    const second = (await store.create({ title: 'due', brief })).slug;
    await store.appendConversation(second, { type: 'system', at: new Date().toISOString(), level: 'info', text: 'two' });
    const trip = await armTripwire(p, { logs: true });
    await appendFile(join(c, 'conversation.jsonl'), 'appended\n');
    await writeFile(join(p, 'creatives', second, 'conversation.jsonl'), '{"forged":true}\n');
    expect((await trip.check()).rewritten).toEqual([join('creatives', second, 'conversation.jsonl')]);
    const off = await armTripwire(p, { logs: false });
    await writeFile(join(c, 'conversation.jsonl'), '');
    expect((await off.check()).rewritten).toEqual([]);
  });
});
