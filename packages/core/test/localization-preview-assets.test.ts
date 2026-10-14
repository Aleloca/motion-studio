// @vitest-environment node
/**
 * A localized preview's fonts and voices (Phase 12, Task 5): the route attaches the files the row recorded a hash for,
 * the composition server serves them under the session token; nothing else.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalizationRow } from '@motion-studio/shared';
import { readOverlay, setLocalizationRow, writeOverlay } from '../src/localization/store.ts';
import { H, startInstanceEnv, UI_ORIGIN, type InstanceEnv } from './helpers/instance-server.ts';

let env: InstanceEnv;
beforeEach(async () => { env = await startInstanceEnv('ms-test-l10n-preview-'); });
afterEach(async () => { await env?.close(); });

const sha = (b: string) => createHash('sha256').update(b).digest('hex');
const base = (slug: string, rest: string) => `/api/projects/acme/creatives/${slug}/versions/1/localizations/ja/test-wide/${rest}`;

async function setup() {
  const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['ja'] } });
  const put = await env.app.inject({ method: 'PUT', url: base(slug, '').replace(/\/$/, ''), headers: H, payload: { texts: { title: 'こんにちは' } } });
  expect(put.statusCode, put.body).toBe(200);
  const dir = join(env.projectDir(), 'assets');
  mkdirSync(join(dir, 'fonts'), { recursive: true });
  mkdirSync(join(dir, 'audio'), { recursive: true });
  writeFileSync(join(dir, 'fonts', 'NotoSansJP-400.woff2'), 'font-bytes');
  writeFileSync(join(dir, 'audio', 'voice.mp3'), 'voice-bytes');
  writeFileSync(join(dir, 'audio', 'other.mp3'), 'other');
  const creativeDir = env.store().dir(slug);
  const { overlay } = (await readOverlay(creativeDir, 1, 'ja', 'test-wide'))!;
  overlay.fonts = [{ family: 'Noto Sans JP', files: ['assets/fonts/NotoSansJP-400.woff2'] }];
  const hash = await writeOverlay(creativeDir, 1, overlay);
  const row = (await env.versionOf(slug, 1))!.localizations![0]!;
  const next: LocalizationRow = { ...row, hash, assetHashes: { 'assets/fonts/NotoSansJP-400.woff2': sha('font-bytes'), 'assets/audio/other.mp3': sha('other') } };
  await setLocalizationRow(env.store(), slug, 1, next);
  const mint = (await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/preview-session`, headers: H, payload: { format: 'test-wide', parentOrigin: UI_ORIGIN } })).json() as { url: string; token: string; origin: string };
  return { slug, mint };
}

describe('preview assets of a localized preview', { timeout: 120_000 }, () => {
  it('serves the overlay\'s hashed font and nothing the overlay does not use', async () => {
    const { slug, mint } = await setup();
    const root = `${mint.origin}/${mint.token}/outputs/v1/compositions/test-wide`;
    const fetchStatus = async (rel: string) => (await fetch(`${root}/${rel}`)).status;
    expect(await fetchStatus('assets/fonts/NotoSansJP-400.woff2')).toBe(404);
    const r = await env.app.inject({ method: 'POST', url: base(slug, 'preview-assets'), headers: H, payload: { token: mint.token } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ files: ['assets/fonts/NotoSansJP-400.woff2'] });
    const res = await fetch(`${root}/assets/fonts/NotoSansJP-400.woff2`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('font-bytes');
    // In the row's hashes but not used by the overlay, and a file the row has no hash for: never served.
    expect(await fetchStatus('assets/audio/other.mp3')).toBe(404);
    expect(await fetchStatus('assets/audio/voice.mp3')).toBe(404);
    // A font changed since: refused at the request.
    writeFileSync(join(env.projectDir(), 'assets', 'fonts', 'NotoSansJP-400.woff2'), 'tampered');
    expect(await fetchStatus('assets/fonts/NotoSansJP-400.woff2')).toBe(404);
  });
  it('refuses a session that shows another version or format than the row', async () => {
    const { slug } = await setup();
    const url = base(slug, 'preview-assets');
    // A session of the same creative but another format (the post is not the row's format).
    await env.turn(slug, { text: 'again' });
    const other = (await env.app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/2/preview-session`, headers: H, payload: { format: 'test-wide', parentOrigin: UI_ORIGIN } })).json() as { token: string };
    expect((await env.app.inject({ method: 'POST', url, headers: H, payload: { token: other.token } })).statusCode).toBe(404);
  });
  it('refuses an unknown session, another language\'s missing row, a bad body and a request without the UI token', async () => {
    const { slug, mint } = await setup();
    const url = base(slug, 'preview-assets');
    expect((await env.app.inject({ method: 'POST', url, headers: H, payload: { token: 'a'.repeat(43) } })).statusCode).toBe(404);
    expect((await env.app.inject({ method: 'POST', url, headers: H, payload: { token: 'short' } })).statusCode).toBe(400);
    expect((await env.app.inject({ method: 'POST', url, headers: H, payload: { token: mint.token, extra: 1 } })).statusCode).toBe(400);
    expect((await env.app.inject({ method: 'POST', url: url.replace('/ja/', '/de/'), headers: H, payload: { token: mint.token } })).statusCode).toBe(404);
    expect((await env.app.inject({ method: 'POST', url, payload: { token: mint.token } })).statusCode).toBe(401);
  });
});
