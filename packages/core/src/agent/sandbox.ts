import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { execCommand, type CommandExec } from '../exec.ts';
import { t } from '../i18n.ts';

/** `disabled`: the system may support it but the workspace settings turned it off. */
export interface SandboxSupport { available: boolean; reason: string; disabled?: boolean }

export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
  'registry.npmjs.org', '*.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org',
  'github.com', '*.github.com', '*.githubusercontent.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
  'esm.sh', 'fonts.googleapis.com', 'fonts.gstatic.com', 'remotion.dev', '*.remotion.dev',
];

const SENSITIVE = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.config/gh', '.config/gcloud', '.netrc', '.npmrc',
  '.pypirc', '.git-credentials', 'Library/Keychains', 'Library/Application Support/Motion Studio', '.config/motion-studio'];
const SENSITIVE_FILES = new Set(['.netrc', '.npmrc', '.pypirc', '.git-credentials']);
/** Sensitive entries split by kind: folders need a `/**` rule, single files an exact one. */
export const sensitiveHomeEntries = (home: string) => ({
  dirs: SENSITIVE.filter((p) => !SENSITIVE_FILES.has(p)).map((p) => join(home, ...p.split('/'))),
  files: SENSITIVE.filter((p) => SENSITIVE_FILES.has(p)).map((p) => join(home, ...p.split('/'))),
});
export const sensitiveHomePaths = (home: string) => SENSITIVE.map((p) => join(home, ...p.split('/')));

/** The reason is worded when read, not when detected: the detection is cached and the language can change meanwhile. */
const support = (available: boolean, reason: () => string): SandboxSupport => ({ available, get reason() { return reason(); } });

export async function detectSandbox(opts: { platform?: NodeJS.Platform; exec?: CommandExec; exists?: (p: string) => Promise<boolean> } = {}): Promise<SandboxSupport> {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? execCommand;
  const exists = opts.exists ?? (async (p: string) => access(p).then(() => true, () => false));
  if (platform === 'darwin') {
    return (await exists('/usr/bin/sandbox-exec'))
      ? support(true, () => t().doctor.sandboxAvailableReason)
      : support(false, () => t().doctor.sandboxExecMissing);
  }
  if (platform === 'linux') {
    const bwrap = (await exec('bwrap', ['--version'])).code === 0;
    const socat = (await exec('socat', ['-V'])).code === 0;
    if (bwrap && socat) return support(true, () => t().doctor.sandboxAvailableReason);
    return support(false, () => t().doctor.sandboxLinuxMissing({ tools: [!bwrap && 'bubblewrap', !socat && 'socat'].filter(Boolean).join(` ${t().doctor.sandboxAnd} `) }));
  }
  return support(false, () => (platform === 'win32' ? t().doctor.sandboxWindows : t().doctor.sandboxUnsupported({ platform })));
}

/** detectSandbox() run once and shared (a rejection is not kept, so a later call retries). */
export function cachedSandboxDetection(detect: () => Promise<SandboxSupport> = () => detectSandbox()): () => Promise<SandboxSupport> {
  let p: Promise<SandboxSupport> | null = null;
  return () => (p ??= detect().catch((err) => { p = null; throw err; }));
}
