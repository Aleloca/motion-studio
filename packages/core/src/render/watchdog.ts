import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';

/**
 * Process control for the render (spec §5.2 layer 4; plan Review Focus 2).
 * - Every Chromium and ffmpeg the renderer starts is spawned `detached`, so it leads its own process group; it is killed as
 *   a whole group (`kill(-pgid)`), and Chromium helpers are also swept by their unique `--user-data-dir` (spike §4: helpers
 *   re-parented to launchd survived a plain kill).
 * - `liveGroups` remembers every group whose leader is still running, and a process `exit` hook kills them: an app quit
 *   mid-render leaves nothing behind. A group is untracked as soon as its leader exits; after that it is killed only when
 *   `ps` shows it still holds our marker (`killGroupIfMarked`), never blindly (a reaped pid can be reused).
 * - The watchdog samples the memory of a whole group and enforces a time limit. macOS: the **physical footprint** from
 *   `footprint` (it counts compressed pages; `ps` RSS undercounts a 3 GB ArrayBuffer as 354 MB, spike §4), with `ps` RSS as
 *   a fallback; Linux: `/proc/<pid>/status` (VmRSS + VmSwap). ArrayBuffers live outside the V8 heap, so
 *   `--max-old-space-size` alone does not stop them: this does.
 */

const liveGroups = new Set<number>();
let exitHookInstalled = false;

/** Registers a process group to kill if the core exits before it ends (desktop quit, CLI exit). */
export function trackGroup(pgid: number): () => void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => { for (const g of liveGroups) killGroup(g); });
  }
  liveGroups.add(pgid);
  return () => { liveGroups.delete(pgid); };
}

/** How many process groups the core started that still run (tests: nothing may outlive a cancel or a close). */
export function liveGroupCount(): number { return liveGroups.size; }

/** SIGKILLs a whole process group; never throws (the group may be gone already). Windows: kills the process tree. */
export function killGroup(pgid: number): void {
  if (!(pgid > 1)) return;
  if (process.platform === 'win32') {
    try { execFile('taskkill', ['/pid', String(pgid), '/T', '/F'], () => {}); } catch { /* gone */ }
    return;
  }
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* empty group */ }
}

const run = (cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string | null> => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', ...(env ? { env } : {}) }, (err, stdout) => resolve(err ? null : stdout));
});

export interface ProcessRow {
  pid: number; pgid: number; command: string;
  /** Parent pid (1: an orphan re-parented to init/launchd; on Linux possibly a subreaper, see `sweepCandidates`). */
  ppid: number;
  uid: number;
  /** Start time, ms since the epoch (whole seconds: `ps` lstart, printed and read in UTC); NaN when unreadable. */
  startMs: number;
  /** `startMs` is precise to a clock tick (Linux `/proc`, `preciseLinuxStarts`), not whole seconds. */
  startPrecise?: boolean;
}

