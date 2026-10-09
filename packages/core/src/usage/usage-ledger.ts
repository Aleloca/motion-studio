import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { usageRecordSchema, type UsageRecord } from '@motion-studio/shared';
import { KeyedMutex } from '../keyed-mutex.ts';

/**
 * `<project>/.studio/usage.jsonl`: one line per `claude` run, append-only. `.studio/` is denied to the agent (Edit rules
 * and the sandbox's denyWrite, see launcher PROTECTED_PROJECT_DIRS), so only the core writes here.
 */
export const usageLedgerFile = (projectDir: string) => join(projectDir, '.studio', 'usage.jsonl');

export interface UsageRange { from?: Date; to?: Date }

interface Cached { size: number; mtimeMs: number; records: UsageRecord[] }

/**
 * Appends validated records and reads them back, skipping malformed or partial lines. Reads are cached per file and
 * invalidated by any change of its size or mtime (a new line), so a report does not re-read unchanged ledgers.
 */
export class UsageLedger {
  private readonly locks = new KeyedMutex();
  private readonly cache = new Map<string, Cached>();

  /**
   * One `appendFile` of one whole line (O_APPEND: concurrent appends, even from another ledger instance, never
   * interleave inside a line). Validated first: an invalid record never reaches the file.
   */
  async append(projectDir: string, record: UsageRecord): Promise<UsageRecord> {
    const valid = usageRecordSchema.parse(record);
    const file = usageLedgerFile(projectDir);
    return this.locks.run(file, async () => {
      await mkdir(join(projectDir, '.studio'), { recursive: true });
      // A line left half-written (crash mid-write) would swallow the next record: start on a fresh line.
      const prefix = (await endsWithNewline(file)) ? '' : '\n';
      await appendFile(file, `${prefix}${JSON.stringify(valid)}\n`, { encoding: 'utf8', mode: 0o644 });
      return valid;
    });
  }

  /** Records whose `at` falls in [from, to). Never throws: a missing or unreadable ledger reads as empty. */
  async read(projectDir: string, range: UsageRange = {}): Promise<UsageRecord[]> {
    const all = await this.readAll(usageLedgerFile(projectDir));
    if (!range.from && !range.to) return all;
    const from = range.from?.getTime() ?? -Infinity;
    const to = range.to?.getTime() ?? Infinity;
    return all.filter((r) => { const at = Date.parse(r.at); return at >= from && at < to; });
  }

  /**
   * The last record of `sessionId` that carries the raw cumulative values (estimated records of cancelled runs have
   * none): the baseline the next run of the same session is measured against.
   */
  async lastOfSession(projectDir: string, sessionId: string): Promise<UsageRecord | null> {
    const all = await this.readAll(usageLedgerFile(projectDir));
    for (let i = all.length - 1; i >= 0; i--) {
      const r = all[i]!;
      if (r.sessionId === sessionId && (r.cumulativeCostUsd !== null || r.cumulativeModels.length > 0)) return r;
    }
    return null;
  }

  private async readAll(file: string): Promise<UsageRecord[]> {
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) { this.cache.delete(file); return []; }
    const hit = this.cache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.records;
    const records: UsageRecord[] = [];
    try {
      const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        const r = parseRecord(line);
        if (r) records.push(r);
      }
    } catch {
      return records; // unreadable mid-way: what was read so far, not cached
    }
    this.cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, records });
    return records;
  }
}

function parseRecord(line: string): UsageRecord | null {
  if (line.trim() === '') return null;
  let data: unknown;
  try { data = JSON.parse(line); } catch { return null; }
  const r = usageRecordSchema.safeParse(data);
  return r.success && Number.isFinite(Date.parse(r.data.at)) ? r.data : null;
}

async function endsWithNewline(file: string): Promise<boolean> {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return true; // no file yet
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await handle.close();
  }
}
