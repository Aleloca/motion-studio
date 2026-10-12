import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearCompositionHashMemoForTests, compositionHashReads, readCompositionFolder } from '../src/compositions/composition-files.ts';

// Final wave C4: the folder is not hashed again at every mint, but any change is seen.
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; clearCompositionHashMemoForTests(); });
const old = new Date(Date.now() - 60_000);
function make() {
  dir = mkdtempSync(join(tmpdir(), 'ms-test-hash-memo-'));
  mkdirSync(join(dir, 'assets'));
  for (const [f, c] of [['composition.json', '{}'], ['assets/a.bin', 'aaaa']] as const) { writeFileSync(join(dir, f), c); utimesSync(join(dir, f), old, old); }
}

describe('readCompositionFolder memoises file hashes (C4)', () => {
  it('a settled, unchanged folder is hashed once (2 files, 2 reads for 2 calls); same hash', async () => {
    make();
    // ctime cannot be backdated: wait past the settle window by making the check relative (the files were just written).
    await new Promise((r) => setTimeout(r, 1100));
    const before = compositionHashReads();
    const a = await readCompositionFolder(dir);
    const b = await readCompositionFolder(dir);
    expect(b.hash).toBe(a.hash);
    expect(compositionHashReads() - before).toBe(2);
  });
  it('a changed file (same size, same mtime restored) is hashed again and the hash changes', async () => {
    make();
    await new Promise((r) => setTimeout(r, 1100));
    const a = await readCompositionFolder(dir);
    writeFileSync(join(dir, 'assets/a.bin'), 'bbbb');
    utimesSync(join(dir, 'assets/a.bin'), old, old);
    const b = await readCompositionFolder(dir);
    expect(b.hash).not.toBe(a.hash);
  });
  it('a file changed a moment ago is never remembered', async () => {
    make();
    const before = compositionHashReads();
    await readCompositionFolder(dir);
    await readCompositionFolder(dir);
    expect(compositionHashReads() - before).toBe(4);
  });
});
