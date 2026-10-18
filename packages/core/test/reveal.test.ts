// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { revealTarget } from '../src/server/reveal.ts';

const base = mkdtempSync(join(tmpdir(), 'ms-test-reveal-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('Show in Finder of a folder (user report 21)', () => {
  it('selects the first visible entry inside, so Finder shows the folder itself; an empty folder is shown as it is', async () => {
    const dir = join(base, 'v3');
    mkdirSync(join(dir, '.previews'), { recursive: true });
    writeFileSync(join(dir, 'youtube-16x9.mp4'), 'x');
    writeFileSync(join(dir, 'manifest.json'), '{}');
    expect(await revealTarget(dir)).toBe(join(dir, 'manifest.json'));
    const empty = join(base, 'empty');
    mkdirSync(empty);
    expect(await revealTarget(empty)).toBe(empty);
    expect(await revealTarget(join(base, 'missing'))).toBe(join(base, 'missing'));
  });
});
