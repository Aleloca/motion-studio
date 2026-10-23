// @vitest-environment node
/**
 * Phase 15, Task 4 (spec §3 "Identità"): a logo from scratch with N > 1 concepts is a group of N variants, each with logo,
 * favicon and app icon, and no `identity-logo@k` instances. Old creatives with those instances load unchanged (decision 786).
 * The prompt of a grouped identity creative says a variant's icons derive from its own logo; other identity prompts are
 * byte-identical (golden hashes taken before the change).
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FORMATS, EMPTY_BRAND_KIT, type CreativeDetail, type CreativeFile } from '@motion-studio/shared';
import { VariantFanout } from '../src/creatives/variant-fanout.ts';
import { identityGroupSize } from '../src/server/creative-routes.ts';
import { VariantGroupService } from '../src/creatives/variant-group.ts';
import { buildCreativePrompt } from '../src/creatives/prompt.ts';
import { variantApp, type VariantApp } from './helpers/variant-app.ts';

vi.setConfig({ testTimeout: 60_000 });

const IDENTITY = ['identity-logo', 'identity-favicon', 'identity-app-icon'];
const P = '/api/projects/acme/creatives';
const identityBrief = (concepts: number, formats = IDENTITY) => ({
  goal: 'Logo per Acme', message: '', formats, durationSec: null, assets: [], notes: '', identity: { start: 'scratch', name: 'Acme', colors: 'brand', concepts },
});
let v: VariantApp;
afterEach(async () => { await v?.close(); });
const create = (brief: unknown, generate = false) => v.app.inject({ method: 'POST', url: P, payload: { title: 'Logo', brief, generate } });

describe('identity concepts are variants', () => {
  it('3 concepts with logo, favicon and app icon: a group of 3, every variant with all three formats and no @k', async () => {
    v = await variantApp();
    const res = await create(identityBrief(3));
    expect(res.statusCode, res.body).toBe(201);
    const { slug } = res.json() as { slug: string };
    const d = (await v.app.inject(`${P}/${slug}`)).json() as CreativeDetail;
    expect(d.creative.variantGroup!.members.map((m) => m.letter)).toEqual(['a', 'b', 'c']);
    for (const s of [slug, `${slug}~b`, `${slug}~c`]) {
      const own = await v.detail(s);
      expect(own.creative.brief.formats, s).toEqual(IDENTITY);
    }
    // No identity-logo@k instance anywhere: the stored brief of every member lists the three presets as they are.
    for (const s of [slug, `${slug}~b`, `${slug}~c`]) {
      const stored = JSON.parse(await readFile(join(v.projectDir, 'creatives', s, 'creative.json'), 'utf8')) as CreativeFile;
      expect(stored.brief.formats.filter((f) => f.includes('@')), s).toEqual([]);
    }
    // generate: false starts nothing.
    expect(await v.jobs()).toEqual([]);
  });

  it('one concept, the brand start, or no identity format: no group', async () => {
    v = await variantApp();
    for (const brief of [identityBrief(1), { ...identityBrief(3), identity: { start: 'brand', colors: 'brand', concepts: 3 } }, { ...identityBrief(3, ['instagram-post-1x1']) }]) {
      const { slug } = (await create(brief)).json() as { slug: string };
      expect((await v.detail(slug)).creative.variantGroup, JSON.stringify(brief.formats)).toBeUndefined();
    }
  });

  it('identityGroupSize: 3 concepts when none is given, a favicon alone or mixed with other formats is a group, instances and the brand start are not', () => {
    const size = (b: Parameters<typeof identityGroupSize>[0]) => identityGroupSize(b, DEFAULT_FORMATS);
    const scratch = (concepts?: number) => ({ start: 'scratch' as const, name: 'Acme', colors: 'brand' as const, ...(concepts !== undefined ? { concepts } : {}) });
    expect(size({ formats: IDENTITY, identity: scratch() })).toBe(3);
    expect(size({ formats: ['identity-favicon'], identity: scratch(4) })).toBe(4);
    expect(size({ formats: ['identity-logo', 'instagram-post-1x1'], identity: scratch(2) })).toBe(2);
    expect(size({ formats: IDENTITY, identity: scratch(9) })).toBe(5);
    expect(size({ formats: ['identity-logo', 'identity-logo@2'], identity: scratch(3) })).toBe(1);
    expect(size({ formats: IDENTITY, identity: { start: 'brand', colors: 'brand', concepts: 3 } })).toBe(1);
    expect(size({ formats: IDENTITY })).toBe(1);
  });

  it('generate: true starts the group like a grouped creative: a directions turn, held turns for every variant', async () => {
    v = await variantApp();
    const res = await create(identityBrief(3), true);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { slug: string; job: unknown; variantRun?: { directionsJobId?: string; jobs: Record<string, string> } };
    expect(Object.keys(body.variantRun!.jobs).sort()).toEqual(['a', 'b', 'c']);
    expect(body.variantRun!.directionsJobId).toBeTruthy();
    expect(body.job).toBeNull();
    const first = await v.runner.next(0);
    expect(first.req.prompt).toContain('submit_variant_directions');
  });

  it('a start that throws after the group exists still answers 201 with the slug and the failure', async () => {
    v = await variantApp();
    const spy = vi.spyOn(VariantFanout.prototype, 'run').mockRejectedValueOnce(new Error('start boom'));
    try {
      const res = await create(identityBrief(3), true);
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json() as { slug: string; job: unknown; variantRun?: unknown; startError?: string };
      expect(body.startError).toBe('start boom');
      expect(body.variantRun).toBeUndefined();
      expect((await v.detail(body.slug)).creative.variantGroup!.members).toHaveLength(3);
    } finally { spy.mockRestore(); }
  });

  it('final wave M4: a group that cannot be made after the creative exists still answers 201 with the slug and the failure', async () => {
    v = await variantApp();
    const spy = vi.spyOn(VariantGroupService.prototype, 'addVariants').mockRejectedValueOnce(new Error('group boom'));
    try {
      const res = await create(identityBrief(3), true);
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json() as { slug: string; job: unknown; variantRun?: unknown; groupError?: string };
      expect(body.groupError).toBe('group boom');
      expect(body.job).toBeNull();
      expect(body.variantRun).toBeUndefined();
      // The creative is there (no group, nothing started): the user opens it and can add the variants from the canvas.
      expect((await v.detail(body.slug)).creative.variantGroup).toBeUndefined();
      expect(await v.jobs()).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it('an old creative with identity-logo@2/@3 loads and renders, its instances untouched', async () => {
    v = await variantApp();
    const old = ['identity-logo', 'identity-logo@2', 'identity-logo@3', 'identity-favicon'];
    const { slug } = (await create(identityBrief(3, old))).json() as { slug: string };
    const d = await v.detail(slug);
    expect(d.creative.variantGroup).toBeUndefined();
    expect(d.creative.brief.formats).toEqual(old);
    expect(d.formats!.map((f) => f.id)).toEqual(old);
    const file = join(v.projectDir, 'creatives', slug, 'creative.json');
    const before = await readFile(file, 'utf8');
    await writeFile(file, before);
    expect((await v.detail(slug)).creative.brief.formats).toEqual(old);
  });
});

const creative = (formats: string[], extra: Partial<CreativeFile['brief']> = {}): CreativeFile => ({
  schemaVersion: 1, title: 'Acme', status: 'draft', error: null, resumeFrom: null, linkedCodebases: [],
  createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z',
  brief: { goal: 'A logo', message: '', formats, durationSec: null, assets: [], notes: '', identity: { start: 'scratch', name: 'Acme', colors: 'brand', concepts: 3 }, ...extra },
});
const context = { kit: EMPTY_BRAND_KIT, hasGuidelines: false, assets: 0, references: 0, codebases: [], missingCodebases: [], tools: [] };
const prompt = (formats: string[], variant?: { letter: 'a' | 'b'; count: number }) => buildCreativePrompt({
  slug: 's', creative: creative(formats), presets: DEFAULT_FORMATS, version: 1, kind: 'first', locale: 'en', context,
  ...(variant ? { variant: { ...variant, direction: 'Geometrico', others: [{ letter: 'a' as const, direction: null }] } } : {}),
});
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('identity prompt of a grouped creative', () => {
  it('variant B says its favicon and app icon come from its own logo', () => {
    const p = prompt(IDENTITY, { letter: 'b', count: 3 });
    expect(p).toMatch(/favicon and app icon of this variant derive from ITS OWN logo/);
    expect(p).not.toMatch(/distinct logo concepts/);
  });
  it('a creative outside a group: identity prompts are byte-identical', () => {
    expect(prompt(IDENTITY)).not.toContain('ITS OWN logo');
    expect(sha(prompt(IDENTITY))).toBe(GOLDEN.three);
    expect(sha(prompt(['identity-logo', 'identity-logo@2', 'identity-favicon']))).toBe(GOLDEN.instances);
  });
});

// Decision 876 added the logo's required "dark" line to the identity section (the only change: without it the old hashes come back).
// Decision 1132 (report 34) added the outline-from-ttf/otf sentence and the Sandbox "no cd chains" line.
// Decision 1232 (report 38) added the html layers' "no will-change" line.
// Decision 1434 (report 58) reworded SAME_SIZE_NOTE (copies are different images): only `instances`, the one with an @2 copy, changes.
const GOLDEN = { three: 'b97d163ce79fa5aaee7ec0d82d4199bb6e2e89a27d2e57069a2f5f9bd41dd874', instances: '634849104164098c8922e4a79a79ea1535f02b0efa08ab28c39b37c631218be7' };
