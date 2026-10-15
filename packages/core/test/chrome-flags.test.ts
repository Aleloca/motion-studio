// @vitest-environment node
/**
 * Any Chrome the tests or the product launch must not touch the user's keychain (a macOS dialog otherwise): BASE_FLAGS
 * carries the mock keychain and the basic password store, and every test file that launches the browser builds its
 * arguments from BASE_FLAGS (or from the composition-runtime test support, which does).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_FLAGS } from '../src/render/isolation.ts';

const PACKAGES = join(import.meta.dirname, '../..');

describe('Chrome launch flags', () => {
  it('BASE_FLAGS keeps Chrome away from the real keychain', () => {
    expect(BASE_FLAGS).toContain('--use-mock-keychain');
    expect(BASE_FLAGS).toContain('--password-store=basic');
  });

  it('no test launches the Chrome executable without BASE_FLAGS or the composition-runtime support', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f); else if (/\.(ts|tsx|mjs)$/.test(e.name)) files.push(f);
      }
    };
    for (const pkg of readdirSync(PACKAGES)) { try { walk(join(PACKAGES, pkg, 'test')); } catch { /* no test folder */ } }
    const launches = /(--dump-dom|--remote-debugging|--headless|execFile\w*\(\s*[\w.!]*(chrome|exe)\b|spawn\(\s*[\w.!]*(chrome|exe)\b)/;
    const safe = /BASE_FLAGS|support\/chrome|use-mock-keychain/;
    const offenders = files.filter((f) => !f.endsWith('chrome-flags.test.ts') && launches.test(readFileSync(f, 'utf8')) && !safe.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.slice(PACKAGES.length + 1))).toEqual([]);
  });
});
