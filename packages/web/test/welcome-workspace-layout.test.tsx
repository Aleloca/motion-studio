/**
 * Report 92: onboarding step 2 in real Chrome (1440 × 900, light): the folder field starts filled with the suggested folder
 * of this computer (a Windows path with backslashes here), no placeholder, Continue enabled, the plain hint under the field.
 * Without Chrome the test is skipped (MS_REQUIRE_CHROME=1 makes a missing browser a failure). MS_LAYOUT_SHOTS=<folder> saves a screenshot.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';

vi.mock('../src/api.ts', () => ({ api: { listProjects: vi.fn(async () => []), setWorkspace: vi.fn() }, ApiError: class extends Error {} }));
const { Welcome } = await import('../src/screens/Welcome.tsx');

const src = (p: string) => readFileSync(join(import.meta.dirname, '../src', p), 'utf8');
const CSS = ['theme.css', 'ui/ui.css', 'screens/welcome.css'].map(src).join('\n');
const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const shots = process.env.MS_LAYOUT_SHOTS ?? null;
const SUGGESTED = 'C:\\Users\\Giulia\\MotionStudio';
const checks = [{ id: 'claude', label: 'Claude Code', ok: true, required: true, version: '2.1.293', message: 'Installato' }];

const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('onboarding workspace step: real Chrome (report 92)', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-welcome-ws-')); browser = await launchChrome(chrome!); }, 60_000);
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  it('shows the suggested folder in the field and Continue enabled', async () => {
    const { container, unmount } = render(<I18nProvider locale="it"><Welcome step={2} checks={checks as never} loadError={null} workspace={{ path: null, settings: null, error: null, suggestedPath: SUGGESTED }}
      onRecheck={() => {}} onWorkspace={() => {}} onFinish={() => {}} /></I18nProvider>);
    const html = container.innerHTML;
    unmount();
    const file = join(dir, 'welcome.html');
    writeFileSync(file, `<!doctype html><html lang="it" data-theme="light"><head><meta charset="utf-8"><style>${CSS} html,body{height:100%;margin:0}</style></head><body>${html}</body></html>`);
    const tab = await browser.newPage(1440, 900);
    try {
      await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await tab.goto(`file://${file}`);
      const r = await tab.eval<{ value: string; placeholder: string; hint: string; disabled: boolean }>(`(() => {
        const i = document.querySelector('#ms-ws-path');
        const next = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Continua');
        return { value: i.value, placeholder: i.placeholder, hint: document.querySelector('.ms-ws-status').textContent, disabled: next.disabled };
      })()`, 30_000);
      if (shots) writeFileSync(join(shots, 'onb-workspace.png'), await tab.screenshot());
      expect(r.value).toBe(SUGGESTED);
      expect(r.placeholder).toBe('');
      expect(r.hint).toBe("Va bene quella proposta: se non esiste Motion Studio la crea. Puoi sceglierne un'altra.");
      expect(r.disabled).toBe(false);
    } finally { await tab.close(); }
  }, 120_000);
});
