import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { execCommand, type CommandExec } from '../exec.ts';

export interface SandboxSupport { available: boolean; reason: string }

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

export async function detectSandbox(opts: { platform?: NodeJS.Platform; exec?: CommandExec; exists?: (p: string) => Promise<boolean> } = {}): Promise<SandboxSupport> {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? execCommand;
  const exists = opts.exists ?? (async (p: string) => access(p).then(() => true, () => false));
  if (platform === 'darwin') {
    return (await exists('/usr/bin/sandbox-exec'))
      ? { available: true, reason: 'Disponibile' }
      : { available: false, reason: 'sandbox-exec non trovato: la sandbox di macOS non è disponibile' };
  }
  if (platform === 'linux') {
    const bwrap = (await exec('bwrap', ['--version'])).code === 0;
    const socat = (await exec('socat', ['-V'])).code === 0;
    if (bwrap && socat) return { available: true, reason: 'Disponibile' };
    return { available: false, reason: `Mancano ${[!bwrap && 'bubblewrap', !socat && 'socat'].filter(Boolean).join(' e ')}: installa bubblewrap e socat per isolare l'agente` };
  }
  return { available: false, reason: platform === 'win32' ? 'La sandbox di Claude Code non è disponibile su Windows' : `La sandbox non è supportata su ${platform}` };
}
