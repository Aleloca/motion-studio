// @vitest-environment node
/**
 * Phase 15, final wave I3 (orchestrator ruling on decisions log 854): a group export renders a missing translation on demand,
 * in the member the selection picked, exactly like a single creative's export: "Renderizza comunque" (`force`) for one with
 * open problems, a translation rendered now with problems left out and listed (Ruling J), a languages-only export never
 * skipping a source silently, and a render error reported with its own message.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages } from '@motion-studio/shared';
import { currentLocale } from '../src/i18n.ts';
import { H, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

let env: InstanceEnv;
let dest: string;
beforeEach(async () => { env = await startInstanceEnv('ms-test-group-locale-'); dest = mkdtempSync(join(tmpdir(), 'ms-test-group-locale-dest-')); });
afterEach(async () => { await env?.close(); rmSync(dest, { recursive: true, force: true }); });

const LONG = 'Herzlich willkommen zur brandneuen Version unserer wunderbaren Anwendung für alle Geräte';
const P = '/api/projects/acme/creatives';
const put = (slug: string, inst: string, title: string) =>
  env.app.inject({ method: 'PUT', url: `${P}/${slug}/versions/1/localizations/de/${encodeURIComponent(inst)}`, headers: H, payload: { texts: { title } } });
const exportGroup = (slug: string, payload: object) => env.app.inject({ method: 'POST', url: `${P}/${slug}/export-group`, headers: H, payload: { destination: dest, ...payload } });

/** A group of two whose B starts from A's v1 (its own v1, same compositions), with the ★ of test-wide on B. */
async function group(): Promise<{ host: string; b: string }> {
  const host = await env.create(['test-wide', 'test-tall'], { links: {}, locales: { primary: 'en', extra: ['de'] } });
  const made = await env.app.inject({ method: 'POST', url: `${P}/${host}/variants`, headers: H, payload: { count: 2, baseFrom: { slug: host, version: 1 } } });
  expect(made.statusCode, made.body).toBe(201);
  const b = `${host}~b`;
  const pick = await env.app.inject({ method: 'PUT', url: `${P}/${host}/variants/picks/test-wide`, headers: H, payload: { slug: b, version: 1 } });
  expect(pick.statusCode, pick.body).toBe(200);
  return { host, b };
}

describe('group export translations', { timeout: 120_000 }, () => {
  it('a translation with no render is rendered now in its own member (the ★ variant) and exported', async () => {
    const { host, b } = await group();
    expect((await put(b, 'test-wide', 'Hallo')).statusCode).toBe(200);
    const r = await exportGroup(host, { formats: ['test-wide'], locales: ['en', 'de'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(readdirSync(dest).sort()).toEqual(['launch-test-wide-v1-de.mp4', 'launch-test-wide-v1.mp4']);
    expect((r.json() as { unavailable: unknown[] }).unavailable).toEqual([]);
    // Rendered in B's folder (the member the selection picked), never in A's.
    const outs = env.fake.renders.map((x) => x.out);
    expect(outs).toContain(join(env.store().dir(b), 'outputs', 'v1', 'test-wide.de.mp4'));
    expect(outs.some((o) => o.startsWith(env.store().dir(host) + '/') && o.endsWith('.de.mp4'))).toBe(false);
  });

  it('open problems: 409 localization-needs-force (the "Renderizza comunque" flow); with force it is rendered and exported', async () => {
    const { host, b } = await group();
    expect((await put(b, 'test-wide', LONG)).json().problems).toHaveLength(1);
    const refused = await exportGroup(host, { formats: ['test-wide'], locales: ['de'] });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'localization-needs-force' });
    expect((refused.json() as { problems: string[] }).problems.length).toBeGreaterThan(0);
    expect(readdirSync(dest)).toEqual([]);
    const ok = await exportGroup(host, { formats: ['test-wide'], locales: ['de'], force: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(readdirSync(dest)).toEqual(['launch-test-wide-v1-de.mp4']);
  });

  it('Ruling J: a translation rendered now with problems is left out and listed, copied once seen', async () => {
    const { host, b } = await group();
    await put(b, 'test-wide', 'Hallo');
    env.fake.overflows = ['title'];
    const r = await exportGroup(host, { formats: ['test-wide'], locales: ['de'] });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { files: unknown[]; unavailable: Array<{ format: string; letter: string; locale?: string; message: string }> };
    expect(body.files).toEqual([]);
    expect(body.unavailable).toEqual([expect.objectContaining({ format: 'test-wide', letter: 'b', locale: 'de' })]);
    expect(body.unavailable[0]!.message).toContain(messages(currentLocale()).export.groupReason.renderProblems({ list: '' }).trim().split(':')[0]!);
    env.fake.overflows = [];
    const again = await exportGroup(host, { formats: ['test-wide'], locales: ['de'] });
    expect(again.statusCode, again.body).toBe(200);
    expect(readdirSync(dest)).toEqual(['launch-test-wide-v1-de.mp4']);
  });

  it('languages only: a source with no primary render is not skipped (its translation is rendered, as for a single creative); one without translation is listed', async () => {
    const { host, b } = await group();
    await put(b, 'test-wide', 'Hallo');
    const plan = (await env.app.inject({ url: `${P}/${host}/export-group`, headers: H })).json() as { items: Array<{ format: string; state: string }> };
    expect(plan.items.map((i) => [i.format, i.state])).toEqual([['test-wide', 'needs-render'], ['test-tall', 'needs-render']]);
    const r = await exportGroup(host, { locales: ['de'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(readdirSync(dest)).toEqual(['launch-test-wide-v1-de.mp4']);
    const body = r.json() as { unavailable: Array<{ format: string; letter: string; locale?: string; message: string }> };
    expect(body.unavailable.map((u) => [u.format, u.letter, u.locale])).toEqual([['test-tall', 'a', 'de']]);
    expect(body.unavailable[0]!.message).toContain(messages(currentLocale()).export.groupReason.noTranslation({ locale: 'de' }));
    // Only the translation was rendered: the primary-language files of a languages-only export are not.
    expect(env.fake.renders.map((x) => x.out.split('/').pop())).toEqual(['test-wide.de.mp4']);
  });

  it('deferred 100: a source render that fails is reported with its own error, not the generic "not rendered"', async () => {
    const { host } = await group();
    env.fake.after = () => { throw new Error('boom from the renderer'); };
    const r = await exportGroup(host, { formats: ['test-tall'] });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { unavailable: Array<{ format: string; message: string }> };
    expect(body.unavailable).toHaveLength(1);
    expect(body.unavailable[0]!.message).not.toContain(messages(currentLocale()).export.groupReason.notRendered);
    expect(body.unavailable[0]!.message).toContain('boom from the renderer');
  });
});
