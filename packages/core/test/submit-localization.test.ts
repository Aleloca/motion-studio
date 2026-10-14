// @vitest-environment node
/**
 * `submit_localization` (Phase 12, Task 4): the only way a localize turn writes. Validated (strict arguments, only the
 * turn's languages and formats, only translatable ids of the right kind, schema lengths, fit 0.7–1), merged into the overlay
 * under the creative's lock (sources always from the composition), checked on the localized composition, and answered at
 * once with the problems so the agent can shorten within the same attempt.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPOSITION_LIMITS, messages, type Localization } from '@motion-studio/shared';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { currentLocale } from '../src/i18n.ts';
import { H, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

let env: InstanceEnv;
let log: string;
afterEach(async () => { await env?.close(); });

const v = () => messages(currentLocale()).variants;

async function boot() {
  const bridge = new AgentBridge();
  env = await startInstanceEnv('ms-test-submit-l10n-', { bridge });
  bridge.setOrigin(await env.app.listen({ port: 0, host: '127.0.0.1' }));
  log = join(env.base, 'bridge.jsonl');
  process.env.FAKE_CLAUDE_BRIDGE_LOG = log;
}
const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; fix: boolean; status: number; body: Record<string, unknown> });
const submit = (args: object) => ['submit_localization', args] as const;
const full = (locale: string, instanceId: string, rest: object = {}) => ({ locale, instanceId, texts: {}, params: {}, voiceScripts: {}, fit: {}, ...rest });
const overlayOf = (slug: string, n: number, locale: string, inst: string) =>
  JSON.parse(readFileSync(join(env.store().dir(slug), 'outputs', `v${n}`, 'locales', locale, `${inst}.json`), 'utf8')) as Localization;
async function localize(slug: string, body: object) {
  const r = await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/localize`, headers: H, payload: body });
  expect(r.statusCode, r.body).toBe(202);
  const done = await env.waitJob((r.json() as { jobId: string }).jobId);
  expect(done.state, done.error).toBe('succeeded');
}

describe('submit_localization', { timeout: 120_000 }, () => {
  it('refuses what a translation may not carry, with the reasons, and writes nothing for it', async () => {
    await boot();
    process.env.FAKE_CLAUDE_VOICE = '1';
    const slug = await env.create(['test-wide', 'test-tall'], { links: {}, locales: { primary: 'en', extra: ['de', 'fr'] } });
    process.env.FAKE_CLAUDE_LOCALIZE_CALLS = JSON.stringify([
      submit(full('de', 'test-wide', { texts: { nope: 'x' } })),             // unknown clip
      submit(full('de', 'test-wide', { texts: { bg: 'x' } })),               // not a text clip
      submit(full('de', 'test-wide', { texts: { title: 'x'.repeat(COMPOSITION_LIMITS.text + 1) } })), // too long
      submit(full('de', 'test-wide', { fit: { title: 0.5 } })),              // fit out of range
      submit(full('de', 'test-wide', { fit: { title: 0.9 } })),              // fit of a text not translated
      submit(full('de', 'test-wide', { voiceScripts: { vo2: 'x' } })),       // a voice without a known script
      submit(full('de', 'test-wide', { voiceScripts: { title: 'x' } })),     // not a voice clip
      submit({ ...full('de', 'test-wide'), props: { x: 1 } }),               // a field the overlay never has
      submit(full('fr', 'test-wide', { texts: { title: 'Bonjour' } })),      // a language not in this turn
      submit(full('de', 'test-tall', { texts: { title: 'Hallo' } })),        // a format not in this turn
      submit(full('de', '../evil', { texts: { title: 'Hallo' } })),
      submit({ locale: 'de' }),
      submit(full('de', 'test-wide', { texts: { title: '  ' } })),     // a blank translation
    ]);
    await localize(slug, { locales: ['de'], formats: ['test-wide'] });
    const results = calls().filter((c) => c.tool === 'submit_localization' && !c.fix);
    expect(results).toHaveLength(13);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(false);
      expect((r.body.errors as string[]).length).toBeGreaterThan(0);
    }
    expect((results[0]!.body.errors as string[])[0]).toBe(v().localizationMismatch({ entry: 'nope' }));
    expect((await env.versionOf(slug, 1))!.localizations).toBeUndefined();
  });

  it('merges into the overlay (sources from the composition), writes the row as the agent\'s, and returns the problems at once', async () => {
    await boot();
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['de'] } });
    const long = 'Herzlich willkommen zur brandneuen Version unserer wunderbaren Anwendung für alle Geräte und Menschen';
    process.env.FAKE_CLAUDE_LOCALIZE_CALLS = JSON.stringify([
      submit(full('de', 'test-wide', { texts: { title: long } })),
      submit(full('de', 'test-wide', { texts: { title: 'Willkommen' }, fit: { title: 0.9 } })),
      // A later call without the title keeps it (merge), and an explicit fit is kept as given.
      submit(full('de', 'test-wide')),
    ]);
    await localize(slug, { locales: ['de'] });
    const [a, b, c] = calls().filter((x) => x.tool === 'submit_localization');
    // A renderer is free: the browser's measure decides (P5), at the 70% the core tried last.
    expect(a!.body).toEqual({ ok: true, problems: [v().textOverflowMeasured({ clip: 'Title', fit: 70 })] });
    expect(b!.body).toEqual({ ok: true, problems: [] });
    expect(c!.body).toEqual({ ok: true, problems: [] });
    const o = overlayOf(slug, 1, 'de', 'test-wide');
    expect(o.texts).toEqual({ title: { source: 'Hello', text: 'Willkommen' } });
    expect(o.fit).toEqual({ title: 0.9 });
    const row = (await env.versionOf(slug, 1))!.localizations!.find((r) => r.locale === 'de')!;
    expect(row).toMatchObject({ origin: 'agent', stale: [], voice: 'original' });
    expect(row.problems).toBeUndefined();
    // Only one agent attempt: nothing was left open.
    expect(calls().some((x) => x.fix)).toBe(false);
  });

  it('two instances sharing one composition (a follower) get the same overlay from one call', async () => {
    await boot();
    const slug = await env.create(['test-wide', 'test-wide-b'], { links: { 'test-wide-b': 'test-wide' }, locales: { primary: 'en', extra: ['de'] } });
    process.env.FAKE_CLAUDE_LOCALIZE_CALLS = JSON.stringify([submit(full('de', 'test-wide', { texts: { title: 'Hallo' } }))]);
    await localize(slug, { locales: ['de'] });
    const prompt = env.promptTexts().at(-1)!;
    expect(prompt).toContain('also used by test-wide-b');
    expect(overlayOf(slug, 1, 'de', 'test-wide-b').texts.title!.text).toBe('Hallo');
    expect(overlayOf(slug, 1, 'de', 'test-wide-b').instanceId).toBe('test-wide-b');
    const rows = (await env.versionOf(slug, 1))!.localizations!;
    expect(rows.map((r) => r.instanceId).sort()).toEqual(['test-wide', 'test-wide-b']);
  });
});
