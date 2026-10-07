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

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();

  // localhost variants
  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  // Remove brackets for IPv6
  const host = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;

  // IPv6 loopback ::1
  if (host === '::1') return true;

  // IPv6 link-local fe80::/10
  if (host.startsWith('fe80:')) return true;

  // IPv6 unique local fc00::/7
  if (host.startsWith('fc') || host.startsWith('fd')) return true;

  // Parse IPv4
  const parts = host.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const nums = parts.map((p) => Number(p));
    const a = nums[0]!;
    const b = nums[1]!;

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
  }

  return false;
}

export class BrandStore {
  private readonly dir: string;
  private readonly lock = new KeyedMutex();
  constructor(projectDir: string) { this.dir = join(projectDir, 'brand'); }

  private path(name: string) { return join(this.dir, name); }

  async readKit(): Promise<BrandKit> {
    try { return await readJsonFile(this.path('brand-kit.json'), brandKitSchema); }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return EMPTY_BRAND_KIT; throw e; }
  }

  writeKit(kit: unknown): Promise<BrandKit> {
    return this.lock.run('kit', async () => {
      const parsed = brandKitSchema.safeParse(kit);
      if (!parsed.success) throw new WorkspaceError(400, `Brand kit non valido: ${issues(parsed.error)}`);
      await writeJsonFileAtomic(this.path('brand-kit.json'), parsed.data);
      return parsed.data;
    });
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

      // Validate private host for website sources
      if (input.kind === 'website') {
        try {
          const url = new URL(input.url.trim());
          if (isPrivateHost(url.hostname)) throw new WorkspaceError(400, 'Indirizzo locale o privato non ammesso come sorgente');
        } catch (e) {
          if (e instanceof WorkspaceError) throw e;
          // URL parsing error will be caught by schema validation below
        }
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
    if (id.includes('..') || id.includes('/')) throw new WorkspaceError(400, `Identificativo proposta non valido: ${id}`);
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
