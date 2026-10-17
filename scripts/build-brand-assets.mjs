#!/usr/bin/env node
// Regenerates every brand file from the one master, packages/web/src/assets/logo.svg (macOS only: sips and iconutil).
//
//   node scripts/build-brand-assets.mjs
//
// - packages/web/src/assets/logo-dark.svg and docs/assets/logo{,-dark}.svg: the logo for light and dark backgrounds.
// - apps/desktop/build: icon.icns (macOS rounded tile), icon-mac.png (the same tile, 1024, for the dev Dock icon),
//   icon.png (full square, Linux) and icon.ico (Windows).
// The web favicon set (packages/web/public) is the one supplied by the user and is not generated here.
// The mark is the first four elements of the logo (three squares and the play triangle), drawn as vector at every size.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => join(root, ...p);
const master = readFileSync(at('packages/web/src/assets/logo.svg'), 'utf8');

// Dark-theme logo: the dark ink turns near-white, the dashed square and the wordmark's orange are lightened for contrast.
const dark = master.replaceAll('#171717', '#F5F5F5').replaceAll('#6B6B6B', '#9C9C9C').replaceAll('#C2410C', '#FF8A5C');
writeFileSync(at('packages/web/src/assets/logo-dark.svg'), dark);
copyFileSync(at('packages/web/src/assets/logo.svg'), at('docs/assets/logo.svg'));
writeFileSync(at('docs/assets/logo-dark.svg'), dark);

// The mark: the elements before the wordmark, with the outlined square in light ink (it sits on #0f0f0f).
const elements = master.match(/<(rect|path)\b[^>]*\/>/g).slice(0, 4).join('').replaceAll('#171717', '#EDEDED');
// Bounding box of the mark in logo units (strokes included): x -6..340, y -6..300.
const MARK = { w: 346, cx: 167, cy: 147 };
const tile = (size, { rounded, fraction }) => {
  const box = rounded ? 824 : 1024;
  const s = (box * fraction) / MARK.w;
  const frame = rounded
    ? '<rect x="100" y="100" width="824" height="824" rx="185" fill="#0f0f0f"/>'
    : '<rect width="1024" height="1024" fill="#0f0f0f"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">${frame}<g transform="translate(512 512) scale(${s.toFixed(4)}) translate(${-MARK.cx} ${-MARK.cy})">${elements}</g></svg>`;
};
const MAC = { rounded: true, fraction: 0.62 };
const SQUARE = { rounded: false, fraction: 0.62 };

const tmp = mkdtempSync(join(tmpdir(), 'ms-brand-'));
const png = (name, size, opts) => {
  const svg = join(tmp, `${name}.svg`);
  const out = join(tmp, `${name}.png`);
  writeFileSync(svg, tile(size, opts));
  execFileSync('sips', ['-s', 'format', 'png', svg, '--out', out], { stdio: 'ignore' });
  return out;
};

try {
  const build = at('apps/desktop/build');
  mkdirSync(build, { recursive: true });

  // macOS: the iconset and the .icns.
  const set = join(tmp, 'icon.iconset');
  mkdirSync(set);
  for (const base of [16, 32, 128, 256, 512]) {
    for (const x2 of [1, 2]) {
      const px = base * x2;
      copyFileSync(png(`mac${px}`, px, MAC), join(set, `icon_${base}x${base}${x2 === 2 ? '@2x' : ''}.png`));
    }
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(build, 'icon.icns')]);
  copyFileSync(png('mac1024', 1024, MAC), join(build, 'icon-mac.png'));

  // Linux: the full square.
  copyFileSync(png('sq1024', 1024, SQUARE), join(build, 'icon.png'));

  // Windows: an .ico of PNG frames.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = sizes.map((px) => readFileSync(png(`sq${px}`, px, SQUARE)));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((px, i) => {
    const o = 6 + 16 * i;
    head[o] = px === 256 ? 0 : px;
    head[o + 1] = px === 256 ? 0 : px;
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(frames[i].length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += frames[i].length;
  });
  writeFileSync(join(build, 'icon.ico'), Buffer.concat([head, ...frames]));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
