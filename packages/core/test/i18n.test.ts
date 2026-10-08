import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@motion-studio/shared';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { currentLocale, detectSystemLocales, LanguageController, setLocale, t } from '../src/i18n.ts';
import { buildServer } from '../src/server/app.ts';
import { startServer } from '../src/server/main.ts';
import { MemoryVault } from '../src/secrets/vault.ts';

describe('locale state', () => {
  it('switches the catalog returned by t()', () => {
    setLocale('en');
    expect(currentLocale()).toBe('en');
    const en = t();
    setLocale('it');
    expect(currentLocale()).toBe('it');
    expect(t()).not.toBe(en);
  });
});

describe('detectSystemLocales', () => {
  const intl = () => Intl.DateTimeFormat().resolvedOptions().locale;
  it('normalises POSIX variables, ignores C/POSIX, then falls back to Intl', () => {
    expect(detectSystemLocales({ LANG: 'it_IT.UTF-8' })).toEqual(['it-IT', intl()]);
    expect(detectSystemLocales({ LC_ALL: 'de_DE.UTF-8', LC_MESSAGES: 'C', LANG: 'it_IT.UTF-8' })).toEqual(['de-DE', 'it-IT', intl()]);
    expect(detectSystemLocales({ LC_ALL: 'POSIX', LANG: 'C' })).toEqual([intl()]);
    expect(detectSystemLocales({})).toEqual([intl()]);
  });
});

describe('AppConfigStore language', () => {
  it('persists the language setting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-lang-'));
    const store = new AppConfigStore(dir);
    expect((await store.read()).language).toBe('system');
    expect(await store.setLanguage('en')).toMatchObject({ language: 'en', workspacePath: null });
    expect((await new AppConfigStore(dir).read()).language).toBe('en');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('language routes', () => {
  let base: string;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let language: LanguageController;
  const TOKEN = 'ab12'.repeat(16);
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'ms-lang-'));
    language = new LanguageController('system', ['de-DE']);
    language.apply();
    app = await buildServer({
      uiToken: TOKEN, language, sandbox: async () => ({ available: false, reason: 'test' }),
      appConfig: new AppConfigStore(join(base, 'config')), git: new Git(),
      runner: new ClaudeCodeRunner(['true']),
      doctor: async () => [],
    });
  });
  afterEach(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });
  const headers = { 'x-motion-studio-ui': TOKEN };

  it('reports the current language', async () => {
    const res = await app.inject({ url: '/api/settings/language', headers });
    expect(res.json()).toEqual({ locale: 'en', languageSetting: 'system' });
  });
  it('requires the UI token and rejects unknown values', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/settings/language', payload: { language: 'it' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/language', headers, payload: { language: 'de' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/language', headers, payload: {} })).statusCode).toBe(400);
    expect(currentLocale()).toBe('en');
  });
  it('saves, switches the core language and broadcasts', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events?t=${TOKEN}`);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    const seen: string[] = [];
    language.onChange((locale) => seen.push(locale));
    const res = await app.inject({ method: 'PUT', url: '/api/settings/language', headers, payload: { language: 'it' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ locale: 'it', languageSetting: 'it' });
    expect(currentLocale()).toBe('it');
    expect(seen).toEqual(['it']);
    expect((await new AppConfigStore(join(base, 'config')).read()).language).toBe('it');
    for (let i = 0; i < 100 && !messages.some((m) => m.type === 'locale'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(messages[0]).toMatchObject({ type: 'snapshot', locale: 'en', languageSetting: 'system' });
    expect(messages).toContainEqual({ type: 'locale', locale: 'it', setting: 'it' });
    // 'system' goes back to the detected language (de-DE → en).
    const back = await app.inject({ method: 'PUT', url: '/api/settings/language', headers, payload: { language: 'system' } });
    expect(back.json()).toEqual({ locale: 'en', languageSetting: 'system' });
    ws.close();
  });
});

describe('startServer language', () => {
  const boot = async (systemLocales: string[]) => {
    const configDir = await mkdtemp(join(tmpdir(), 'ms-lang-'));
    const s = await startServer({ port: 0 as never, configDir, claudeCommand: ['true'], vault: new MemoryVault(), systemLocales });
    return { s, configDir };
  };
  it.each([[['de-DE'], 'en'], [['it-IT'], 'it'], [['fr', 'it'], 'it'], [[], 'en']] as const)('system %j → %s', async (sys, expected) => {
    setLocale(expected === 'en' ? 'it' : 'en');
    const { s, configDir } = await boot([...sys]);
    try {
      expect(s.locale()).toBe(expected);
      expect(currentLocale()).toBe(expected);
    } finally { await s.close(); await rm(configDir, { recursive: true, force: true }); }
  });
  it('a saved language wins over the system and onLocaleChange follows API changes', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'ms-lang-'));
    await new AppConfigStore(configDir).setLanguage('en');
    const s = await startServer({ port: 0 as never, configDir, claudeCommand: ['true'], vault: new MemoryVault(), systemLocales: ['it-IT'] });
    try {
      expect(s.locale()).toBe('en');
      const seen: string[] = [];
      s.onLocaleChange((l) => seen.push(l));
      const token = (await import('../src/server/ui-token.ts').then((m) => m.loadOrCreateUiToken(configDir)));
      const res = await fetch(`${s.url}/api/settings/language`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-motion-studio-ui': token }, body: JSON.stringify({ language: 'it' }) });
      expect(res.status).toBe(200);
      expect(seen).toEqual(['it']);
      expect(s.locale()).toBe('it');
    } finally { await s.close(); await rm(configDir, { recursive: true, force: true }); }
  });
});
