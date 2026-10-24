// The home story's boards (story.mjs): hand-drawn SVG assets for the three launch-video directions and the brand.
import { readFileSync } from 'node:fs';

/** A line grid over the whole 16:9 frame (Signal). */
export const grid = (stroke) => {
  const lines = [];
  for (let x = 0; x <= 1920; x += 80) lines.push(`<path d="M${x} 0V1080"/>`);
  for (let y = 0; y <= 1080; y += 80) lines.push(`<path d="M0 ${y}H1920"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><g stroke="${stroke}" stroke-width="2" fill="none">${lines.join('')}</g></svg>`;
};

/** Concentric rings (Signal's broadcast). */
export const rings = (stroke) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"><g fill="none" stroke="${stroke}">
<circle cx="400" cy="400" r="390" stroke-width="3" stroke-opacity=".25"/>
<circle cx="400" cy="400" r="290" stroke-width="4" stroke-opacity=".45"/>
<circle cx="400" cy="400" r="190" stroke-width="5" stroke-opacity=".7"/>
<circle cx="400" cy="400" r="90" stroke-width="6"/>
</g><circle cx="400" cy="400" r="22" fill="${stroke}"/></svg>`;

/** A soft radial light (Night launch). */
export const glow = (color) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><defs><radialGradient id="g" cx=".5" cy=".5" r=".5">
<stop offset="0" stop-color="${color}" stop-opacity=".55"/><stop offset=".45" stop-color="${color}" stop-opacity=".18"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
</radialGradient></defs><rect width="1000" height="1000" fill="url(#g)"/></svg>`;

/** A field of small stars, placed by a fixed sequence so the file never changes. */
export const stars = (color) => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const dots = [];
  for (let i = 0; i < 90; i++) {
    const r = 1.2 + rnd() * 2.6;
    dots.push(`<circle cx="${Math.round(rnd() * 1920)}" cy="${Math.round(rnd() * 1080)}" r="${r.toFixed(1)}" fill-opacity="${(0.25 + rnd() * 0.6).toFixed(2)}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><g fill="${color}">${dots.join('')}</g></svg>`;
};

/** A printer's registration mark (Paper). */
export const register = (ink) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><g fill="none" stroke="${ink}" stroke-width="3">
<circle cx="60" cy="60" r="34"/><path d="M60 4V116M4 60H116"/></g><circle cx="60" cy="60" r="12" fill="${ink}"/></svg>`;

/** The site's dot grid (the brand's canvas). */
export const dots = (w, h, color) => {
  const step = 44;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><pattern id="d" width="${step}" height="${step}" patternUnits="userSpaceOnUse"><circle cx="${step / 2}" cy="${step / 2}" r="2.4" fill="${color}"/></pattern></defs><rect width="${w}" height="${h}" fill="url(#d)"/></svg>`;
};

// The logo's three frames (draft, composition, video), each alone in the logo's own box so they stack exactly.
const BOX = 'viewBox="-10 -10 360 320"';
export const frameDraft = `<svg xmlns="http://www.w3.org/2000/svg" ${BOX}><rect x="0" y="0" width="200" height="200" rx="44" fill="none" stroke="#6B6B6B" stroke-width="12" stroke-dasharray="26 22"/></svg>`;
export const frameComp = `<svg xmlns="http://www.w3.org/2000/svg" ${BOX}><rect x="70" y="50" width="200" height="200" rx="44" fill="none" stroke="#F5F1EC" stroke-width="14"/></svg>`;
export const frameVideo = `<svg xmlns="http://www.w3.org/2000/svg" ${BOX}><rect x="140" y="100" width="200" height="200" rx="44" fill="#FF5A1F"/><path d="M207.62 164Q207.62 154 216.31 158.94L279.88 195.06Q288.58 200 279.88 204.94L216.31 241.06Q207.62 246 207.62 236Z" fill="#FFFFFF"/></svg>`;

/** The horizontal logo for dark grounds, as the site ships it. */
export const logo = readFileSync(new URL('../../src/assets/logo-horizontal-light.svg', import.meta.url), 'utf8');
