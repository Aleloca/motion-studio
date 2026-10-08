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

/** Commands that may be granted "always": media/file tools whose arguments cannot run other programs. Exact, case-sensitive. */
const SAFE_ALWAYS = new Set(['ls', 'mkdir', 'ffprobe', 'cwebp', 'gifsicle', 'optipng', 'pngquant', 'rsvg-convert']);
/** Ordered by how a system folder may be granted: never the folder itself nor anything inside it. */
const SYSTEM_DIRS = ['/etc', '/private', '/usr', '/bin', '/sbin', '/System', '/Library', '/Applications'];
const SHELL_CONTROL = /[;&|`$<>\n\r(){}]/;
const PROVIDER_RULES = new Set(['provider:openai-images', 'provider:tts-openai', 'provider:tts-elevenlabs']);
const STUDIO_RULES = new Set(['mcp__studio__report_progress']);
/** Folders that configure Motion Studio, git or the agent (compared in lower case on case-insensitive volumes). */
const PROTECTED_SEGMENTS = new Set(['.studio', '.git', '.claude']);
const MAX_RULE = 500;
const MAX_LABEL = 300;
export const MAX_PERMISSIONS = 200;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** workspaceRoot: the folder of the projects, when known (it can never be granted, nor an ancestor of it). */
export interface RuleEnv { home?: string; platform?: NodeJS.Platform; configDir?: string; workspaceRoot?: string }

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
  // A whole top-level folder (/Users, /home, /Volumes, /opt…) is never a narrow grant, whatever the platform.
  if (dir.split('/').filter(Boolean).length < 2) return null;
  if (isInside(home, dir, ci)) return null; // home itself or an ancestor of it
  // .studio holds a project's permissions, .git its hooks, .claude the agent's settings: no rule may ever reach one, nor the workspace holding the projects.
  if (dir.split('/').some((seg) => PROTECTED_SEGMENTS.has(ci ? seg.toLowerCase() : seg))) return null;
  if (env.workspaceRoot && isInside(resolve(env.workspaceRoot), dir, ci)) return null;
  const { dirs, files } = sensitiveHomeEntries(home);
  const configDir = resolve(env.configDir ?? defaultConfigDir());
  if ([...dirs, ...files, configDir].some((x) => isInside(dir, x, ci) || isInside(x, dir, ci))) return null;
  if ([join(home, '.claude'), join(home, 'Library', 'LaunchAgents'), ...SYSTEM_DIRS].some((x) => isInside(dir, x, ci))) return null;
  return dir;
}

function dirRule(tool: 'Edit' | 'Read', filePath: string, env: RuleEnv) {
  if (!filePath.startsWith('/')) return null;
  const dir = safeDir(dirname(resolve(filePath)), env);
  if (!dir) return null;
  return { rule: `${tool}(/${escapeGlob(dir)}/**)`, label: `${tool === 'Edit' ? 'Modifiche' : 'Letture'} in ${dir}` };
}

function bashRule(command: string) {
  const cmd = command.trim();
  if (SHELL_CONTROL.test(cmd)) return null;
  const [w] = cmd.split(/\s+/);
  if (w && SAFE_ALWAYS.has(w)) return { rule: `Bash(${w}:*)`, label: `Comandi "${w}"` };
  return null;
}

/** A canonical, public DNS name: no wildcard, port, IP shorthand or private/loopback address. */
function isPublicHost(host: string): boolean {
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.')) return false;
  try { if (new URL('http://' + host).hostname !== host) return false; } catch { return false; }
  return !isPrivateHost(host);
}

function rawRuleFor(toolName: string, input: unknown, env: RuleEnv): { rule: string; label: string } | null {
  const i = (input ?? {}) as Record<string, unknown>;
  if (toolName === 'Bash') return bashRule(str(i.command));
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return dirRule('Edit', str(i.file_path), env);
  if (toolName === 'Read') return dirRule('Read', str(i.file_path), env);
  if (toolName === 'WebFetch') {
    try {
      const host = new URL(str(i.url)).hostname;
      return isPublicHost(host) ? { rule: `WebFetch(domain:${host})`, label: `Pagine di ${host}` } : null;
    } catch { return null; }
  }
  if (PROVIDER_RULES.has(toolName)) return { rule: toolName, label: `Uso di ${toolName.slice(9)} senza conferma` };
  if (STUDIO_RULES.has(toolName)) return { rule: toolName, label: `Strumento ${toolName}` };
  return null;
}

export function ruleFor(toolName: string, input: unknown, env: RuleEnv = {}): { rule: string; label: string } | null {
  const r = rawRuleFor(toolName, input, env);
  if (!r || !isAllowedRule(r.rule, env)) return null;
  return { rule: r.rule, label: r.label.slice(0, MAX_LABEL) };
}

const unescapeGlob = (p: string) => p.replace(/\\([\\\[\]*?{}()!+@])/g, '$1');

/** Accepts exactly the shapes `ruleFor` can produce, and nothing else. */
export function isAllowedRule(rule: string, env: RuleEnv = {}): boolean {
  if (typeof rule !== 'string' || rule.length > MAX_RULE) return false;
  if (PROVIDER_RULES.has(rule) || STUDIO_RULES.has(rule)) return true;
  let m = /^Bash\(([a-z0-9-]+):\*\)$/.exec(rule);
  if (m) return SAFE_ALWAYS.has(m[1]!);
  m = /^(Edit|Read)\(\/\/(.+)\/\*\*\)$/.exec(rule);
  if (m) {
    const raw = m[2]!;
    if (/[\n\r]/.test(rule)) return false;
    const rest = raw.replace(/\\[\\\[\]*?{}()!+@]/g, ''); // only escapes produced by escapeGlob
    if (/[\\[\]*?{}()!+@]/.test(rest)) return false;
    const dir = '/' + unescapeGlob(raw);
    return !dir.split('/').includes('..') && !dir.includes('/./') && !dir.includes('//') && !dir.endsWith('/') && safeDir(dir, env) === dir;
  }
  m = /^WebFetch\(domain:([^()]+)\)$/.exec(rule);
  if (m) return isPublicHost(m[1]!);
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
