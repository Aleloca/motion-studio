import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = join(import.meta.dirname, '..', '..', '..');
const tsx = join(root, 'node_modules', '.bin', 'tsx');
const main = join(root, 'apps', 'cli', 'src', 'main.ts');
let configDir: string;
beforeAll(async () => { configDir = await mkdtemp(join(tmpdir(), 'ms-cli-help-')); });
afterAll(async () => { await rm(configDir, { recursive: true, force: true }); });

// A throwaway config folder (no saved language), and every locale variable set explicitly.
const help = async (lang: string) => {
  const { stdout } = await run(tsx, [main, '--help'], {
    env: { ...process.env, MOTION_STUDIO_CONFIG_DIR: configDir, LANG: lang, LC_ALL: '', LC_MESSAGES: '' },
  });
  return stdout;
};

describe('motion-studio --help', () => {
  it('is English with LANG=en_US.UTF-8', async () => {
    const out = await help('en_US.UTF-8');
    expect(out).toContain('Usage: npx @motion-studio/cli');
    expect(out).toContain('Starts Motion Studio locally');
  }, 20_000);
  it('is Italian with LANG=it_IT.UTF-8', async () => {
    const out = await help('it_IT.UTF-8');
    expect(out).toContain('Uso: npx @motion-studio/cli');
    expect(out).toContain('Avvia Motion Studio in locale');
  }, 20_000);
});
