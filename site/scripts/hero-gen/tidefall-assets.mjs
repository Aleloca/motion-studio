// TIDEFALL festival: hand-drawn SVG assets (sunburst, arches, waves, halftone, sticker).
export const P = { blue: '#2B1CFF', pink: '#FF3C7E', acid: '#D6FF3D', cream: '#FFF1DA', ink: '#0D0B26', orange: '#FF7A1A' };

export function sun() {
  const rays = [];
  const n = 28;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2; const a1 = a0 + Math.PI / n * 0.9; const am = (a0 + a1) / 2;
    const r0 = 330; const r1 = 490;
    const p = (r, a) => `${(500 + r * Math.cos(a)).toFixed(1)} ${(500 + r * Math.sin(a)).toFixed(1)}`;
    rays.push(`M${p(r0, a0)}L${p(r1, am)}L${p(r0, a1)}Z`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path d="${rays.join('')}" fill="${P.acid}"/><circle cx="500" cy="500" r="318" fill="${P.acid}"/><circle cx="500" cy="500" r="250" fill="none" stroke="${P.blue}" stroke-width="10" stroke-dasharray="4 22"/></svg>`;
}

export function arches() {
  const cols = [P.pink, P.orange, P.acid, P.cream, P.blue];
  const out = [];
  cols.forEach((c, i) => {
    const r = 500 - i * 92;
    out.push(`<path d="M${500 - r} 520 A${r} ${r} 0 0 1 ${500 + r} 520 V1000 H${500 - r} Z" fill="${c}"/>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">${out.join('')}</svg>`;
}

export function waves() {
  const rows = [];
  const colors = [P.pink, P.cream, P.acid];
  for (let r = 0; r < 3; r++) {
    let d = `M0 ${60 + r * 70}`;
    for (let x = 0; x <= 3840; x += 120) d += ` q30 ${r % 2 ? 34 : -34} 60 0 t60 0`;
    rows.push(`<path d="${d}" fill="none" stroke="${colors[r]}" stroke-width="22" stroke-linecap="round"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3840 240">${rows.join('')}</svg>`;
}

export function halftone(color = P.ink) {
  const dots = [];
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const r = Math.max(0, 9 * (1 - (x + y) / 30));
    if (r > 0.6) dots.push(`<circle cx="${x * 24 + 12}" cy="${y * 24 + 12}" r="${r.toFixed(2)}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480"><g fill="${color}">${dots.join('')}</g></svg>`;
}

export function sticker() {
  const n = 22; const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2; const r = i % 2 ? 440 : 492;
    pts.push(`${(500 + r * Math.cos(a)).toFixed(1)},${(500 + r * Math.sin(a)).toFixed(1)}`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><polygon points="${pts.join(' ')}" fill="${P.pink}" stroke="${P.pink}" stroke-width="24" stroke-linejoin="round"/><circle cx="500" cy="500" r="380" fill="none" stroke="${P.cream}" stroke-width="8" stroke-dasharray="2 18" stroke-linecap="round"/></svg>`;
}

export function blob(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path d="M500 40C760 40 960 230 960 480C960 760 740 960 480 960C230 960 40 770 40 520C40 250 240 40 500 40Z" fill="${color}"/></svg>`;
}
