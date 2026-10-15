import { z } from 'zod';

/**
 * Files an analysis of a codebase must never read (Phase 14, spec §2.2, decision 721), in glob form. Only `*` is a wildcard and
 * it never crosses a `/`. An entry that ends in `/**` is a folder. Each entry can be placed after `**` + `/` in a tool rule,
 * e.g. `Read(//<path>/**` + `/<pattern>)`.
 */
export const SECRET_PATTERNS: readonly string[] = [
  '.env*', '*.pem', '*.key', '*.p12', '*.keystore', '*.jks', 'id_rsa*', '.npmrc', '.netrc', '.pypirc',
  'credentials*', 'secrets*', '*.mobileprovision', 'google-services.json', 'GoogleService-Info.plist', '.git/**',
];

const globToRegExp = (g: string): RegExp =>
  new RegExp(`^${g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`, 'i');
const SECRET_SEGMENT_RES = SECRET_PATTERNS.map((p) => globToRegExp(p.replace(/\/\*\*$/, '')));

/**
 * Whether a path inside a codebase (relative, `/` or `\` separators) is a secret file: any ONE segment (a folder or the file
 * name) matches a `SECRET_PATTERNS` entry, case-insensitively. Conservative on purpose: `.env.example`, `secrets.ts`,
 * `src/secretsauce.ts` (basename starts with `secrets`), `config/secrets/a.ts` and `.git/config` are secret; `env.ts`,
 * `keys.md` and `my-secrets.ts` are not (the wildcards are prefixes or suffixes of a segment, never a substring anywhere).
 */
export function isSecretPath(rel: string): boolean {
  return rel.replace(/\\/g, '/').split('/').some((seg) => seg !== '' && SECRET_SEGMENT_RES.some((re) => re.test(seg)));
}

/** The "Partenza" choices of an identity brief (spec §4.3). `concepts` counts only for a logo from scratch. */
export interface IdentityBrief { start: 'brand' | 'scratch'; name?: string; keywords?: string; colors?: 'brand' | 'free'; concepts?: number }
export const identityBriefSchema: z.ZodType<IdentityBrief> = z.object({
  start: z.enum(['brand', 'scratch']),
  name: z.string().trim().min(1).max(80).optional(),
  keywords: z.string().trim().max(300).optional(),
  colors: z.enum(['brand', 'free']).default('brand'),
  concepts: z.number().int().min(1).max(5).default(3),
});

/** A file an identity format wrote (composition-derived), for the outputs list. */
export interface IdentityOutputFile { path: string; width?: number; height?: number; alpha?: boolean; role: string }

export interface IdentitySetFile {
  /** Path inside the set's folder. */
  path: string;
  /** Square side in pixels of a PNG; absent for text and vector files. */
  size?: number;
  /** The PNG must have no alpha channel (decision 729). */
  opaque?: boolean;
  /** `master` always the main drawing; `auto`: the `small` variant when there is one and `size` <= 48 (decision 728), else the master. Default `master`. */
  from?: 'master' | 'small' | 'auto';
}

/** The sizes packed in `favicon.ico`. */
export const FAVICON_ICO_SIZES: readonly number[] = [16, 32, 48];

/** The files of each identity format (spec §4.1). `identity-logo` is the only one not square-sized by its set (its long side is 1024). */
export const IDENTITY_SETS: Record<'logo' | 'favicon' | 'app-icon', { files: IdentitySetFile[] }> = {
  logo: { files: [{ path: 'logo.svg' }, { path: 'logo.png', size: 1024 }] },
  favicon: {
    files: [
      { path: 'favicon.ico', from: 'auto' },
      { path: 'favicon.svg' },
      { path: 'apple-touch-icon.png', size: 180, opaque: true },
      { path: 'icon-192.png', size: 192 },
      { path: 'icon-512.png', size: 512 },
      { path: 'icon-512-maskable.png', size: 512 },
      { path: 'site.webmanifest' },
      { path: 'head-snippet.html' },
    ],
  },
  'app-icon': {
    files: [
      { path: 'AppIcon-1024.png', size: 1024, opaque: true },
      { path: 'Contents.json' },
      { path: 'ic_launcher-playstore.png', size: 512, opaque: true },
      { path: 'ic_launcher_foreground.png', size: 432 },
      { path: 'ic_launcher_background.png', size: 432 },
      { path: 'ic_launcher.xml' },
      { path: 'mipmap-mdpi/ic_launcher.png', size: 48, from: 'auto' },
      { path: 'mipmap-hdpi/ic_launcher.png', size: 72, from: 'auto' },
      { path: 'mipmap-xhdpi/ic_launcher.png', size: 96, from: 'auto' },
      { path: 'mipmap-xxhdpi/ic_launcher.png', size: 144, from: 'auto' },
      { path: 'mipmap-xxxhdpi/ic_launcher.png', size: 192, from: 'auto' },
    ],
  },
};
