import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { permissionsFileSchema, type PermissionsFile } from '@motion-studio/shared';
import { sensitiveHomeEntries } from '../agent/sandbox.ts';
import { defaultConfigDir } from '../app-config.ts';
import { isPrivateHost } from '../brand/brand-store.ts';
import { escapeGlob } from '../codebases.ts';
import { fileLock } from '../file-locks.ts';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { WorkspaceError } from '../workspace-store.ts';

const RISKY_COMMANDS = new Set([
  'sudo', 'rm', 'sh', 'bash', 'zsh', 'eval', 'exec', 'chmod', 'chown', 'dd', 'mkfs',
  'env', 'xargs', 'command', 'nohup', 'time', 'timeout', 'nice', 'builtin', 'source', 'fish', 'dash', 'ksh', 'csh', 'tcsh',
  'su', 'doas', 'osascript', 'perl', 'ruby', 'awk', 'find',
]);
/** Interpreters and package runners: the grant is keyed on the first two words (e.g. "brew install"). */
const TWO_WORD_COMMANDS = new Set(['node', 'python', 'python3', 'npx', 'npm', 'pnpm', 'yarn', 'pip', 'pip3', 'brew', 'uv', 'deno', 'bun']);
const PROVIDER_RULES = new Set(['provider:openai-images', 'provider:tts-openai', 'provider:tts-elevenlabs']);
const STUDIO_RULES = new Set(['mcp__studio__report_progress']);
const MAX_RULE = 500;
const MAX_LABEL = 300;
export const MAX_PERMISSIONS = 200;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export interface RuleEnv { home?: string; platform?: NodeJS.Platform; configDir?: string }

/** True when `p` is `base` or lies inside it (case-insensitive when asked). */
function isInside(p: string, base: string, ci: boolean): boolean {
  const a = ci ? p.toLowerCase() : p;
  const b = ci ? base.toLowerCase() : base;
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/** Directory to grant, or null when it is the root, the home, one of its ancestors, or a sensitive place. */
function safeDir(dir: string, env: RuleEnv): string | null {
  const home = resolve(env.home ?? homedir());
  const ci = (env.platform ?? process.platform) === 'darwin';
  if (!dir.startsWith('/') || dir === '/') return null;
  if (isInside(home, dir, ci)) return null; // home itself or an ancestor of it
  const { dirs, files } = sensitiveHomeEntries(home);
  const configDir = resolve(env.configDir ?? defaultConfigDir());
  if ([...dirs, ...files, configDir].some((x) => isInside(dir, x, ci) || isInside(x, dir, ci))) return null;
  return dir;
}

function dirRule(tool: 'Edit' | 'Read', filePath: string, env: RuleEnv) {
  if (!filePath.startsWith('/')) return null;
  const dir = safeDir(dirname(resolve(filePath)), env);
  if (!dir) return null;
  return { rule: `${tool}(/${escapeGlob(dir)}/**)`, label: `${tool === 'Edit' ? 'Modifiche' : 'Letture'} in ${dir}` };
}

function bashRule(command: string) {
  const [w, second] = command.trim().split(/\s+/);
  if (!w || w.startsWith('.') || !/^[A-Za-z0-9._-]+$/.test(w) || RISKY_COMMANDS.has(w)) return null;
  if (TWO_WORD_COMMANDS.has(w)) {
    if (!second || second.startsWith('-') || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(second)) return null;
    return { rule: `Bash(${w} ${second}:*)`, label: `Comandi "${w} ${second}"` };
  }
  return { rule: `Bash(${w}:*)`, label: `Comandi "${w}"` };
}

function rawRuleFor(toolName: string, input: unknown, env: RuleEnv): { rule: string; label: string } | null {
  const i = (input ?? {}) as Record<string, unknown>;
  if (toolName === 'Bash') return bashRule(str(i.command));
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return dirRule('Edit', str(i.file_path), env);
  if (toolName === 'Read') return dirRule('Read', str(i.file_path), env);
  if (toolName === 'WebFetch') {
    try {
      const host = new URL(str(i.url)).hostname;
      return host && !isPrivateHost(host) ? { rule: `WebFetch(domain:${host})`, label: `Pagine di ${host}` } : null;
    } catch { return null; }
  }
  if (PROVIDER_RULES.has(toolName)) return { rule: toolName, label: `Uso di ${toolName.slice(9)} senza conferma` };
  if (STUDIO_RULES.has(toolName)) return { rule: toolName, label: `Strumento ${toolName}` };
  return null;
}

export function ruleFor(toolName: string, input: unknown, env: RuleEnv = {}): { rule: string; label: string } | null {
  const r = rawRuleFor(toolName, input, env);
  if (!r || r.rule.length > MAX_RULE) return null;
  return { rule: r.rule, label: r.label.slice(0, MAX_LABEL) };
}

const unescapeGlob = (p: string) => p.replace(/\\([\\\[\]*?{}()!+@])/g, '$1');

/** Accepts exactly the shapes `ruleFor` can produce, and nothing else. */
export function isAllowedRule(rule: string, env: RuleEnv = {}): boolean {
  if (typeof rule !== 'string' || rule.length > MAX_RULE) return false;
  if (PROVIDER_RULES.has(rule) || STUDIO_RULES.has(rule)) return true;
  let m = /^Bash\(([A-Za-z0-9._-]+)(?: ([A-Za-z0-9_][A-Za-z0-9_-]*))?:\*\)$/.exec(rule);
  if (m) {
    const [, w, sub] = m;
    if (w!.startsWith('.') || RISKY_COMMANDS.has(w!)) return false;
    return TWO_WORD_COMMANDS.has(w!) ? Boolean(sub) : !sub;
  }
  m = /^(Edit|Read)\(\/\/(.+)\/\*\*\)$/.exec(rule);
  if (m) {
    const dir = '/' + unescapeGlob(m[2]!);
    if (/[\\[\]*?{}()!+@]/.test(m[2]!.replace(/\\./g, ''))) return false; // unescaped glob characters
    return !dir.split('/').includes('..') && !dir.includes('/./') && !dir.includes('//') && !dir.endsWith('/') && safeDir(dir, env) === dir;
  }
  m = /^WebFetch\(domain:([^\s()]+)\)$/.exec(rule);
  if (m) return !isPrivateHost(m[1]!);
  return false;
}

export class PermissionsStore {
  private readonly file: string;
  constructor(projectDir: string) { this.file = join(projectDir, '.studio', 'permissions.json'); }

  async list(): Promise<PermissionsFile['allow']> {
    try { return (await readJsonFile(this.file, permissionsFileSchema)).allow; }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return []; throw e; }
  }
  async has(rule: string) { return (await this.list()).some((r) => r.rule === rule); }
  async add(rule: string, label: string): Promise<void> {
    if (!isAllowedRule(rule)) throw new WorkspaceError(400, 'Regola di permesso non valida');
    await fileLock.run(this.file, async () => {
      const allow = await this.list();
      if (allow.some((r) => r.rule === rule)) return;
      if (allow.length >= MAX_PERMISSIONS) throw new WorkspaceError(409, 'Troppi permessi salvati: revocane qualcuno nelle impostazioni del progetto');
      const next = permissionsFileSchema.safeParse({ schemaVersion: 1, allow: [...allow, { rule, label: label.slice(0, MAX_LABEL), addedAt: new Date().toISOString() }] });
      if (!next.success) throw new WorkspaceError(400, 'Permesso non valido');
      await writeJsonFileAtomic(this.file, next.data);
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
