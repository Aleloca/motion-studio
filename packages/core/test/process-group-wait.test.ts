// @vitest-environment node
/**
 * `waitGroupGone` and `groupPresent` (decisions log 789) on real process groups: a detached Node leader (its own group)
 * starts one member in the same group and exits, as Chromium's browser process does before its helpers on close. The
 * members carry this test's unique temp path as an argument; every kill is `killGroupIfMarked` on a group this test
 * created, and only while `ps` shows that path in it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { groupPresent, killGroupIfMarked, waitGroupGone } from '../src/render/watchdog.ts';

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('waitGroupGone on real process groups', () => {
  const marker = mkdtempSync(join(tmpdir(), 'ms-test-group-wait-'));
  const groups: number[] = [];

  afterAll(async () => {
    for (const g of groups) await killGroupIfMarked(g, marker).catch(() => false);
    rmSync(marker, { recursive: true, force: true });
  });

  /**
   * A detached leader that starts one member (same group) running `member` with the marker and a ready file, then exits.
   * Resolves once the leader has exited and the member wrote its ready file; gives the group id.
   */
  async function group(name: string, member: string): Promise<number> {
    const ready = join(marker, `${name}.ready`);
    const child = `${member}; require('node:fs').writeFileSync(process.argv[2], '1')`;
    const leader = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}, '--', process.argv[1], process.argv[2]], { stdio: 'ignore' }).unref()`;
    const p = spawn(process.execPath, ['-e', leader, '--', marker, ready], { stdio: 'ignore', detached: true });
    const pgid = p.pid!;
    groups.push(pgid);
    await new Promise<void>((r) => { if (p.exitCode !== null) r(); else p.once('exit', () => r()); });
    for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(ready)).toBe(true);
    return pgid;
  }

  it('a member that exits late is waited for: the group outlives its leader, then is gone', async () => {
    const pgid = await group('late', 'setTimeout(() => process.exit(0), 800)');
    expect(groupPresent(pgid)).toBe(true); // the leader is gone, the group is not
    const t0 = Date.now();
    expect(await waitGroupGone(pgid, { timeoutMs: 5000 })).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(groupPresent(pgid)).toBe(false);
  }, 20_000);

  it('a member that ignores SIGTERM: the kill callback runs once at killAtMs, its SIGKILL ends the group, the wait returns', async () => {
    const pgid = await group('term', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
    try { process.kill(-pgid, 'SIGTERM'); } catch { /* gone */ }
    let kills = 0;
    const t0 = Date.now();
    let killedAt = -1;
    const gone = await waitGroupGone(pgid, {
      timeoutMs: 5000, killAtMs: 400,
      kill: async () => { kills++; killedAt = Date.now() - t0; await killGroupIfMarked(pgid, marker); },
    });
    expect(gone).toBe(true);
    expect(kills).toBe(1);
    expect(killedAt).toBeGreaterThanOrEqual(400);
  }, 20_000);

  it('the wait is bounded: a group that never goes returns false after timeoutMs, with one kill attempt', async () => {
    const pgid = await group('bounded', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
    let kills = 0;
    const t0 = Date.now();
    expect(await waitGroupGone(pgid, { timeoutMs: 800, killAtMs: 300, kill: () => { kills++; } })).toBe(false);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(800);
    expect(took).toBeLessThan(2500);
    expect(kills).toBe(1);
    expect(groupPresent(pgid)).toBe(true);
    expect(await killGroupIfMarked(pgid, marker)).toBe(true);
    expect(await waitGroupGone(pgid, { timeoutMs: 5000 })).toBe(true);
  }, 20_000);

  it('groupPresent: ESRCH is gone, EPERM and other errors are present, no signal leaves on a pgid ≤ 1', () => {
    const err = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
    expect(groupPresent(12345, err('ESRCH'))).toBe(false);
    expect(groupPresent(12345, err('EPERM'))).toBe(true);
    expect(groupPresent(12345, () => {})).toBe(true);
    let called = false;
    expect(groupPresent(1, () => { called = true; })).toBe(false);
    expect(called).toBe(false);
  });
});
