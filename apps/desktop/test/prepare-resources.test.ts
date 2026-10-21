import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain ES module script, no types
import { prepareResources } from '../scripts/prepare-resources.mjs';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A repo tree with the built web UI, the MCP server and the composition runtime; `whisper` adds vendor/whisper/<arch>. */
function tree(whisper: string[] = []): { root: string; desktop: string } {
  const root = mkdtempSync(join(tmpdir(), 'ms-prepare-'));
  dirs.push(root);
  const w = (p: string, text = 'x') => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), text); };
  w('packages/web/dist/index.html', '<html>');
  w('packages/mcp-studio/src/server.mjs', '// mcp');
  for (const f of ['index.html', 'runtime.js', 'layer.js', 'clock.js', 'preview.js']) w(`packages/composition-runtime/dist/${f}`);
  for (const a of whisper) {
    w(`apps/desktop/vendor/whisper/${a}/whisper-cli`, `cli-${a}`);
    w(`apps/desktop/vendor/whisper/${a}/ggml-silero-v6.2.0.bin`);
    w(`apps/desktop/vendor/whisper/${a}/LICENSE`, 'MIT');
  }
  w('apps/desktop/resources/stale.txt', 'old');
  return { root, desktop: join(root, 'apps/desktop') };
}

describe('prepare-resources (Task 23)', () => {
  it('copies the web UI, the MCP server and the runtime, and clears what was there', () => {
    const { desktop } = tree();
    prepareResources({ desktopDir: desktop });
    const r = join(desktop, 'resources');
    expect(readFileSync(join(r, 'web/index.html'), 'utf8')).toBe('<html>');
    expect(readFileSync(join(r, 'mcp-studio.mjs'), 'utf8')).toBe('// mcp');
    expect(existsSync(join(r, 'runtime/preview.js'))).toBe(true);
    expect(existsSync(join(r, 'stale.txt'))).toBe(false);
  });

  it('copies vendor/whisper/<arch> to resources/whisper/<arch> when present', () => {
    const { desktop } = tree(['arm64', 'x64']);
    prepareResources({ desktopDir: desktop });
    const w = join(desktop, 'resources/whisper');
    expect(readdirSync(w).sort()).toEqual(['arm64', 'x64']);
    expect(readFileSync(join(w, 'arm64/whisper-cli'), 'utf8')).toBe('cli-arm64');
    expect(readdirSync(join(w, 'x64')).sort()).toEqual(['LICENSE', 'ggml-silero-v6.2.0.bin', 'whisper-cli']);
  });

  it('succeeds without a built Whisper: no whisper folder (the app falls back to an installed Whisper)', () => {
    const { desktop } = tree();
    prepareResources({ desktopDir: desktop });
    expect(existsSync(join(desktop, 'resources/whisper'))).toBe(false);
  });

  it('a missing composition runtime file fails as before', () => {
    const { root, desktop } = tree();
    rmSync(join(root, 'packages/composition-runtime/dist/clock.js'));
    expect(() => prepareResources({ desktopDir: desktop })).toThrow(/composition runtime not built: clock\.js/);
  });
});
