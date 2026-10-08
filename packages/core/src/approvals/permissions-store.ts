import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { permissionsFileSchema, type PermissionsFile } from '@motion-studio/shared';
import { escapeGlob } from '../codebases.ts';
import { fileLock } from '../file-locks.ts';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { WorkspaceError } from '../workspace-store.ts';

const RISKY_COMMANDS = new Set(['sudo', 'rm', 'sh', 'bash', 'zsh', 'eval', 'exec', 'chmod', 'chown', 'dd', 'mkfs']);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function dirRule(tool: 'Edit' | 'Read', filePath: string) {
  const dir = dirname(filePath);
  if (!filePath.startsWith('/') || dir === '/' || dir === homedir()) return null;
  return { rule: `${tool}(/${escapeGlob(dir)}/**)`, label: `${tool === 'Edit' ? 'Modifiche' : 'Letture'} in ${dir}` };
}

export function ruleFor(toolName: string, input: unknown): { rule: string; label: string } | null {
  const i = (input ?? {}) as Record<string, unknown>;
  if (toolName === 'Bash') {
    const word = str(i.command).trim().split(/\s+/)[0] ?? '';
    if (!/^[A-Za-z0-9._-]+$/.test(word) || RISKY_COMMANDS.has(word)) return null;
    return { rule: `Bash(${word}:*)`, label: `Comandi "${word}"` };
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return dirRule('Edit', str(i.file_path));
  if (toolName === 'Read') return dirRule('Read', str(i.file_path));
  if (toolName === 'WebFetch') {
    try { const host = new URL(str(i.url)).hostname; return host ? { rule: `WebFetch(domain:${host})`, label: `Pagine di ${host}` } : null; } catch { return null; }
  }
  if (toolName.startsWith('provider:')) return { rule: toolName, label: `Uso di ${toolName.slice(9)} senza conferma` };
  if (toolName.startsWith('mcp__')) return { rule: toolName, label: `Strumento ${toolName}` };
  return null;
}

export class PermissionsStore {
  private readonly file: string;
  constructor(projectDir: string) { this.file = join(projectDir, '.studio', 'permissions.json'); }

  async list(): Promise<PermissionsFile['allow']> {
    try { return (await readJsonFile(this.file, permissionsFileSchema)).allow; }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return []; throw e; }
  }
  async has(rule: string) { return (await this.list()).some((r) => r.rule === rule); }
  add(rule: string, label: string): Promise<void> {
    return fileLock.run(this.file, async () => {
      const allow = await this.list();
      if (allow.some((r) => r.rule === rule)) return;
      await writeJsonFileAtomic(this.file, { schemaVersion: 1, allow: [...allow, { rule, label, addedAt: new Date().toISOString() }] });
      fileLock.noteWrite(this.file);
    });
  }
  remove(rule: string): Promise<void> {
    return fileLock.run(this.file, async () => {
      const allow = await this.list();
      if (!allow.some((r) => r.rule === rule)) throw new WorkspaceError(404, 'Permesso non trovato');
      await writeJsonFileAtomic(this.file, { schemaVersion: 1, allow: allow.filter((r) => r.rule !== rule) });
      fileLock.noteWrite(this.file);
    });
  }
}
