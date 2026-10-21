// The desktop app's extraResources (electron-builder.yml), gathered into apps/desktop/resources before packaging: the built
// web UI, the `studio` MCP server, the composition runtime and, when scripts/build-whisper.sh built it, the bundled whisper-cli
// per architecture (vendor/whisper/<arch> → resources/whisper/<arch>; macOS only, spec §7). Without a built Whisper there is no
// whisper folder: the app then uses an installed Whisper.
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_FILES = ['index.html', 'runtime.js', 'layer.js', 'clock.js', 'preview.js'];
const WHISPER_ARCHS = ['arm64', 'x64'];

/** `desktopDir`: apps/desktop (the repo root is two levels up). */
export function prepareResources({ desktopDir }) {
  const root = resolve(desktopDir, '..', '..');
  const out = join(desktopDir, 'resources');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(root, 'packages/web/dist'), join(out, 'web'), { recursive: true });
  copyFileSync(join(root, 'packages/mcp-studio/src/server.mjs'), join(out, 'mcp-studio.mjs'));
  cpSync(join(root, 'packages/composition-runtime/dist'), join(out, 'runtime'), { recursive: true });
  for (const f of RUNTIME_FILES) if (!existsSync(join(out, 'runtime', f))) throw new Error(`composition runtime not built: ${f}`);
  const vendor = join(desktopDir, 'vendor/whisper');
  const archs = existsSync(vendor) ? readdirSync(vendor).filter((a) => WHISPER_ARCHS.includes(a) && statSync(join(vendor, a)).isDirectory()) : [];
  for (const a of archs) cpSync(join(vendor, a), join(out, 'whisper', a), { recursive: true });
  return { whisper: archs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = prepareResources({ desktopDir: resolve(dirname(fileURLToPath(import.meta.url)), '..') });
  console.log(r.whisper.length ? `bundled whisper-cli: ${r.whisper.join(', ')}` : 'no bundled whisper-cli (vendor/whisper is empty)');
}
