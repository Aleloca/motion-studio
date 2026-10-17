// @vitest-environment node
/** Decision 915: the core's own Trash, always on a temp home (never the user's real Trash). */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { moveToTrash, noTrash } from '../src/trash.ts';

const folder = async (root: string, name: string) => {
  const p = join(root, 'ws', name);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, 'creative.json'), '{}');
  return p;
};

describe('moveToTrash', () => {
  it('macOS: renames into ~/.Trash under a free name', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ms-trash-'));
    await moveToTrash(await folder(home, 'a/lancio'), { platform: 'darwin', home });
    await moveToTrash(await folder(home, 'b/lancio'), { platform: 'darwin', home });
    expect((await readdir(join(home, '.Trash'))).sort()).toEqual(['lancio', 'lancio 2']);
    expect(await readFile(join(home, '.Trash', 'lancio 2', 'creative.json'), 'utf8')).toBe('{}');
    expect(await readdir(join(home, 'ws', 'a'))).toEqual([]);
  });

  it('Linux: freedesktop Trash with its .trashinfo', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ms-trash-'));
    const p = await folder(home, 'lancio');
    await moveToTrash(p, { platform: 'linux', home, env: {}, now: new Date(2026, 9, 17, 9, 5, 7) });
    const root = join(home, '.local', 'share', 'Trash');
    expect(await readdir(join(root, 'files'))).toEqual(['lancio']);
    expect(await readFile(join(root, 'info', 'lancio.trashinfo'), 'utf8')).toBe(`[Trash Info]\nPath=${encodeURI(p)}\nDeletionDate=2026-10-17T09:05:07\n`);
  });

  it('other systems, a missing item and a server without a Trash refuse with trash-unavailable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ms-trash-'));
    await expect(moveToTrash(await folder(home, 'x'), { platform: 'win32', home })).rejects.toMatchObject({ apiCode: 'trash-unavailable' });
    await expect(moveToTrash(join(home, 'nope'), { platform: 'darwin', home })).rejects.toMatchObject({ apiCode: 'trash-unavailable' });
    await expect(noTrash('/x')).rejects.toMatchObject({ apiCode: 'trash-unavailable', status: 409 });
  });
});
