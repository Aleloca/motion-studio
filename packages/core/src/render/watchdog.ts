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

/** SIGKILLs a whole process group; never throws (the group may be gone already). Windows: kills the process tree. */
export function killGroup(pgid: number): void {
  if (!(pgid > 1)) return;
  if (process.platform === 'win32') {
    try { execFile('taskkill', ['/pid', String(pgid), '/T', '/F'], () => {}); } catch { /* gone */ }
    return;
  }
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* empty group */ }
}

const run = (cmd: string, args: string[], timeoutMs: number): Promise<string | null> => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : stdout));
});

export interface ProcessRow { pid: number; pgid: number; command: string }

/** Every process (pid, pgid, command line); empty on Windows or when `ps` fails. */
export async function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') return [];
  const out = await run('ps', ['-A', '-o', 'pid=,pgid=,command='], 30_000);
  if (out === null) return [];
  const rows: ProcessRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3]! });
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

/**
 * SIGKILLs every process whose command line contains `marker` literally (a unique temp profile path), in any group: the
 * last sweep after the group kill. Returns how many it found.
 */
export async function sweepByMarker(marker: string): Promise<number> {
  if (marker.length < 12) return 0; // never a short, ambiguous marker
  const rows = (await listProcesses()).filter((r) => r.command.includes(marker) && r.pid !== process.pid);
  for (const r of rows) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* gone */ } }
  return rows.length;
}

/** Memory of a process group in MB: the total and the largest process; null when it cannot be read. */
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
  if (pids.length === 0) return null;
  let bytes: Map<number, number> | null;
  if (process.platform === 'linux') bytes = await linuxMemory(pids);
  else {
    const [fp, rss] = await Promise.all([macFootprint(pids), psRss(pids)]);
    bytes = new Map(rss);
    if (fp) for (const [pid, b] of fp) bytes.set(pid, Math.max(b, bytes.get(pid) ?? 0));
  }
  let total = 0, max = 0;
  for (const b of bytes.values()) { total += b; max = Math.max(max, b); }
  return { totalMB: total / (1024 * 1024), maxMB: max / (1024 * 1024), pids: pids.length };
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
