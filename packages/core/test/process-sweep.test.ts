// @vitest-environment node
/**
 * Final wave B5: the render's last sweep (`sweepByMarker`) kills only what is ours: processes of this user carrying our
 * unique profile path as a whole path argument, that descend from the Chromium we launched or are orphans started after
 * it (parent 1, or under a Linux subreaper a proper ancestor of this process). Every process here is spawned by the test and ended by its own recorded PID (never by pattern).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { linuxStartMs, listProcesses, preciseLinuxStarts, procStat, procUptimeSeconds, sweepByMarker, sweepCandidates, type ProcessRow } from '../src/render/watchdog.ts';

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

describe('sweepCandidates under a Linux child subreaper (pure)', () => {
  // systemd --user (10) → terminal shell (800) → the core (900, self) → our Chromium (100). An orphan of ours is re-parented
  // to the nearest living subreaper ancestor: 10 or 800, never 1.
  const tree = [row(10, 1, 'systemd --user'), row(800, 10, 'bash'), row(900, 800, 'node core'), row(100, 900, `chrome --user-data-dir=${M}`), row(77, 1, 'other-daemon')];
  const opts = { rootPid: 100, since, uid: 501, self: 900, subreaperParents: true };
  const pick = (rows: ProcessRow[]) => sweepCandidates([...tree, ...rows], M, opts).map((r) => r.pid).sort((a, b) => a - b);
  it('a marked orphan started after the launch, re-parented to a non-1 subreaper ancestor, is swept (with its marked child)', () => {
    expect(pick([row(500, 10, `helper --user-data-dir=${M}`), row(502, 800, `helper --user-data-dir=${M}`), row(510, 500, `renderer --user-data-dir=${M}`)])).toEqual([500, 502, 510]);
  });
  it('an orphan started BEFORE the launch is never swept, whatever its parent', () => {
    const before = { startMs: Date.parse('Mon Oct 12 20:00:04 2026') };
    expect(pick([row(501, 10, `helper --user-data-dir=${M}`, before), row(507, 1, `helper --user-data-dir=${M}`, before), row(508, 800, `helper --user-data-dir=${M}`, before)])).toEqual([]);
  });
  it('another uid, the marker elsewhere in argv, a child of an unrelated live process, a child of this process: left alone', () => {
    expect(pick([
      row(505, 10, `helper --user-data-dir=${M}`, { uid: 0 }),
      row(506, 10, `helper --note=x${M}`), row(509, 10, `helper ${M}-copy`),
      row(504, 77, `helper --user-data-dir=${M}`),
      row(503, 900, `helper --user-data-dir=${M}`),
    ])).toEqual([]);
  });
  it('without subreaperParents (macOS: orphans always go to launchd) an ancestor parent is not an orphan\'s', () => {
    expect(sweepCandidates([...tree, row(500, 10, `helper --user-data-dir=${M}`), row(530, 1, `helper --user-data-dir=${M}`)], M, { ...opts, subreaperParents: false }).map((r) => r.pid)).toEqual([530]);
  });
  it('a descendant of our Chromium is ours whatever its start and parent chain (the orphan rule does not apply to it)', () => {
    const early = { startMs: Date.parse('Mon Oct 12 19:00:00 2026') };
    expect(pick([row(540, 100, `gpu --user-data-dir=${M}`, early), row(541, 540, `crashpad --database=${M}/Crashpad`, early)])).toEqual([540, 541]);
  });
  it('a precise (Linux /proc) start is compared exactly: 1 ms before the launch is left, at the launch is swept', () => {
    const precise = (ms: number) => ({ startMs: ms, startPrecise: true });
    expect(pick([row(520, 10, `helper --user-data-dir=${M}`, precise(since - 1)), row(521, 10, `helper --user-data-dir=${M}`, precise(since))])).toEqual([521]);
  });
});

describe('Linux start times from /proc (pure, injected /proc)', () => {
  // A /proc/<pid>/stat line: 52 fields; field 22 (starttime) is 4321. The command name holds spaces and a ")".
  const stat = (comm: string, start: number | string) => `1234 (${comm}) S 1 1234 1234 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${start} 1000 10 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0\n`;
  it('procStat: fields 4 and 22, counted after the LAST ")"', () => {
    expect(procStat(stat('chrome', 4321))).toEqual({ ppid: 1, startTicks: 4321 });
    expect(procStat(stat('we ird) (S 9 9', 4321))).toEqual({ ppid: 1, startTicks: 4321 });
    expect(procStat(stat('x', 'abc'))).toBeNull();
    expect(procStat('1234 (cut) S 1 2')).toBeNull();
    expect(procStat('')).toBeNull();
  });
  it('procUptimeSeconds and linuxStartMs', () => {
    expect(procUptimeSeconds('12345.67 54321.00\n')).toBe(12345.67);
    expect(procUptimeSeconds('')).toBeNull();
    // Up 100 s at now; a start at tick 9_950 (99.5 s at 100 Hz) was 0.5 s ago, minus the uptime's 0.01 s resolution
    // (always early, never late).
    expect(linuxStartMs(9_950, 100, 1_000_000, 100)).toBeCloseTo(999_490, 6);
  });
  it('preciseLinuxStarts: marked rows get the /proc start; unmarked or unreadable rows keep the ps one', async () => {
    const launch = Date.parse('Mon Oct 12 20:00:05 2026') + 400;
    const now = launch + 2_000; // uptime 1000 s at `now`
    const files: Record<string, string> = {
      '/proc/uptime': '1000.00 4000.00\n',
      '/proc/601/stat': stat('helper', 99_830), // 998.3 s: 300 ms after the launch (ps would print the second before)
      '/proc/602/stat': stat('helper', 99_770), // 997.7 s: 300 ms before the launch
      '/proc/604/stat': stat('plain', 99_900),
    };
    const io = { read: async (p: string) => { const f = files[p]; if (f === undefined) throw new Error('ENOENT'); return f; }, now: () => now, hz: async () => 100 };
    const psStart = Date.parse('Mon Oct 12 20:00:04 2026'); // what a truncated boot time makes ps print
    const rows = [row(601, 1, `helper --user-data-dir=${M}`, { startMs: psStart }), row(602, 1, `helper --user-data-dir=${M}`, { startMs: psStart }),
      row(603, 1, `helper --user-data-dir=${M}`, { startMs: psStart }), row(604, 1, 'plain', { startMs: psStart })];
    const out = await preciseLinuxStarts(rows, M, io);
    expect(out.map((r) => [r.pid, Math.round(r.startMs - launch), r.startPrecise ?? false])).toEqual([[601, 290, true], [602, -310, true], [603, psStart - launch, false], [604, psStart - launch, false]]);
    // The orphan started after the launch is swept; the one before it, and the unreadable one with ps's early time, are not.
    expect(sweepCandidates(out, M, { rootPid: 100, since: launch, uid: 501, self: 900 }).map((r) => r.pid)).toEqual([601]);
    // No /proc/uptime: the rows are returned unchanged.
    expect(await preciseLinuxStarts(rows, M, { ...io, read: async () => { throw new Error('ENOENT'); } })).toEqual(rows);
  });

  /**
   * A simulated Linux kernel: boot at `bootMs`; a process start in ticks (truncated, 100 Hz); `/proc/uptime` printed to
   * 1/100 s (truncated) at the moment it is read; ps lstart = the start over a truncated boot time, in whole seconds; the
   * core reads the clock, then (`delayMs` later) the uptime.
   */
  const kernel = (o: { bootMs: number; startMs: number; nowMs: number; delayMs: number; ppid?: number }) => {
    const order: string[] = [];
    const ticks = Math.floor((o.startMs - o.bootMs) / 10);
    const uptime = Math.floor((o.nowMs + o.delayMs - o.bootMs) / 10) / 100;
    const psStart = Math.floor((Math.floor(o.bootMs / 1000) * 1000 + ticks * 10) / 1000) * 1000;
    const io = {
      read: async (p: string) => {
        order.push(p);
        if (p === '/proc/uptime') return `${uptime.toFixed(2)} 1.00\n`;
        return stat('helper', ticks).replace('S 1 ', `S ${o.ppid ?? 1} `);
      },
      now: () => { order.push('now'); return o.nowMs; },
      hz: async () => 100,
    };
    return { io, order, psStart };
  };
  it('the clock is read BEFORE /proc/uptime (so the start is never computed late)', async () => {
    const k = kernel({ bootMs: 1_000_000_123, startMs: 1_000_500_000, nowMs: 1_000_600_000, delayMs: 5 });
    await preciseLinuxStarts([row(700, 1, `helper --user-data-dir=${M}`, { startMs: k.psStart })], M, k.io);
    expect(k.order.slice(0, 2)).toEqual(['now', '/proc/uptime']);
  });
  it('an orphan started 1 to 10 ms before the launch is never swept, whatever the boot phase and read delay', async () => {
    const launch = Date.parse('Mon Oct 12 20:00:05 2026') + 7; // just past a second boundary: ps alone would take it
    let cases = 0;
    for (let before = 1; before <= 10; before++) {
      for (const bootFrac of [0, 1, 3, 5, 7, 9, 123, 456, 999]) {
        for (const delayMs of [0, 1, 4, 9, 15, 60]) {
          const startMs = launch - before;
          const k = kernel({ bootMs: launch - 3_600_000 - bootFrac, startMs, nowMs: launch + 1_500, delayMs });
          const rows = await preciseLinuxStarts([row(700, 1, `helper --user-data-dir=${M}`, { startMs: k.psStart })], M, k.io);
          expect(rows[0]!.startMs, `before ${before} boot ${bootFrac} delay ${delayMs}`).toBeLessThanOrEqual(startMs);
          expect(sweepCandidates(rows, M, { rootPid: 100, since: launch, uid: 501, self: 900 })).toEqual([]);
          cases++;
        }
      }
    }
    expect(cases).toBe(540);
  });
  it('an orphan started 25 ms after the launch is swept (no read delay)', async () => {
    const launch = Date.parse('Mon Oct 12 20:00:05 2026') + 7;
    for (const bootFrac of [0, 3, 9, 456]) {
      const k = kernel({ bootMs: launch - 3_600_000 - bootFrac, startMs: launch + 25, nowMs: launch + 1_500, delayMs: 0 });
      const rows = await preciseLinuxStarts([row(700, 1, `helper --user-data-dir=${M}`, { startMs: k.psStart })], M, k.io);
      expect(sweepCandidates(rows, M, { rootPid: 100, since: launch, uid: 501, self: 900 }).map((r) => r.pid)).toEqual([700]);
    }
  });
  it('an implausible /proc start falls back to ps: after now (lxcfs virtual uptime), more than 2 s after the ps start', async () => {
    const launch = Date.parse('Mon Oct 12 20:00:05 2026') + 400;
    const psStart = Date.parse('Mon Oct 12 20:00:05 2026');
    const ps = row(710, 1, `helper --user-data-dir=${M}`, { startMs: psStart });
    const io = (uptime: string, ticks: number) => ({ read: async (p: string) => (p === '/proc/uptime' ? uptime : stat('helper', ticks)), now: () => launch + 5_000, hz: async () => 100 });
    // lxcfs: the container's uptime (50 s) against a host-boot start tick (one hour): the start lands in the future.
    expect(await preciseLinuxStarts([ps], M, io('50.00 10.00\n', 360_000))).toEqual([ps]);
    // More than 2 s after the ps start (but before now): implausible too.
    expect(await preciseLinuxStarts([ps], M, io('1000.00 1.00\n', 99_900))).toEqual([ps]);
    // Under the ps start: the ps start, compared exactly (both are lower bounds).
    const early = await preciseLinuxStarts([ps], M, io('1000.00 1.00\n', 99_000));
    expect(early).toEqual([{ ...ps, startPrecise: true }]);
  });
  it('a stat naming another parent (the pid was reused since ps) keeps the ps value; stuck /proc reads time out to the ps rows', async () => {
    const ps = row(720, 1, `helper --user-data-dir=${M}`, { startMs: Date.parse('Mon Oct 12 20:00:05 2026') });
    const k = kernel({ bootMs: 1_000_000_000, startMs: ps.startMs + 100, nowMs: ps.startMs + 1_000, delayMs: 0, ppid: 4242 });
    expect(await preciseLinuxStarts([ps], M, k.io)).toEqual([ps]);
    const stuck = { read: () => new Promise<string>(() => {}), now: () => 0, hz: async () => 100 };
    expect(await preciseLinuxStarts([ps], M, stuck, 20)).toEqual([ps]);
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
  /** An orphan (its parent shell exits at once: re-parented to init/launchd, or a Linux subreaper) with `arg`; its pid. */
  const orphan = (arg: string) => {
    const r = spawnSync('/bin/sh', ['-c', '"$0" -e "$1" -- "$2" </dev/null >/dev/null 2>&1 & echo $!', process.execPath, IDLE, arg], { encoding: 'utf8' });
    const pid = Number(r.stdout.trim());
    ours.add(pid);
    return pid;
  };
  /** Whether `ppid` is where an orphan of ours lands: init (1) or a proper ancestor of this process (a subreaper). */
  const adopted = (rs: ProcessRow[], ppid: number) => {
    if (ppid === 1) return true;
    const parent = new Map(rs.map((r) => [r.pid, r.ppid]));
    for (let p = parent.get(process.pid); p !== undefined && p > 1; p = parent.get(p)) if (p === ppid) return true;
    return false;
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

  it('kills our Chromium\'s marked descendants and orphans started after the launch; leaves the rest', async () => {
    // Before the render: an orphan with the exact marker.
    const before = orphan(`--user-data-dir=${marker}`);
    // Re-parented to 1, or under a Linux subreaper (systemd --user, a CI runner) to a proper ancestor of this process.
    await until((rs) => rs.some((r) => r.pid === before && adopted(rs, r.ppid)));
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
    await until((rs) => [helper, wordy, bystander].every((p) => rs.some((r) => r.pid === p)) && rs.some((r) => r.pid === after && adopted(rs, r.ppid)));
    expect(await sweepByMarker(marker, { rootPid: root.pid!, since: launchedAt })).toBe(2);
    const rows = await until((rs) => !rs.some((r) => r.pid === helper || r.pid === after));
    for (const p of [before, wordy, bystander, root.pid!]) expect(rows.some((r) => r.pid === p), String(p)).toBe(true);
  }, 120_000);
});
