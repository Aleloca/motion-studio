// KOVA Air: hand-drawn SVG assets (earbuds, case, glow, rings, waveform, dot grid).
const CY = '#7CF5FF';

export const buds = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 640">
<defs>
<linearGradient id="shell" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5B6374"/><stop offset=".38" stop-color="#232833"/><stop offset=".75" stop-color="#0D0F14"/><stop offset="1" stop-color="#040507"/></linearGradient>
<linearGradient id="stem" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#07080B"/><stop offset=".3" stop-color="#3A4150"/><stop offset=".55" stop-color="#1A1E27"/><stop offset="1" stop-color="#040507"/></linearGradient>
<linearGradient id="chrome" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4B5563"/><stop offset=".28" stop-color="#F8FAFC"/><stop offset=".5" stop-color="#A3ACB9"/><stop offset=".8" stop-color="#E5E7EB"/><stop offset="1" stop-color="#374151"/></linearGradient>
<radialGradient id="tip" cx=".42" cy=".38" r=".7"><stop offset="0" stop-color="#454C5B"/><stop offset=".7" stop-color="#191C24"/><stop offset="1" stop-color="#0B0D12"/></radialGradient>
<radialGradient id="sheen" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".5"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
<linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${CY}" stop-opacity=".9"/><stop offset=".5" stop-color="${CY}" stop-opacity=".1"/><stop offset="1" stop-color="${CY}" stop-opacity=".6"/></linearGradient>
<pattern id="mesh" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="3.5" cy="3.5" r="1.5" fill="${CY}" fill-opacity=".45"/></pattern>
<g id="bud">
  <g transform="translate(150 118) rotate(-14)">
    <rect x="-35" y="0" width="70" height="262" rx="35" fill="url(#stem)"/>
    <rect x="-35" y="206" width="70" height="56" rx="35" fill="url(#chrome)"/>
    <rect x="-35" y="204" width="70" height="5" fill="${CY}"/>
    <rect x="-7" y="56" width="14" height="50" rx="7" fill="#020305"/>
    <rect x="-4" y="226" width="8" height="18" rx="4" fill="#1F2937" fill-opacity=".7"/>
    <rect x="-22" y="12" width="8" height="180" rx="4" fill="#FFFFFF" fill-opacity=".08"/>
  </g>
  <ellipse cx="122" cy="80" rx="138" ry="114" transform="rotate(-18 122 80)" fill="url(#shell)"/>
  <ellipse cx="122" cy="80" rx="136" ry="112" transform="rotate(-18 122 80)" fill="none" stroke="url(#rim)" stroke-width="2.5"/>
  <ellipse cx="150" cy="96" rx="80" ry="66" transform="rotate(-18 150 96)" fill="#0A0C11" fill-opacity=".55"/>
  <ellipse cx="150" cy="96" rx="80" ry="66" transform="rotate(-18 150 96)" fill="none" stroke="${CY}" stroke-opacity=".55" stroke-width="2"/>
  <circle cx="176" cy="104" r="5" fill="${CY}"/>
  <ellipse cx="78" cy="22" rx="70" ry="26" transform="rotate(-28 78 22)" fill="url(#sheen)"/>
  <ellipse cx="8" cy="40" rx="64" ry="74" transform="rotate(-30 8 40)" fill="url(#tip)"/>
  <ellipse cx="-4" cy="34" rx="32" ry="38" transform="rotate(-30 -4 34)" fill="#05060A"/>
  <ellipse cx="-4" cy="34" rx="28" ry="34" transform="rotate(-30 -4 34)" fill="url(#mesh)"/>
  <ellipse cx="-14" cy="14" rx="24" ry="10" transform="rotate(-30 -14 14)" fill="url(#sheen)" opacity=".6"/>
