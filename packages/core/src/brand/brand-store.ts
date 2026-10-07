import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  brandKitSchema, brandProposalSchema, brandSourcesFileSchema, brandSourceSchema, EMPTY_BRAND_KIT,
  type BrandKit, type BrandProposal, type BrandSource,
} from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { WorkspaceError } from '../workspace-store.ts';

const PROPOSAL_RE = /^p-\d{8}-\d{6}(-\d+)?$/;
const issues = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) => e.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');

function isPrivateIPv4Octets(a: number, b: number, c: number, d: number): boolean {
  // 0.0.0.0/8 (this network)
  if (a === 0) return true;

  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;

  // 10.0.0.0/8 (private)
  if (a === 10) return true;

  // 172.16.0.0/12 (private)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 (private)
  if (a === 192 && b === 168) return true;

  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;

  return false;
}

function isPrivateIPv4(ipStr: string): boolean {
  const parts = ipStr.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p))) return false;

  const nums = parts.map((p) => Number(p));
  return isPrivateIPv4Octets(nums[0]!, nums[1]!, nums[2]!, nums[3]!);
}

export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase();

  // Strip trailing dot
  if (h.endsWith('.')) h = h.slice(0, -1);

  // localhost variants
  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  // Remove brackets for IPv6 literals
  const host = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;

  // Check if this is an IPv6 literal (contains ':')
  const isIPv6Literal = host.includes(':');

  if (isIPv6Literal) {
    // IPv6 loopback ::1 and ::
    if (host === '::1' || host === '::') return true;

    // IPv6 link-local fe80::/10 (fe80-febf::/10)
    // Match patterns like fe80::, fe81::, ..., febf::
    if (host.startsWith('fe')) {
      const firstByte = host.slice(2, 4);
      if (/^[89a-f]/.test(firstByte) && host[4] === ':') return true;
    }

    // IPv6 unique local fc00::/7 (fc00-fdff::/7)
    // Match patterns like fc00::, fd00::, etc.
    if (host.startsWith('fc:') || host.startsWith('fd:')) return true;
    if ((host.startsWith('fc') || host.startsWith('fd')) && host.length > 2) {
      const thirdChar = host[2]!;
      if (thirdChar === ':' || (thirdChar >= '0' && thirdChar <= '9') || (thirdChar >= 'a' && thirdChar <= 'f')) return true;
    }

    // IPv4-mapped IPv6: ::ffff:a.b.c.d or ::ffff:HHHH:HHHH
    if (host.startsWith('::ffff:')) {
      const ipPart = host.slice(7);
      // Check for dotted-quad form ::ffff:a.b.c.d
      if (ipPart.includes('.')) {
        return isPrivateIPv4(ipPart);
      }
      // Check for hex form ::ffff:HHHH:HHHH - convert to IPv4
      const parts = ipPart.split(':');
      if (parts.length === 2) {
        const a = parseInt(parts[0]!, 16) >> 8;
        const b = parseInt(parts[0]!, 16) & 0xff;
        const c = parseInt(parts[1]!, 16) >> 8;
        const d = parseInt(parts[1]!, 16) & 0xff;
        return isPrivateIPv4Octets(a, b, c, d);
      }
    }
    return false;
  }

  // IPv4 check (only for non-IPv6 literals)
  return isPrivateIPv4(host);
}

// Shared by every BrandStore instance (one per request): keys are absolute paths, so writers of the same files serialize.
const SHARED_LOCK = new KeyedMutex();

export class BrandStore {
  private readonly dir: string;
  private readonly lock = { run: <T>(key: string, fn: () => Promise<T>): Promise<T> => SHARED_LOCK.run(join(this.dir, key), fn) };
  constructor(projectDir: string) { this.dir = join(projectDir, 'brand'); }

  private path(name: string) { return join(this.dir, name); }

