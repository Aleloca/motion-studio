import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORMATS, FAVICON_ICO_SIZES, IDENTITY_SETS, SECRET_PATTERNS, identitySetInfoSchema, outputFileInfoSchema, channelName, creativeFileSchema, formatName, formatsFileSchema, identityBriefSchema, isSecretPath,
} from '../src/index.ts';

describe('isSecretPath', () => {
  const secret = [
    '.env', 'a/.env.local', '.env.example', 'x.pem', 'a/b/server.KEY', 'cert.p12', 'release.keystore', 'a.jks', 'id_rsa', 'id_rsa.pub',
    '.npmrc', 'sub/.netrc', '.pypirc', 'credentials.json', 'aws/credentials', 'secrets.json', 'a.mobileprovision',
    'android/app/google-services.json', 'ios/GoogleService-Info.plist', '.git/config', 'a/.git/HEAD', 'a\\b\\.env',
    // Decision 741: a segment that starts with `secrets` / `credentials` is secret, a file or a folder.
    'secrets.ts', 'src/secretsauce.ts', 'config/secrets/a.ts', 'src/credentialsProvider.ts',
    // Case-insensitive.
    '.ENV', 'Secrets.yml', 'googleservice-info.plist',
  ];
  const open = [
    'env.ts', 'keys.md', 'src/environment.ts', 'my-secrets.ts', 'monkey.md', 'pem.ts', 'src/key.ts', 'README.md', 'src/gitignore.ts', 'a/.gitignore',
    'envrc.txt', 'rsa.md', 'src/assets/logo.svg', '',
  ];
  it.each(secret)('%s is secret', (p) => { expect(isSecretPath(p)).toBe(true); });
  it.each(open)('%s is not secret', (p) => { expect(isSecretPath(p)).toBe(false); });
  it('lists the spec patterns, in glob form usable after **/', () => {
    expect(SECRET_PATTERNS).toEqual([
      '.env*', '*.pem', '*.key', '*.p12', '*.keystore', '*.jks', 'id_rsa*', '.npmrc', '.netrc', '.pypirc',
      'credentials*', 'secrets*', '*.mobileprovision', 'google-services.json', 'GoogleService-Info.plist', '.git/**',
    ]);
    for (const p of SECRET_PATTERNS) expect(p.startsWith('/')).toBe(false);
  });
});

describe('identity presets', () => {
  const get = (id: string) => DEFAULT_FORMATS.find((f) => f.id === id)!;
  it('has three 1024x1024 image presets in the Identity channel', () => {
    for (const [id, identity] of [['identity-logo', 'logo'], ['identity-favicon', 'favicon'], ['identity-app-icon', 'app-icon']] as const) {
      const p = get(id);
      expect([p.width, p.height, p.kind, p.channel, p.identity, p.extensions]).toEqual([1024, 1024, 'image', 'Identity', identity, ['png']]);
    }
    expect(DEFAULT_FORMATS.filter((f) => f.identity).length).toBe(3);
  });
  it('has the Open Graph preview', () => {
    const p = get('og-image-1200x630');
    expect([p.width, p.height, p.kind, p.channel, p.extensions, p.maxFileMB, p.identity]).toEqual([1200, 630, 'image', 'Web', ['png', 'jpg', 'jpeg'], 5, undefined]);
  });
  it('shows channel and names in both languages', () => {
    expect(channelName('Identity', 'it')).toBe('Identità');
    expect(channelName('Identity', 'en')).toBe('Identity');
    expect(formatName(get('identity-favicon'), 'it')).toBe('Favicon per siti');
    expect(formatName(get('identity-favicon'), 'en')).toBe('Website favicon');
    expect(formatName(get('og-image-1200x630'), 'it')).toBe('Anteprima social (Open Graph)');
  });
  it('still validates as a formats file; an old preset without `identity` parses', () => {
    expect(formatsFileSchema.safeParse({ schemaVersion: 1, presets: DEFAULT_FORMATS }).success).toBe(true);
    expect(formatsFileSchema.safeParse({ schemaVersion: 1, presets: [get('appstore-icon')] }).success).toBe(true);
    expect(formatsFileSchema.safeParse({ schemaVersion: 1, presets: [{ ...get('identity-logo'), identity: 'nope' }] }).success).toBe(false);
  });
});

