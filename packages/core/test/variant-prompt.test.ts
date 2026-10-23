// @vitest-environment node
/**
 * Phase 15, Task 3 (spec §3 "Turni delle varianti"): a variant's turn gets the common brief, its own direction and the other
 * active variants' directions as a reference not to copy, in a "Variant" section. Only grouped creatives get it: an old
 * creative's prompt is byte-identical to the one before phase 15 (golden hashes taken before the change).
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FORMATS, EMPTY_BRAND_KIT, type CreativeFile } from '@motion-studio/shared';
import { buildCreativePrompt } from '../src/creatives/prompt.ts';
import { variantApp, type VariantApp } from './helpers/variant-app.ts';

vi.setConfig({ testTimeout: 60_000 });

const creative: CreativeFile = {
  schemaVersion: 1, title: 'Lancio app', status: 'draft', error: null, resumeFrom: null, linkedCodebases: [],
  createdAt: '2026-10-07T10:00:00.000Z', updatedAt: '2026-10-07T10:00:00.000Z',
  brief: { goal: 'Far capire che prenotare è immediato', message: 'Prenota in 3 tap', formats: ['instagram-post-1x1', 'web-banner-300x250'],
    durationSec: 15, assets: [], notes: 'Chiudi sempre con il logo' },
};
const context = { kit: EMPTY_BRAND_KIT, hasGuidelines: false, assets: 0, references: 0, codebases: [], missingCodebases: [], tools: ['- tts: voice-over (ready)'] };
const base = { slug: 'lancio-app', creative, presets: DEFAULT_FORMATS, version: 1, locale: 'it' as const, context };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('variant prompt', () => {
  it('a variant\'s first turn and its requests carry its direction and the others\' as "do not copy"', () => {
    const variant = { letter: 'b' as const, count: 3, direction: 'Minimal pastello', others: [{ letter: 'a' as const, direction: 'Audace e "notturna"' }, { letter: 'c' as const, direction: null }] };
    for (const kind of ['first', 'iteration'] as const) {
      const p = buildCreativePrompt({ ...base, kind, userText: 'Più luce', variant });
      expect(p, kind).toContain('## Variant');
      expect(p).toContain('variant B of 3');
      expect(p).toContain('Your direction: "Minimal pastello"');
      expect(p).toMatch(/do not copy/i);
      // The others' directions are quoted data, one line each.
      expect(p).toContain('- A: "Audace e \\"notturna\\""');
      expect(p).toContain('- C: no direction');
      expect(p.indexOf('## Variant')).toBeLessThan(p.indexOf('## Required formats'));
    }
    // Without a direction of its own, the agent is told to pick one clearly different from the others.
    const none = buildCreativePrompt({ ...base, kind: 'first', variant: { ...variant, direction: null } });
    expect(none).toMatch(/No direction was given for this variant/);
    // A repair turn of the same version does not repeat it.
    expect(buildCreativePrompt({ ...base, kind: 'fix', problems: ['x'], variant })).not.toContain('## Variant');
  });

  it('an old creative\'s prompt is byte-identical (no variant section)', () => {
    const first = buildCreativePrompt({ ...base, kind: 'first' });
    const iteration = buildCreativePrompt({ ...base, kind: 'iteration', userText: 'Logo più grande' });
    expect(first).not.toContain('Variant');
    expect(sha(first)).toBe(GOLDEN.first);
    expect(sha(iteration)).toBe(GOLDEN.iteration);
  });
});

describe('variant prompt in a real turn', () => {
  let v: VariantApp;
  afterEach(async () => { await v?.close(); });
  it('each member\'s turn has its own direction and the others\'; a discarded sister is left out; an old creative has none', async () => {
    v = await variantApp();
    const slug = await v.group(['Audace', 'Calma', 'Retro']);
    await v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants/c/discard` });
    const res = await v.app.inject({ method: 'POST', url: `${v.url(slug)}/variants/run`, payload: { targets: 'all-active', request: null } });
    expect(res.statusCode, res.body).toBe(202);
    await vi.waitFor(() => expect(v.runner.runs).toHaveLength(2));
    const prompts = Object.fromEntries(v.runner.runs.map((r) => [/variant ([A-E]) of/.exec(r.req.prompt)?.[1], r.req.prompt]));
    expect(prompts.A).toContain('Your direction: "Audace"');
    expect(prompts.A).toContain('- B: "Calma"');
    expect(prompts.B).toContain('Your direction: "Calma"');
    expect(prompts.B).toContain('- A: "Audace"');
    for (const p of [prompts.A!, prompts.B!]) expect(p).not.toContain('Retro');
    v.runner.runs.forEach((r) => r.finish());
    await v.waitIdle();
    const old = ((await v.app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Vecchia', brief: { goal: 'x', message: '', formats: ['instagram-post-1x1'], durationSec: 10, assets: [], notes: '' }, generate: false } })).json() as { slug: string }).slug;
    await v.app.inject({ method: 'POST', url: `${v.url(old)}/turns`, payload: {} });
    const r = await v.runner.next(2);
    expect(r.req.prompt).not.toContain('## Variant');
    r.finish();
    await v.waitIdle();
  });
});

/** sha256 of the prompts above, computed on the code before phase 15 Task 3; decision 1232 (report 38) added the no will-change line. */
const GOLDEN = {
  first: '11ef06e09a64c4cffb5994db4f91b288475db0c06dc3166aa508669e66906e40',
  iteration: 'abbcc107384cb1e091caf3564571d3d465780bd220453f7135ec96eb89330af6',
};