  async readKit(): Promise<BrandKit> {
    try { return await readJsonFile(this.path('brand-kit.json'), brandKitSchema); }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return EMPTY_BRAND_KIT; throw e; }
  }

  /** Replaces the kit, but refuses (JsonFileError) when the file on disk is corrupt: checked under the same lock as the write. */
  replaceReadableKit(kit: unknown): Promise<BrandKit> {
    return this.lock.run('kit', async () => {
      await this.readKit();
      return this.writeKitUnlocked(kit);
    });
  }

  writeKit(kit: unknown): Promise<BrandKit> {
    return this.lock.run('kit', () => this.writeKitUnlocked(kit));
  }

  private async writeKitUnlocked(kit: unknown): Promise<BrandKit> {
    {
      const parsed = brandKitSchema.safeParse(kit);
      if (!parsed.success) throw new WorkspaceError(400, `Brand kit non valido: ${issues(parsed.error)}`);
      await writeJsonFileAtomic(this.path('brand-kit.json'), parsed.data);
      return parsed.data;
    }
  }

  async readGuidelines(): Promise<string> {
    return readFile(this.path('guidelines.md'), 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return ''; throw e; });
  }

  writeGuidelines(text: string): Promise<void> {
    if (text.length > 200_000) throw new WorkspaceError(400, 'Linee guida troppo lunghe (massimo 200.000 caratteri)');
    return this.lock.run('guidelines', async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.path('guidelines.md'), text);
    });
  }

  async readSources(): Promise<BrandSource[]> {
    try { return (await readJsonFile(this.path('sources.json'), brandSourcesFileSchema)).sources; }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return []; throw e; }
  }

  addSource(input: { kind: 'website'; url: string } | { kind: 'image'; file: string }): Promise<BrandSource> {
    return this.lock.run('sources', async () => {
      const sources = await this.readSources();
      const n = Math.max(0, ...sources.map((s) => Number(s.id.slice(2)) || 0)) + 1;

      // For website sources: parse URL and validate host before schema validation
      if (input.kind === 'website') {
        let url: URL;
        try {
          url = new URL(input.url.trim());
        } catch {
          throw new WorkspaceError(400, `Sorgente non valida: URL non valido`);
        }
        if (isPrivateHost(url.hostname)) throw new WorkspaceError(400, 'Indirizzo locale o privato non ammesso come sorgente');
      }

      const parsed = brandSourceSchema.safeParse({
        id: `s-${n}`, kind: input.kind, url: input.kind === 'website' ? input.url.trim() : null,
        file: input.kind === 'image' ? input.file : null, addedAt: new Date().toISOString(), lastAnalyzedAt: null,
      });
      if (!parsed.success) throw new WorkspaceError(400, `Sorgente non valida: ${issues(parsed.error)}`);
      const s = parsed.data;
      if (sources.some((x) => (s.url && x.url === s.url) || (s.file && x.file === s.file))) throw new WorkspaceError(409, 'Sorgente già presente');
      await writeJsonFileAtomic(this.path('sources.json'), { schemaVersion: 1, sources: [...sources, s] });
      return s;
    });
  }

  removeSource(id: string): Promise<void> {
    return this.lock.run('sources', async () => {
      const sources = await this.readSources();
      if (!sources.some((s) => s.id === id)) throw new WorkspaceError(404, `Sorgente ${id} non trovata`);
      await writeJsonFileAtomic(this.path('sources.json'), { schemaVersion: 1, sources: sources.filter((s) => s.id !== id) });
    });
  }

  markAnalyzed(ids: string[], at: string): Promise<void> {
    return this.lock.run('sources', async () => {
      const sources = await this.readSources();
      await writeJsonFileAtomic(this.path('sources.json'), { schemaVersion: 1, sources: sources.map((s) => (ids.includes(s.id) ? { ...s, lastAnalyzedAt: at } : s)) });
    });
  }

  newProposalId(now = new Date()): Promise<string> {
    return this.lock.run('proposals', async () => {
      const pad = (n: number) => String(n).padStart(2, '0');
      const base = `p-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      await mkdir(join(this.dir, 'proposals'), { recursive: true });
      for (let i = 1; ; i++) {
        const id = i === 1 ? base : `${base}-${i}`;
        try { await mkdir(join(this.dir, 'proposals', id)); return id; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      }
    });
  }

  proposalDir(id: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) throw new WorkspaceError(400, `Identificativo proposta non valido: ${id}`);
    return join(this.dir, 'proposals', id);
  }

  async readProposal(id: string): Promise<BrandProposal> {
    try { return await readJsonFile(join(this.proposalDir(id), 'proposal.json'), brandProposalSchema); }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') throw new WorkspaceError(404, `Proposta ${id} non trovata`); throw e; }
  }

  writeProposal(p: BrandProposal): Promise<void> {
    return this.lock.run(`p:${p.id}`, () => writeJsonFileAtomic(join(this.proposalDir(p.id), 'proposal.json'), p));
  }

  async listProposals(): Promise<BrandProposal[]> {
    const entries = await readdir(join(this.dir, 'proposals'), { withFileTypes: true }).catch(() => []);
    const out: BrandProposal[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !PROPOSAL_RE.test(e.name)) continue;
      try { out.push(await this.readProposal(e.name)); } catch { /* in progress or unreadable */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