</g>
</defs>
<use href="#bud" transform="translate(665 200) rotate(16) scale(-.86 .86)"/>
<use href="#bud" transform="translate(140 180) rotate(-12)"/>
</svg>`;

export const kase = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 460">
<defs>
<linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3B4250"/><stop offset=".45" stop-color="#1A1E27"/><stop offset="1" stop-color="#07080B"/></linearGradient>
<linearGradient id="lid" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6B7385"/><stop offset=".4" stop-color="#2A303C"/><stop offset="1" stop-color="#11141A"/></linearGradient>
<linearGradient id="edge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7CF5FF" stop-opacity="0"/><stop offset=".5" stop-color="#7CF5FF" stop-opacity=".9"/><stop offset="1" stop-color="#7CF5FF" stop-opacity="0"/></linearGradient>
<radialGradient id="led" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#E9FEFF"/><stop offset=".35" stop-color="#7CF5FF"/><stop offset="1" stop-color="#7CF5FF" stop-opacity="0"/></radialGradient>
<radialGradient id="shine" cx=".3" cy=".2" r=".6"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".35"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
<clipPath id="shape"><rect x="40" y="40" width="520" height="380" rx="150"/></clipPath>
</defs>
<ellipse cx="300" cy="436" rx="230" ry="16" fill="#000" fill-opacity=".6"/>
<g clip-path="url(#shape)">
  <rect x="40" y="40" width="520" height="380" fill="url(#body)"/>
  <rect x="40" y="40" width="520" height="150" fill="url(#lid)"/>
  <rect x="40" y="40" width="520" height="380" fill="url(#shine)"/>
  <rect x="40" y="188" width="520" height="4" fill="#030406"/>
  <rect x="40" y="192" width="520" height="2" fill="#FFFFFF" fill-opacity=".12"/>
  <rect x="40" y="40" width="520" height="3" fill="url(#edge)"/>
</g>
<rect x="41" y="41" width="518" height="378" rx="149" fill="none" stroke="#FFFFFF" stroke-opacity=".1" stroke-width="2"/>
<circle cx="300" cy="300" r="34" fill="none" stroke="#FFFFFF" stroke-opacity=".18" stroke-width="3"/>
<path d="M270 300 q7.5 -16 15 0 t15 0 t15 0 t15 0" fill="none" stroke="#FFFFFF" stroke-opacity=".28" stroke-width="3" stroke-linecap="round"/>
<circle cx="300" cy="382" r="16" fill="url(#led)"/>
<circle cx="300" cy="382" r="4" fill="#E9FEFF"/>
</svg>`;

export const glow = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
<defs><radialGradient id="g" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#38E1FF" stop-opacity=".55"/><stop offset=".35" stop-color="#2C5BFF" stop-opacity=".22"/><stop offset=".7" stop-color="#4B1FFF" stop-opacity=".07"/><stop offset="1" stop-color="#4B1FFF" stop-opacity="0"/></radialGradient></defs>
<rect width="1000" height="1000" fill="url(#g)"/>
</svg>`;

export const ring = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
<defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${CY}"/><stop offset=".5" stop-color="${CY}" stop-opacity=".05"/><stop offset="1" stop-color="${CY}" stop-opacity=".8"/></linearGradient></defs>
<circle cx="500" cy="500" r="490" fill="none" stroke="url(#s)" stroke-width="4"/>
</svg>`;

// A seeded waveform: loud, ragged bars.
function rand(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
export function noise() {
  const rnd = rand(7);
  const bars = [];
  const n = 96;
  for (let i = 0; i < n; i++) {
    const env = 0.35 + 0.65 * Math.abs(Math.sin(i / 7.3) * Math.cos(i / 17));
    const h = Math.max(6, Math.round(180 * env * (0.35 + 0.65 * rnd())));
    bars.push(`<rect x="${i * 20 + 4}" y="${200 - h}" width="12" height="${h * 2}" rx="6"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 400"><g fill="#EEF2F7">${bars.join('')}</g></svg>`;
}

export const grid = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1920">
<defs><pattern id="p" width="48" height="48" patternUnits="userSpaceOnUse"><circle cx="24" cy="24" r="1.6" fill="#8A93A6"/></pattern>
<radialGradient id="fade" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<mask id="m"><rect width="1920" height="1920" fill="url(#fade)"/></mask></defs>
<rect width="1920" height="1920" fill="url(#p)" mask="url(#m)"/>
</svg>`;