describe('IDENTITY_SETS', () => {
  it('lists exactly the spec 4.1 files', () => {
    const paths = (k: keyof typeof IDENTITY_SETS) => IDENTITY_SETS[k].files.map((f) => f.path);
    expect(Object.keys(IDENTITY_SETS).sort()).toEqual(['app-icon', 'favicon', 'logo']);
    expect(paths('logo')).toEqual(['logo.svg', 'logo.png']);
    expect(paths('favicon')).toEqual([
      'favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'site.webmanifest', 'head-snippet.html',
    ]);
    expect(paths('app-icon')).toEqual([
      'AppIcon-1024.png', 'Contents.json', 'ic_launcher-playstore.png', 'ic_launcher_foreground.png', 'ic_launcher_background.png', 'ic_launcher.xml',
      'mipmap-mdpi/ic_launcher.png', 'mipmap-hdpi/ic_launcher.png', 'mipmap-xhdpi/ic_launcher.png', 'mipmap-xxhdpi/ic_launcher.png', 'mipmap-xxxhdpi/ic_launcher.png',
    ]);
  });
  it('has the sizes and the opaque files of decision 729', () => {
    const f = (k: keyof typeof IDENTITY_SETS) => Object.fromEntries(IDENTITY_SETS[k].files.map((x) => [x.path, x]));
    expect(f('logo')['logo.png']).toEqual({ path: 'logo.png', size: 1024 });
    expect(f('favicon')['apple-touch-icon.png']).toEqual({ path: 'apple-touch-icon.png', size: 180, opaque: true });
    expect(f('favicon')['icon-512-maskable.png']!.size).toBe(512);
    expect(f('app-icon')['AppIcon-1024.png']).toEqual({ path: 'AppIcon-1024.png', size: 1024, opaque: true });
    expect(f('app-icon')['ic_launcher-playstore.png']).toEqual({ path: 'ic_launcher-playstore.png', size: 512, opaque: true });
    expect(IDENTITY_SETS['app-icon'].files.filter((x) => x.path.startsWith('mipmap-')).map((x) => x.size)).toEqual([48, 72, 96, 144, 192]);
    const opaque = Object.values(IDENTITY_SETS).flatMap((s) => s.files).filter((x) => x.opaque).map((x) => x.path);
    expect(opaque).toEqual(['apple-touch-icon.png', 'AppIcon-1024.png', 'ic_launcher-playstore.png']);
  });
});

describe('FAVICON_ICO_SIZES and the set info', () => {
  it('favicon.ico packs 16, 32 and 48 px, and takes the small variant for them (from: auto)', () => {
    expect([...FAVICON_ICO_SIZES]).toEqual([16, 32, 48]);
    expect(IDENTITY_SETS.favicon.files.find((f) => f.path === 'favicon.ico')).toEqual({ path: 'favicon.ico', from: 'auto' });
    expect(Math.max(...FAVICON_ICO_SIZES)).toBeLessThanOrEqual(48);
  });
  it('an output entry may carry its identity set; older entries have none', () => {
    const base = { format: 'identity-favicon', file: 'identity-favicon.png', width: 1024, height: 1024, durationSec: null, verified: true, preview: null };
    expect(outputFileInfoSchema.parse(base).identitySet).toBeUndefined();
    const set = { dir: 'identity-favicon', files: [{ path: 'favicon.ico', role: 'favicon' }, { path: 'icon-192.png', width: 192, height: 192, alpha: true, role: 'icon' }], warnings: ['w'] };
    expect(outputFileInfoSchema.parse({ ...base, identitySet: set }).identitySet).toEqual(set);
    expect(identitySetInfoSchema.safeParse({ ...set, files: [{ path: '', role: 'x' }] }).success).toBe(false);
  });
});

describe('identityBriefSchema', () => {
  it('defaults colors to brand and concepts to 3', () => {
    expect(identityBriefSchema.parse({ start: 'brand' })).toEqual({ start: 'brand', colors: 'brand', concepts: 3 });
    expect(identityBriefSchema.parse({ start: 'scratch', name: ' Acme ', keywords: 'bold', colors: 'free', concepts: 5 }))
      .toEqual({ start: 'scratch', name: 'Acme', keywords: 'bold', colors: 'free', concepts: 5 });
  });
  it('refuses bad starts and out-of-range concepts or long text', () => {
    for (const bad of [{}, { start: 'x' }, { start: 'scratch', concepts: 0 }, { start: 'scratch', concepts: 6 }, { start: 'scratch', concepts: 2.5 },
      { start: 'scratch', colors: 'x' }, { start: 'scratch', name: '' }, { start: 'scratch', name: 'a'.repeat(81) }, { start: 'scratch', keywords: 'a'.repeat(301) }]) {
      expect(identityBriefSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('creative brief compatibility', () => {
  const now = '2026-10-07T10:00:00.000Z';
  const creative = {
    schemaVersion: 1, title: 'Old', status: 'draft', error: null, createdAt: now, updatedAt: now, resumeFrom: null, linkedCodebases: [],
    brief: { goal: 'Goal', message: '', formats: ['instagram-post-1x1'], durationSec: 15, assets: [], notes: '' },
  };
  it('an old creative parses unchanged and a brief can carry identity', () => {
    const old = creativeFileSchema.parse(creative);
    expect(old.brief.identity).toBeUndefined();
    const withId = creativeFileSchema.parse({ ...creative, brief: { ...creative.brief, formats: ['identity-logo', 'identity-logo@2'], identity: { start: 'scratch', name: 'Acme' } } });
    expect(withId.brief.identity).toEqual({ start: 'scratch', name: 'Acme', colors: 'brand', concepts: 3 });
    expect(creativeFileSchema.safeParse({ ...creative, brief: { ...creative.brief, identity: { start: 'nope' } } }).success).toBe(false);
  });
});
