import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Phase 14 fixture codebase (Tailwind config, public/logo.svg, public/manifest.json, src/theme.css, fake .env files). */
export const BRAND_CODEBASE_FIXTURE = fileURLToPath(new URL('../fixtures/brand-codebase', import.meta.url));

/**
 * A temp copy of the fixture codebase (real path), made a git repository with one commit when `git` is true: never a
 * committed nested .git. Hooks are disabled for the commit.
 */
export async function fixtureCodebase(opts: { git?: boolean; name?: string } = {}): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'ms-cb-')));
  const dir = join(parent, opts.name ?? 'acme-app');
  await cp(BRAND_CODEBASE_FIXTURE, dir, { recursive: true });
  if (opts.git !== false) {
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-C', dir, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
  }
  return dir;
}

/** The fake value written in the fixture's `.env` files: only ever compared, never printed. */
export const FIXTURE_SECRET_MARKER = 'ms-fixture-fake-marker-not-a-secret';