/** `ps -o lstart` in the C locale: `Mon Oct 12 20:53:17 2026` (the day padded with a space). */
const LSTART = String.raw`\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}`;
const ROW = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(${LSTART})\s+(.*)$`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The environment of the `ps` spawn: the C locale (English month names) and `TZ=UTC`, so `lstart` is printed in UTC and
 * the hour repeated at a DST fall-back can never shift a start by an hour (decisions log 267).
 */
export const psEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' });

/** An `lstart` printed in UTC (`psEnv`), as ms since the epoch; NaN when it is not one. Never the local time zone. */
export function parseLstartUtc(text: string): number {
  const m = /^\w{3} (\w{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})$/.exec(text.trim());
  const month = m ? MONTHS.indexOf(m[1]!) : -1;
  if (!m || month < 0) return Number.NaN;
  const [day, h, min, sec, year] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
  if (day < 1 || day > 31 || h > 23 || min > 59 || sec > 60) return Number.NaN;
  return Date.UTC(year, month, day, h, min, sec);
}

/**
 * Every process (pid, parent, group, owner, start, whole command line: `-ww`, never cut at the terminal width); empty on
 * Windows or when `ps` fails.
 */
export async function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') return [];
  const out = await run('ps', ['-ww', '-A', '-o', 'pid=,ppid=,pgid=,uid=,lstart=,command='], 30_000, psEnv());
  if (out === null) return [];
  const rows: ProcessRow[] = [];
  for (const line of out.split('\n')) {
    const m = ROW.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]), startMs: parseLstartUtc(m[5]!), command: m[6]! });
  }
  return rows;
}

/**
 * SIGKILLs group `pgid` only if `ps` shows it still holds a process whose command line contains `marker` (our unique
 * temp profile path): after the leader has exited and been reaped, its pid (and so the group id) could in principle be
 * reused, and a blind `kill(-pgid)` could hit someone else's group. Returns whether it killed.
 */
export async function killGroupIfMarked(pgid: number, marker: string): Promise<boolean> {
  if (!(pgid > 1) || marker.length < 12) return false;
  const ours = (await listProcesses()).some((r) => r.pgid === pgid && r.command.includes(marker));
  if (ours) killGroup(pgid);
  return ours;
}

/** The pids of a process group (excluding none). */
export async function groupMembers(pgid: number): Promise<number[]> {
  return (await listProcesses()).filter((r) => r.pgid === pgid).map((r) => r.pid);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The processes `sweepByMarker` may kill (final wave B5), from a `ps` listing. Every one is owned by `uid` and carries
 * `marker` (our unique temp profile path) as a whole path in an argument (`--user-data-dir=<marker>`, or a path that is the
 * marker or starts with `<marker>/`), never as a mere substring; never this process nor `rootPid` itself. Then one of:
 * - a **descendant** of `rootPid` (our Chromium), at any depth: ours by construction, whatever its start time (rule
 *   approved by the orchestrator on 2026-10-12; the orphan conditions below do not apply to it);
 * - an **orphan** started at or after `since` (the launch; within its second when the start is `ps`'s whole seconds,
 *   exactly when it is precise). An orphan's parent is 1 (init/launchd) or, with `subreaperParents` (Linux), a child
 *   subreaper (`systemd --user`, a CI runner): the kernel re-parents an orphan to its nearest living subreaper ancestor,
 *   and our Chromium's helpers descend from us, so that subreaper is always a proper ancestor of this process (`self`). A
 *   parent that is anything else (this process, an unrelated live process) means the process is not an orphan of ours;
 * - a marked **descendant of a picked process** (a zygote's renderers under a picked orphan): ours like the first case.
 */
export function sweepCandidates(rows: readonly ProcessRow[], marker: string, o: { rootPid: number; since: number; uid: number; self: number; subreaperParents?: boolean }): ProcessRow[] {
  if (marker.length < 12) return []; // never a short, ambiguous marker
  const token = new RegExp(String.raw`(?:^|[\s=])${escapeRe(marker)}(?=$|[\s/])`);
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const descends = (pid: number) => {
    for (let p = parent.get(pid), hops = 0; p !== undefined && p > 1 && hops < 64; p = parent.get(p), hops++) if (p === o.rootPid) return true;
    return false;
  };
  // The proper ancestors of this process (never itself): where Linux re-parents an orphan of ours under a subreaper.
  const ancestors = new Set<number>();
  if (o.subreaperParents) for (let p = parent.get(o.self), hops = 0; p !== undefined && p > 1 && p !== o.self && hops < 64; p = parent.get(p), hops++) ancestors.add(p);
  // The orphan rule only: a descendant of our Chromium (or of a picked process) is ours without it.
  const orphan = (r: ProcessRow) => r.ppid === 1 || ancestors.has(r.ppid);
  // `ps` gives whole seconds: a start in the launch's second counts. A precise start (Linux /proc, biased early) is
  // compared exactly, so a process started before the launch is never taken as an orphan.
  const since = Math.floor(o.since / 1000) * 1000;
  const startedAfter = (r: ProcessRow) => r.startMs >= (r.startPrecise ? o.since : since);
  const marked = rows.filter((r) => r.pid !== o.self && r.pid !== o.rootPid && r.uid === o.uid && token.test(r.command));
  const picked = new Set(marked.filter((r) => descends(r.pid) || (orphan(r) && startedAfter(r))).map((r) => r.pid));
  // Grandchildren: a marked process whose parent chain reaches a picked one (its parent was re-parented to 1, e.g. a
  // zygote's renderers), found in the same snapshot.
  const reaches = (pid: number) => {
    for (let p = parent.get(pid), hops = 0; p !== undefined && p > 1 && hops < 64; p = parent.get(p), hops++) if (picked.has(p)) return true;
    return false;
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const r of marked) if (!picked.has(r.pid) && reaches(r.pid)) { picked.add(r.pid); grew = true; }
  }
  return marked.filter((r) => picked.has(r.pid));
}

/**
 * The parent (field 4) and the start time in clock ticks since boot (field 22) of a `/proc/<pid>/stat` line, or null. The
 * command name (field 2) is in parentheses and may hold spaces and parentheses itself, so the fields are counted after
 * the LAST `)`.
 */
export function procStat(stat: string): { ppid: number; startTicks: number } | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/); // fields[0] is field 3 (state)
  const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null);
  const ppid = num(fields[4 - 3]), startTicks = num(fields[22 - 3]);
  return ppid === null || startTicks === null ? null : { ppid, startTicks };
}

/** The uptime in seconds, the first number of `/proc/uptime`, or null. */
export function procUptimeSeconds(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s/.exec(text);
  return m ? Number(m[1]) : null;
}

/** `/proc/uptime` is printed to 1/100 s, truncated. */
const UPTIME_RESOLUTION_S = 0.01;

/**
 * A process start in ms since the epoch from its start `ticks` (since boot), the uptime and `nowMs`, read in that order
 * (`nowMs` first), and the tick rate `hz`: `nowMs - (uptime + 0.01 - ticks / hz)`. Every error makes it early, never late:
 * `nowMs` is taken before the uptime (so it is not later than the uptime's moment), the uptime's truncation to 1/100 s is
 * added back in full, and the start ticks are truncated (earlier). Unlike `ps lstart` (the boot time truncated to the
 * second, then the start printed in whole seconds) it is within about 20 ms of the truth, plus the time between the two
 * reads.
 */
export function linuxStartMs(ticks: number, uptimeSec: number, nowMs: number, hz: number): number {
  return nowMs - (uptimeSec + UPTIME_RESOLUTION_S - ticks / hz) * 1000;
}

let clockTicks: Promise<number> | null = null;
const clkTck = () => (clockTicks ??= run('getconf', ['CLK_TCK'], 5_000).then((out) => {
  const n = Number(out?.trim());
  return Number.isInteger(n) && n > 0 ? n : 100;
}));

/** How far after its `ps` start a precise start may lie: `ps lstart` on Linux is truncated twice (boot time, printed second). */
const PS_START_SPAN_MS = 2000;
/** The /proc reads of a sweep get this long; past it the `ps` rows are used as they are. */
const PROC_READ_TIMEOUT_MS = 5000;

/**
 * Linux: the rows whose command line contains `marker` get their start time from `/proc/<pid>/stat` and `/proc/uptime`
 * (`linuxStartMs`: precise, biased early), not from `ps lstart` (whole seconds over a truncated boot time: a helper started
 * just after the launch could read as started before it, and escape the sweep). The value kept is never later than the
 * `ps` start + 2 s nor than now, and never earlier than the `ps` start (`max` of the two lower bounds). A row keeps its
 * `ps` value and rule when its stat cannot be read, names another parent (the pid was reused since `ps`), or gives an
 * implausibly late start: more than 2 s after its `ps` start, or after now (a container that virtualises `/proc/uptime`,
 * lxcfs; a wrong tick rate). All the reads together get `PROC_READ_TIMEOUT_MS`, then the `ps` rows are used.
 */
export async function preciseLinuxStarts(rows: ProcessRow[], marker: string, io: { read(path: string): Promise<string>; now(): number; hz(): Promise<number> } = linuxIo, timeoutMs = PROC_READ_TIMEOUT_MS): Promise<ProcessRow[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = new Promise<ProcessRow[]>((resolve) => { timer = setTimeout(() => resolve(rows), timeoutMs); });
  const work = (async () => {
    const nowMs = io.now(); // before the uptime: never later than the moment it describes
    const uptime = procUptimeSeconds(await io.read('/proc/uptime').catch(() => ''));
    if (uptime === null) return rows;
    const hz = await io.hz();
    return Promise.all(rows.map(async (r) => {
      if (!r.command.includes(marker)) return r;
      const st = procStat(await io.read(`/proc/${r.pid}/stat`).catch(() => ''));
      if (st === null || st.ppid !== r.ppid) return r;
      const precise = linuxStartMs(st.startTicks, uptime, nowMs, hz);
      if (!(precise <= r.startMs + PS_START_SPAN_MS && precise <= nowMs)) return r; // implausibly late: the ps rule
      // Both are lower bounds of the true start (precise: biased early; ps: truncated), so their maximum is one too: a
      // precise value a few ms under its ps second gives that second, compared exactly.
      return { ...r, startMs: Math.max(precise, r.startMs), startPrecise: true };
    }));
  })().catch(() => rows);
  try { return await Promise.race([work, fallback]); } finally { clearTimeout(timer); }
}

const linuxIo = { read: (path: string) => readFile(path, 'utf8'), now: () => Date.now(), hz: clkTck };

/**
 * SIGKILLs the processes `sweepCandidates` picks: the last sweep after the group kill, for Chromium helpers that left the
 * group. `rootPid`: the Chromium we launched; `since`: when (ms). Returns how many it found.
 */
export async function sweepByMarker(marker: string, o: { rootPid: number; since: number }): Promise<number> {
  if (process.platform === 'win32') return 0;
  const uid = process.getuid?.();
  if (uid === undefined) return 0;
  let all = await listProcesses();
  if (process.platform === 'linux') all = await preciseLinuxStarts(all, marker);
  const rows = sweepCandidates(all, marker, { ...o, uid, self: process.pid, subreaperParents: process.platform === 'linux' });
  for (const r of rows) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* gone */ } }
  return rows.length;
}

/**
 * Memory of a process group in MB: the total and the largest process (null from the samplers when it cannot be read). `pids` is the number of processes MEASURED in this sample (those a footprint/ps/proc read
 * answered for), not the number listed in the group: a process that exited between the listing and the read, or a pid the
 * tool could not read, is not counted (M10). The Electron path re-reads its renderers' pids from live webContents every sample.
 */
export interface GroupMemory { totalMB: number; maxMB: number; pids: number }

async function linuxMemory(pids: number[]): Promise<Map<number, number>> {
  const m = new Map<number, number>();
  await Promise.all(pids.map(async (pid) => {
    const s = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => null);
    if (s === null) return;
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, 'm').exec(s)?.[1] ?? 0);
    m.set(pid, (kb('VmRSS') + kb('VmSwap')) * 1024);
  }));
  return m;
}

async function macFootprint(pids: number[]): Promise<Map<number, number> | null> {
  const args = ['--noCategories', '-f', 'bytes', ...pids.flatMap((p) => ['-p', String(p)])];
  const out = await run('/usr/bin/footprint', args, 20_000);
  if (out === null) return null;
  const m = new Map<number, number>();
  for (const x of out.matchAll(/\[(\d+)\]:[^\n]*?Footprint:\s*(\d+)\s*B/g)) m.set(Number(x[1]), Number(x[2]));
  return m.size > 0 ? m : null;
}

async function psRss(pids: number[]): Promise<Map<number, number>> {
  const out = await run('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], 20_000);
  const m = new Map<number, number>();
  for (const line of (out ?? '').split('\n')) {
    const x = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (x) m.set(Number(x[1]), Number(x[2]) * 1024);
  }
  return m;
}

/** Samples the memory of every process of group `pgid` (see the module comment for the sources). */
export async function sampleGroupMemory(pgid: number): Promise<GroupMemory | null> {
  if (process.platform === 'win32') return null;
  let pids: number[];
  if (process.platform === 'linux') {
    const entries = await readdir('/proc').catch(() => [] as string[]);
    const found: number[] = [];
    await Promise.all(entries.filter((e) => /^\d+$/.test(e)).map(async (e) => {
      const stat = await readFile(`/proc/${e}/stat`, 'utf8').catch(() => null);
      // pid (comm) state ppid pgrp …: comm may hold spaces and parentheses, so read after the last ')'.
      const rest = stat === null ? null : stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (rest && Number(rest[2]) === pgid) found.push(Number(e));
    }));
    pids = found;
  } else {
    pids = await groupMembers(pgid);
  }
  return samplePidsMemory(pids);
}

/**
 * Bytes per process for `pids` (the same sources as `sampleGroupMemory`: macOS footprint with `ps` RSS as a floor, Linux
 * `/proc`); empty on Windows. Processes that are gone are missing from the map.
 */
export async function pidsMemoryBytes(pids: number[]): Promise<Map<number, number>> {
  const valid = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 1);
  if (valid.length === 0 || process.platform === 'win32') return new Map();
  if (process.platform === 'linux') return linuxMemory(valid);
  const [fp, rss] = await Promise.all([macFootprint(valid), psRss(valid)]);
  const bytes = new Map(rss);
  if (fp) for (const [pid, b] of fp) bytes.set(pid, Math.max(b, bytes.get(pid) ?? 0));
  return bytes;
}

/** The memory of an explicit set of processes (the desktop's render windows, which have no process group of their own). */
export async function samplePidsMemory(pids: number[], extra?: Map<number, number>): Promise<GroupMemory | null> {
  if (pids.length === 0) return null;
  const bytes = await pidsMemoryBytes(pids);
  // `extra`: another reading of the same processes (Electron's app.getAppMetrics()); the larger one counts.
  for (const [pid, b] of extra ?? []) if (pids.includes(pid)) bytes.set(pid, Math.max(b, bytes.get(pid) ?? 0));
  if (bytes.size === 0) return null;
  let total = 0, max = 0;
  for (const b of bytes.values()) { total += b; max = Math.max(max, b); }
  return { totalMB: total / (1024 * 1024), maxMB: max / (1024 * 1024), pids: bytes.size };
}

export interface WatchdogLimits {
  /** Largest single process (a renderer), MB, or a function read at every sample. Default 1536: a 2 GB ArrayBuffer trips it. */
  maxProcessMB?: number | (() => number);
  /** Whole group, MB, or a function read at every sample. Default 6144. */
  maxGroupMB?: number | (() => number);
  /** Wall-clock limit of the whole render, ms. */
  timeLimitMs: number;
  /** Sampling interval, ms. Default 1000. */
  intervalMs?: number;
}

export type WatchdogTrip =
  | { reason: 'memory'; memoryMB: number; limitMB: number }
  | { reason: 'time'; elapsedMs: number; limitMs: number };

export const DEFAULT_MAX_PROCESS_MB = 1536;
export const DEFAULT_MAX_GROUP_MB = 6144;

/**
 * Memory limits for a render of `width`×`height` with `pages` pages open (the provider's defaults):
 * - per process: 1024 MB plus 512 MB per 1080×1920 worth of pixels (1536 at 1080p, 3072 at 4K): a renderer holds a few
 *   decoded frames and layers of the page size;
 * - group: 1024 MB for the browser and GPU processes plus one per-process allowance per open page, at most 75 % of the
 *   machine's memory.
 * The limits are soft: the footprint is sampled (every second, every 250 ms within 75 % of a limit), so a fast allocation
 * can overshoot before the kill (the 2 GB ArrayBuffer test peaked at 2.1–3.1 GB against 1536 MB).
 *
 * The size of the source media is deliberately not an input (Task 5 decision): every video clip plays its normalised file
 * (media-normalize.ts), whose size is capped to what the clip's box needs at composition size (scale included) and to
 * 4096 px on the long side, and whose decoded frames are drawn into a canvas no larger than the region shown. A 4K source
 * in a small box costs what the box costs. What stays unbounded by this is the fallback: a clip whose normalisation
 * failed plays its original file (untrusted); the per-process cap still stops a source that makes a renderer explode.
 */
export function scaledMemoryLimits(width: number, height: number, pages: number, totalMemMB = totalmem() / (1024 * 1024)): { maxProcessMB: number; maxGroupMB: number } {
  const units = Math.max(1, (width * height) / (1080 * 1920));
  const maxProcessMB = Math.round(1024 + 512 * units);
  const maxGroupMB = Math.round(Math.min(1024 + maxProcessMB * Math.max(1, pages), totalMemMB * 0.75));
  return { maxProcessMB, maxGroupMB };
}

export interface Watchdog {
  /** The highest memory seen so far (largest process and group total), MB. */
  readonly peak: { maxMB: number; totalMB: number };
  readonly tripped: WatchdogTrip | null;
  /** The delay before the next sample: shorter near a limit. */
  readonly nextSampleMs: number;
  stop(): void;
}

/**
 * Watches group `pgid`: on a memory or time limit it calls `onTrip` once (the caller kills the group and fails the render).
 * `sample` is injectable for tests.
 */
export function startWatchdog(o: { pgid: number; limits: WatchdogLimits; onTrip: (t: WatchdogTrip) => void; sample?: (pgid: number) => Promise<GroupMemory | null> }): Watchdog {
  const read = (v: number | (() => number) | undefined, d: number) => (typeof v === 'function' ? v() : v ?? d);
  const interval = o.limits.intervalMs ?? 1000;
  const near = Math.min(interval, 250);
  const sample = o.sample ?? sampleGroupMemory;
  const started = Date.now();
  const peak = { maxMB: 0, totalMB: 0 };
  let tripped: WatchdogTrip | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let nextSampleMs = interval;
  const trip = (t: WatchdogTrip) => {
    if (tripped || stopped) return;
    tripped = t;
    stop();
    o.onTrip(t);
  };
  const deadline = setTimeout(() => trip({ reason: 'time', elapsedMs: Date.now() - started, limitMs: o.limits.timeLimitMs }), o.limits.timeLimitMs);
  const tick = async () => {
    if (stopped) return;
    const m = await sample(o.pgid).catch(() => null);
    if (stopped) return;
    let next = interval;
    if (m) {
      const maxProcessMB = read(o.limits.maxProcessMB, DEFAULT_MAX_PROCESS_MB);
      const maxGroupMB = read(o.limits.maxGroupMB, DEFAULT_MAX_GROUP_MB);
      peak.maxMB = Math.max(peak.maxMB, m.maxMB);
      peak.totalMB = Math.max(peak.totalMB, m.totalMB);
      if (m.maxMB > maxProcessMB) return trip({ reason: 'memory', memoryMB: Math.round(m.maxMB), limitMB: maxProcessMB });
      if (m.totalMB > maxGroupMB) return trip({ reason: 'memory', memoryMB: Math.round(m.totalMB), limitMB: maxGroupMB });
      // Close to a limit: sample faster (the cap is soft; see scaledMemoryLimits).
      if (m.maxMB > 0.75 * maxProcessMB || m.totalMB > 0.75 * maxGroupMB) next = near;
    }
    nextSampleMs = next;
    timer = setTimeout(() => { void tick(); }, next);
  };
  function stop() {
    stopped = true;
    clearTimeout(deadline);
    if (timer) clearTimeout(timer);
  }
  timer = setTimeout(() => { void tick(); }, Math.min(interval, 250));
  return { peak, get tripped() { return tripped; }, get nextSampleMs() { return nextSampleMs; }, stop };
}
