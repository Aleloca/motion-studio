import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { ProposalActivity, ProposalActivityEntry } from '@motion-studio/shared';

/** Most entries one call returns, and most bytes of log.jsonl it reads. */
export const MAX_ACTIVITY_ENTRIES = 500;
export const MAX_ACTIVITY_BYTES = 1_000_000;


const EMPTY: ProposalActivity = { hasLog: false, truncated: false, entries: [] };
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One log line → an entry when it is an `auto_approved` event or a Bash `tool_use`; anything else (or malformed) → null. */
function entryOf(line: string): ProposalActivityEntry | null {
  let row: unknown;
  try { row = JSON.parse(line); } catch { return null; }
  if (!isRecord(row) || typeof row.at !== 'string' || !isRecord(row.event)) return null;
  const e = row.event;
  if (e.kind === 'auto_approved' && typeof e.toolName === 'string' && typeof e.command === 'string' && isRecord(e.explanation)) {
    return { at: row.at, event: { kind: 'auto_approved', toolName: e.toolName, command: e.command, explanation: e.explanation as never } };
  }
  if (e.kind === 'tool_use' && e.name === 'Bash' && typeof e.id === 'string') {
    return { at: row.at, event: { kind: 'tool_use', id: e.id, name: 'Bash', input: e.input } };
  }
  return null;
}

/**
 * Reads `<proposalDir>/log.jsonl` read-only: the folder must resolve inside `<brandDir>/proposals/` and the log must be
 * a regular, single-linked file inside that folder (never followed through a symlink); at most MAX_ACTIVITY_BYTES are
 * read (a cut last line is dropped) and MAX_ACTIVITY_ENTRIES returned. Never throws: any doubt gives an empty answer.
 */
export async function readProposalActivity(brandDir: string, proposalDir: string): Promise<ProposalActivity> {
  let fh: FileHandle | null = null;
  try {
    const [realBrand, realDir] = await Promise.all([realpath(join(brandDir, 'proposals')), realpath(proposalDir)]);
    if (!realDir.startsWith(realBrand + sep)) return EMPTY;
    const file = join(proposalDir, 'log.jsonl');
    try {
      fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? EMPTY : { ...EMPTY, hasLog: true };
    }
    const info = await fh.stat();
    if (!info.isFile() || info.nlink > 1) return { ...EMPTY, hasLog: true };
    const real = await realpath(file);
    const check = await stat(real);
    if (!real.startsWith(realDir + sep) || check.ino !== info.ino || check.dev !== info.dev) return { ...EMPTY, hasLog: true };
    const buf = Buffer.alloc(MAX_ACTIVITY_BYTES + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_ACTIVITY_BYTES) break;
    }
    let truncated = total > MAX_ACTIVITY_BYTES;
    let text = buf.subarray(0, Math.min(total, MAX_ACTIVITY_BYTES)).toString('utf8');
    if (truncated) text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));
    const entries: ProposalActivityEntry[] = [];
    for (const line of text.split('\n')) {
      const entry = line.trim() === '' ? null : entryOf(line);
      if (!entry) continue;
      if (entries.length === MAX_ACTIVITY_ENTRIES) { truncated = true; break; }
      entries.push(entry);
    }
    return { hasLog: true, truncated, entries };
  } catch {
    return EMPTY;
  } finally {
    await fh?.close().catch(() => {});
  }
}
