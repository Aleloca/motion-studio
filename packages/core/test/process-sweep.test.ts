// @vitest-environment node
/**
 * Final wave B5: the render's last sweep (`sweepByMarker`) kills only what is ours: processes of this user carrying our
 * unique profile path as a whole path argument, that descend from the Chromium we launched or are orphans started after
 * it. Every process here is spawned by the test and ended by its own recorded PID (never by pattern).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listProcesses, sweepByMarker, sweepCandidates, type ProcessRow } from '../src/render/watchdog.ts';

const M = '/tmp/ms-render-chrome-abcdef123456';
const row = (pid: number, ppid: number, command: string, o: Partial<ProcessRow> = {}): ProcessRow => ({ pid, ppid, pgid: pid, uid: 501, startMs: Date.parse('Mon Oct 12 20:00:05 2026'), command, ...o });
const since = Date.parse('Mon Oct 12 20:00:05 2026') + 400; // within the same second as a start at :05

describe('sweepCandidates (pure)', () => {
  const opts = { rootPid: 100, since, uid: 501, self: 1 };
  it('a descendant of our Chromium with the profile path as an argument, at any depth', () => {
    const rows = [row(100, 50, `chrome --user-data-dir=${M}`), row(101, 100, `chrome-helper --user-data-dir=${M} --type=gpu`), row(102, 101, `crashpad --database=${M}/Crashpad`)];
    expect(sweepCandidates(rows, M, opts).map((r) => r.pid)).toEqual([101, 102]);
  });
  it('an orphan with the marker started at or after the launch (same second counts); one started before is left', () => {
    const rows = [row(200, 1, `helper --user-data-dir=${M}`), row(201, 1, `helper --user-data-dir=${M}`, { startMs: Date.parse('Mon Oct 12 20:00:04 2026') })];
    expect(sweepCandidates(rows, M, opts).map((r) => r.pid)).toEqual([200]);
  });
  it('the marker only as a substring, another user, an unrelated parent, ourselves: left alone', () => {
    const rows = [
      row(300, 100, `tool --note=x${M}`), row(301, 100, `tool ${M}-copy`), row(302, 100, `tool --user-data-dir=${M}extra`),
      row(303, 100, `tool --user-data-dir=${M}`, { uid: 0 }), row(304, 77, `tool --user-data-dir=${M}`), row(1, 100, `self --user-data-dir=${M}`),
      row(305, 100, `tool ${M}`), row(306, 100, `tool --x ${M}/file`),
    ];
    expect(sweepCandidates(rows, M, opts).map((r) => r.pid)).toEqual([305, 306]);
  });
  it('a marked grandchild of a picked orphan (its parent re-parented to 1) goes too; an unmarked one stays', () => {
    const rows = [row(400, 1, `zygote --user-data-dir=${M}`), row(401, 400, `renderer --user-data-dir=${M}`), row(402, 401, `gpu --user-data-dir=${M}`), row(403, 400, 'plain child')];
    expect(sweepCandidates(rows, M, opts).map((r) => r.pid).sort()).toEqual([400, 401, 402]);
  });
  it('a short marker never matches anything', () => {
    expect(sweepCandidates([row(101, 100, '--user-data-dir=/tmp/x')], '/tmp/x', opts)).toEqual([]);
  });
});

const posix = process.platform !== 'win32';
describe.skipIf(!posix)('listProcesses and sweepByMarker on real processes', () => {
  const marker = mkdtempSync(join(tmpdir(), 'ms-test-sweep-'));
  const ours = new Set<number>();
  const children: ChildProcess[] = [];
  afterAll(async () => {
    // Only the PIDs this test recorded, each still verified as carrying our marker before it is ended.
    for (const r of await listProcesses()) if (ours.has(r.pid) && r.command.includes(marker)) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    rmSync(marker, { recursive: true, force: true });
  });
  const IDLE = 'setTimeout(() => {}, 120000)';
  /** A node process (ours) with `args`, child of this test. */
  const direct = (...args: string[]) => { const c = spawn(process.execPath, ['-e', IDLE, '--', ...args], { stdio: 'ignore' }); children.push(c); ours.add(c.pid!); return c.pid!; };
  /** An orphan (its parent shell exits at once: re-parented to init/launchd) with `arg`; its pid. */
  const orphan = (arg: string) => {
    const r = spawnSync('/bin/sh', ['-c', '"$0" -e "$1" -- "$2" </dev/null >/dev/null 2>&1 & echo $!', process.execPath, IDLE, arg], { encoding: 'utf8' });
    const pid = Number(r.stdout.trim());
    ours.add(pid);
    return pid;
  };
  const until = async (cond: (rows: ProcessRow[]) => boolean, tries = 300) => {
    for (let i = 0; i < tries; i++) { const rows = await listProcesses(); if (cond(rows)) return rows; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('timeout waiting for the processes');
  };

  it('ps -ww: the whole command line, the parent, our uid and a start time', async () => {
    const long = `--long=${'x'.repeat(3000)}`;
    const pid = direct(long, `--user-data-dir=${marker}-list`);
    const rows = await until((rs) => rs.some((r) => r.pid === pid));
    const me = rows.find((r) => r.pid === pid)!;
    expect(me.command).toContain(long);
    expect(me.ppid).toBe(process.pid);
    expect(me.uid).toBe(process.getuid!());
    expect(Math.abs(me.startMs - Date.now())).toBeLessThan(120_000);
  }, 60_000);

  it('kills our Chromium\'s marked descendants and orphans started after the launch; leaves the rest', async (ctx) => {
    // Before the render: an orphan with the exact marker.
    const before = orphan(`--user-data-dir=${marker}`);
    // Under a Linux subreaper an orphan never gets parent 1: the orphan rule cannot be shown there (left to the group kill).
    const reparented = await until((rs) => rs.some((r) => r.pid === before && r.ppid !== process.pid), 50).catch(() => null);
    if (!reparented?.some((r) => r.pid === before && r.ppid === 1)) { ctx.skip(); return; }
    await new Promise((r) => setTimeout(r, 1100));
    const launchedAt = Date.now();
    // "Chromium": a process that starts two helpers, one with the marker as an argument, one with it inside another word.
    const root = spawn(process.execPath, ['-e', `const { spawn } = require('child_process');
      const a = spawn(process.execPath, ['-e', '${IDLE}', '--', '--user-data-dir=${marker}', '--type=gpu'], { stdio: 'ignore' });
      const b = spawn(process.execPath, ['-e', '${IDLE}', '--', '--note=prefix${marker}suffix'], { stdio: 'ignore' });
      console.log(JSON.stringify([a.pid, b.pid])); ${IDLE}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(root);
    ours.add(root.pid!);
    const [helper, wordy] = await new Promise<number[]>((resolve) => root.stdout!.once('data', (d: Buffer) => resolve(JSON.parse(d.toString()) as number[])));
    ours.add(helper!); ours.add(wordy!);
    // A process of ours with the exact marker but neither a descendant nor an orphan; an orphan with it after the launch.
    const bystander = direct(`--user-data-dir=${marker}`);
    const after = orphan(`--user-data-dir=${marker}`);
    await until((rs) => [helper, wordy, bystander].every((p) => rs.some((r) => r.pid === p)) && rs.some((r) => r.pid === after && r.ppid === 1));
    expect(await sweepByMarker(marker, { rootPid: root.pid!, since: launchedAt })).toBe(2);
    const rows = await until((rs) => !rs.some((r) => r.pid === helper || r.pid === after));
    for (const p of [before, wordy, bystander, root.pid!]) expect(rows.some((r) => r.pid === p), String(p)).toBe(true);
  }, 120_000);
});
