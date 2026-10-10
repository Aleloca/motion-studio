import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Git hardening against a tampered repository (decisions log 141). The agent can write inside the project, and under a
 * workspace path with `[ ] * ?` (or by moving the whole project folder out of the sandbox and back) it can reach
 * `.git/config` and the attributes files. A `filter.<x>.clean`, a `diff.<x>.textconv`, a `core.sshCommand`, an
 * `include.path` and the like all run a command or load a file OUTSIDE the sandbox on the core's next `git add`/`commit`.
 * Before every core git call the config and attributes are checked against an allowlist; anything else blocks the repo.
 */

/** Exactly the keys a fresh `git init -b main` writes (verified on git 2.x), lowercased `section.key`. `user.*` is allowed on top (the core passes its identity with `-c`, but a stored one is harmless). */
const ALLOWED_CONFIG_KEYS = new Set([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates',
  'core.ignorecase', 'core.precomposeunicode', 'core.symlinks', 'core.hidedotfiles',
]);

export class GitUnsafeError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = 'GitUnsafeError';
  }
}

interface ConfigEntry { section: string; subsection?: string; key: string }

/** Parses a `.git/config` into its fully-qualified keys. Tolerant: an unparsable line is reported as a blocking key. */
export function parseGitConfigKeys(text: string): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  let section = '';
  let subsection: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[;#].*$/, '').trim();
    if (line === '') continue;
    const header = /^\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]$/.exec(line);
    if (header) {
      // `[section.sub]` is also legal: the part after the first dot is a (dot-joined) subsection.
      const dot = header[1]!.indexOf('.');
      if (header[2] !== undefined) { section = header[1]!.toLowerCase(); subsection = header[2]; }
      else if (dot >= 0) { section = header[1]!.slice(0, dot).toLowerCase(); subsection = header[1]!.slice(dot + 1); }
      else { section = header[1]!.toLowerCase(); subsection = undefined; }
      continue;
    }
    if (section === '') { out.push({ section: '?', key: raw.trim() }); continue; }
    const key = /^([A-Za-z0-9-]+)\s*(=.*)?$/.exec(line);
    out.push(key ? { section, subsection, key: key[1]!.toLowerCase() } : { section, subsection, key: `?${raw.trim()}` });
  }
  return out;
}

/** A config entry the core trusts: `user.*`, or a known `section.key` with no subsection. Anything else (a subsection, or an unknown key) is rejected. */
function isAllowedConfig(e: ConfigEntry): boolean {
  if (e.section === 'user' && e.subsection === undefined) return true;
  if (e.subsection !== undefined) return false;
  return ALLOWED_CONFIG_KEYS.has(`${e.section}.${e.key}`);
}

/** Attribute tokens that make git run a command or load a driver; `merge=union` and `merge=binary` are built-ins and safe. */
function dangerousAttr(token: string): boolean {
  const m = /^([A-Za-z][\w-]*)=(.+)$/.exec(token);
  if (!m) return false;
  const [, name, value] = m;
  if (name === 'filter' || name === 'diff') return true;
  if (name === 'merge') return value !== 'union' && value !== 'binary' && value !== 'text';
  return false;
}

/** Lines of an attributes file that set a dangerous attribute (used by the caller to block the repo). */
export function dangerousAttributeLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const tokens = line.split(/\s+/).slice(1); // the first token is the pattern
    if (tokens.some(dangerousAttr)) out.push(raw.trim());
  }
  return out;
}

/**
 * Checks a project's `.git/config`, `.gitattributes` and `.git/info/attributes`. Returns null when safe, or a short English
 * detail of the first problem (the i18n message is added by the caller). A missing file is safe; a repo with no `.git` yet
 * (before `git init`) is safe.
 */
export async function inspectGitSafety(projectDir: string): Promise<string | null> {
  const config = await readFile(join(projectDir, '.git', 'config'), 'utf8').catch(() => null);
  if (config !== null) {
    const bad = parseGitConfigKeys(config).filter((e) => !isAllowedConfig(e));
    if (bad.length > 0) {
      const name = (e: ConfigEntry) => `${e.section}${e.subsection !== undefined ? `.${e.subsection}` : ''}.${e.key}`;
      return `.git/config has keys the core does not set: ${[...new Set(bad.map(name))].slice(0, 5).join(', ')}`;
    }
  }
  for (const rel of [['.gitattributes'], ['.git', 'info', 'attributes']]) {
    const text = await readFile(join(projectDir, ...rel), 'utf8').catch(() => null);
    if (text === null) continue;
    const bad = dangerousAttributeLines(text);
    if (bad.length > 0) return `${rel.join('/')} has a filter/diff/merge driver: ${bad.slice(0, 3).join(' | ')}`;
  }
  return null;
}

/**
 * Repositories the core refuses to touch for the rest of this process (the integrity tripwire found a protected file
 * changed, or a git-config/attributes check failed). The user restores the repo (or restarts the app) to clear it; the
 * core keeps no trusted copy of `.git`, so it never rewrites the repo on its own.
 */
const quarantined = new Set<string>();
export function quarantineRepo(projectDir: string): void { quarantined.add(projectDir); }
export function isQuarantined(projectDir: string): boolean { return quarantined.has(projectDir); }
export function clearQuarantineForTests(): void { quarantined.clear(); }
