// @vitest-environment node
/**
 * Phase 12, Ruling M: the core gives each problem of a translation its code and clip (`row.issues`), next to the sentence in
 * `problems`; the outdated entries are issues too. Two clips with the same name are told apart by their ids.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messages, type Composition, type FormatPreset, type LocalizationRow, type VersionEntry } from '@motion-studio/shared';
import { readCompositionFolder } from '../src/compositions/composition-files.ts';
import { currentLocale } from '../src/i18n.ts';
import { issueFields, withIssues, withoutIssues } from '../src/localization/issues.ts';
import { emptyOverlay, finishOverlay, instanceComposition } from '../src/localization/store.ts';
import { H, startInstanceEnv, type InstanceEnv } from './helpers/instance-server.ts';

const PRESETS: FormatPreset[] = [{ id: 'test-wide', channel: 'Test', name: 'Wide', width: 320, height: 180, kind: 'video', extensions: ['mp4'] }];
const v = () => messages(currentLocale()).variants;

describe('issue fields', () => {
  const row: LocalizationRow = { locale: 'de', instanceId: 'x', hash: 'a'.repeat(64), origin: 'agent', stale: ['a'], voice: 'original' };
  it('problems carry the sentences (stale only in issues), no duplicates', () => {
    const f = issueFields([
      { code: 'stale', clipId: 'a', message: 'old' }, { code: 'textOverflow', clipId: 'b', message: 'too long' }, { code: 'textOverflow', clipId: 'b', message: 'too long' },
    ]);
    expect(f.problems).toEqual(['too long']);
    expect(f.issues).toHaveLength(2);
    expect(issueFields([])).toEqual({});
  });
  it('adds and removes issues with their sentences; a sentence from an older row stays', () => {
    const old = { ...row, problems: ['legacy sentence'] };
    const added = withIssues(old, [{ code: 'assetChanged', message: 'changed' }]);
    expect(added.problems).toEqual(['legacy sentence', 'changed']);
    expect(added.issues).toEqual([{ code: 'assetChanged', message: 'changed' }]);
    const cleared = withoutIssues(added, (i) => i.code === 'assetChanged');
    expect(cleared.problems).toEqual(['legacy sentence']);
    expect(cleared.issues).toBeUndefined();
  });
});

describe('finishOverlay issues', () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ms-test-l10n-issues-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('flags the very clip, even when two clips share a name; an outdated entry is an issue of its clip', async () => {
    const comp = {
      $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 2, background: '#101010', fonts: [{ family: 'Mono', src: 'assets/Mono.woff2', weight: 400 }], scenes: [],
      tracks: [{ id: 'v', kind: 'visual', clips: [
        { id: 'h1', name: 'Headline', type: 'text', start: 0, duration: 2, props: { x: 10, y: 10, width: 100, height: 30, text: 'Hi', fontSize: 20, color: '#ffffff' } },
        { id: 'h2', name: 'Headline', type: 'text', start: 0, duration: 2, props: { x: 10, y: 60, width: 100, height: 30, text: 'Yo', fontSize: 20, color: '#ffffff' } },
      ] }],
    } as unknown as Composition;
    const dir = join(base, 'outputs', 'v1', 'compositions', 'test-wide');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'Mono.woff2'), 'wOF2');
    writeFileSync(join(dir, 'composition.json'), JSON.stringify(comp));
    const version = { n: 1, compositions: [{ format: 'test-wide', dir: 'compositions/test-wide', hash: (await readCompositionFolder(dir)).hash }] } as VersionEntry;
    const ic = (await instanceComposition(base, version, 'test-wide', PRESETS))!;
    const long = 'Herzlich willkommen zur brandneuen Version unserer wunderbaren Anwendung für alle Geräte';
    const overlay = { ...emptyOverlay('de', 'test-wide'), texts: { h1: { source: 'Hi', text: long }, h2: { source: 'Hey', text: 'Hallo' } } };
    const done = await finishOverlay({ overlay, base: ic, voice: 'original', chooseFit: new Set(['h1']), uiLocale: currentLocale(), projectDir: base, voiceRoots: [ic.compDir, base] });
    expect(done.stale).toEqual(['h2']);
    expect(done.issues).toEqual([
      { code: 'stale', clipId: 'h2', message: v().staleEntry({ clip: 'Headline' }) },
      { code: 'textOverflow', clipId: 'h1', message: v().textOverflow({ clip: 'Headline' }) },
    ]);
    expect(done.problems).toEqual([v().textOverflow({ clip: 'Headline' })]);
    expect(issueFields(done.issues).problems).toEqual(done.problems);
  });
});

describe('issues on the routes', { timeout: 120_000 }, () => {
  let env: InstanceEnv;
  beforeEach(async () => { env = await startInstanceEnv('ms-test-l10n-issues-routes-'); });
  afterEach(async () => { await env?.close(); });
  const url = (slug: string, rest = '') => `/api/projects/acme/creatives/${slug}/versions/1/localizations${rest}`;

  it('PUT stores the overflow with its clip; GET and the localized composition answer the issues', async () => {
    const slug = await env.create(['test-wide'], { links: {}, locales: { primary: 'en', extra: ['de'] } });
    const long = 'Herzlich willkommen zur brandneuen Version unserer wunderbaren Anwendung für alle Geräte';
    const put = await env.app.inject({ method: 'PUT', url: url(slug, '/de/test-wide'), headers: H, payload: { texts: { title: long } } });
    expect(put.statusCode, put.body).toBe(200);
    const issue = { code: 'textOverflow', clipId: 'title', message: v().textOverflow({ clip: 'Title' }) };
    expect(put.json().issues).toEqual([issue]);
    expect((await env.versionOf(slug, 1))!.localizations![0]!.issues).toEqual([issue]);
    expect((await env.app.inject({ url: url(slug, '/de/test-wide'), headers: H })).json().issues).toEqual([issue]);
    const comp = await env.app.inject({ url: `/api/projects/acme/creatives/${slug}/versions/1/compositions/test-wide?locale=de`, headers: H });
    expect(comp.json().localization.issues).toEqual([issue]);
    // A short text clears it, and the row has no issues at all.
    const ok = await env.app.inject({ method: 'PUT', url: url(slug, '/de/test-wide'), headers: H, payload: { texts: { title: 'Hallo' } } });
    expect(ok.json().issues).toBeUndefined();
  });
});
