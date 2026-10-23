// Fernwise: hand-drawn SVG assets (savings chart, phone with the app, logo, coins).
export const F = { bg: '#F3EFE6', ink: '#0E2A1F', green: '#17784A', mint: '#A7E8C3', coral: '#FF6A4D', card: '#FFFFFF', line: '#E4DDCF', muted: '#6E7B72', track: '#EFEAE0', sand: '#D9CFBD' };

export const SAVINGS = [0, 620, 1350, 1900, 2950, 3600, 4800, 5400, 6900, 8100, 9600, 10900, 12480];

/** Points of the savings curve inside a w x h box (padding inside). */
export function chartPoints(w, h, pad = { l: 0, r: 0, t: 0, b: 0 }) {
  const max = 13000;
  return SAVINGS.map((v, i) => [pad.l + (i / (SAVINGS.length - 1)) * (w - pad.l - pad.r), pad.t + (1 - v / max) * (h - pad.t - pad.b)]);
}
function smooth(pts) {
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]; const p1 = pts[i]; const p2 = pts[i + 1]; const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1.map((v) => v.toFixed(1)).join(' ')} ${c2.map((v) => v.toFixed(1)).join(' ')} ${p2.map((v) => v.toFixed(1)).join(' ')}`;
  }
  return d;
}
export function chart(w, h) {
  const pts = chartPoints(w, h, { l: 0, r: 0, t: 16, b: 4 });
  const line = smooth(pts);
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  const months = pts.slice(1).map(([x]) => `<line x1="${x.toFixed(1)}" y1="${h - 4}" x2="${x.toFixed(1)}" y2="${h}" stroke="${F.sand}" stroke-width="2"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${F.green}" stop-opacity=".32"/><stop offset="1" stop-color="${F.green}" stop-opacity="0"/></linearGradient></defs>
<path d="${area}" fill="url(#a)"/>
<path d="${line}" fill="none" stroke="${F.green}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
${months}
</svg>`;
}
export function gridLines(w, h) {
  const rows = [0, 1, 2, 3].map((i) => { const y = 16 + (i / 3) * (h - 20); return `<line x1="0" y1="${y.toFixed(1)}" x2="${w}" y2="${y.toFixed(1)}" stroke="${F.line}" stroke-width="2" stroke-dasharray="${i === 3 ? '0' : '6 8'}"/>`; });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${rows.join('')}</svg>`;
}

export const logo = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
<rect width="200" height="200" rx="56" fill="${F.green}"/>
<path d="M100 166 C100 120 98 84 88 44" fill="none" stroke="${F.bg}" stroke-width="9" stroke-linecap="round"/>
<g fill="${F.mint}">
<path d="M97 132 C76 132 58 122 50 104 C70 100 88 108 97 132Z"/>
<path d="M99 118 C118 116 136 104 142 86 C122 84 104 94 99 118Z"/>
<path d="M95 100 C78 98 64 86 60 70 C78 70 92 80 95 100Z"/>
<path d="M96 86 C112 82 124 70 126 54 C110 56 98 66 96 86Z"/>
<path d="M91 64 C80 60 72 50 72 38 C84 40 92 50 91 64Z"/>
</g>
</svg>`;

export const phone = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 820">
<defs>
<linearGradient id="frame" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2B3A33"/><stop offset=".5" stop-color="#0E1A15"/><stop offset="1" stop-color="#26332D"/></linearGradient>
<linearGradient id="card" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1E8A56"/><stop offset="1" stop-color="#0F5E39"/></linearGradient>
<linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${F.mint}" stop-opacity=".55"/><stop offset="1" stop-color="${F.mint}" stop-opacity="0"/></linearGradient>
<clipPath id="screen"><rect x="16" y="16" width="368" height="788" rx="50"/></clipPath>
</defs>
<rect x="0" y="0" width="400" height="820" rx="64" fill="url(#frame)"/>
<rect x="5" y="5" width="390" height="810" rx="60" fill="none" stroke="#FFFFFF" stroke-opacity=".12" stroke-width="2"/>
<g clip-path="url(#screen)">
  <rect x="16" y="16" width="368" height="788" fill="${F.bg}"/>
  <rect x="150" y="30" width="100" height="28" rx="14" fill="#0B1611"/>
  <circle cx="58" cy="100" r="20" fill="${F.sand}"/>
  <rect x="88" y="90" width="110" height="10" rx="5" fill="${F.ink}" fill-opacity=".8"/>
  <rect x="88" y="106" width="70" height="8" rx="4" fill="${F.muted}" fill-opacity=".5"/>
  <circle cx="340" cy="100" r="16" fill="none" stroke="${F.ink}" stroke-opacity=".5" stroke-width="3"/>
  <rect x="36" y="146" width="328" height="196" rx="26" fill="url(#card)"/>
  <rect x="58" y="170" width="90" height="10" rx="5" fill="${F.mint}" fill-opacity=".8"/>
  <rect x="58" y="196" width="190" height="34" rx="10" fill="#FFFFFF"/>
  <path d="M58 312 C100 300 120 306 150 288 C182 270 200 284 232 262 C262 242 290 252 342 222 L342 330 L58 330Z" fill="url(#a)"/>
  <path d="M58 312 C100 300 120 306 150 288 C182 270 200 284 232 262 C262 242 290 252 342 222" fill="none" stroke="${F.mint}" stroke-width="5" stroke-linecap="round"/>
  <circle cx="342" cy="222" r="8" fill="#FFFFFF"/>
  <g>
    <rect x="36" y="366" width="100" height="88" rx="22" fill="#FFFFFF"/><circle cx="62" cy="394" r="12" fill="${F.mint}"/><rect x="52" y="420" width="64" height="8" rx="4" fill="${F.ink}" fill-opacity=".6"/>
    <rect x="150" y="366" width="100" height="88" rx="22" fill="#FFFFFF"/><circle cx="176" cy="394" r="12" fill="${F.coral}" fill-opacity=".85"/><rect x="166" y="420" width="64" height="8" rx="4" fill="${F.ink}" fill-opacity=".6"/>
    <rect x="264" y="366" width="100" height="88" rx="22" fill="#FFFFFF"/><circle cx="290" cy="394" r="12" fill="${F.sand}"/><rect x="280" y="420" width="64" height="8" rx="4" fill="${F.ink}" fill-opacity=".6"/>
  </g>
  <rect x="36" y="478" width="160" height="12" rx="6" fill="${F.ink}" fill-opacity=".8"/>
  ${[0, 1, 2, 3].map((i) => {
    const y = 512 + i * 70; const w = [210, 150, 240, 120][i]; const c = [F.green, F.coral, F.sand, F.mint][i];
    return `<rect x="36" y="${y}" width="328" height="56" rx="18" fill="#FFFFFF"/><circle cx="66" cy="${y + 28}" r="14" fill="${c}"/><rect x="92" y="${y + 16}" width="${w * 0.5}" height="9" rx="4.5" fill="${F.ink}" fill-opacity=".75"/><rect x="92" y="${y + 33}" width="${w * 0.35}" height="7" rx="3.5" fill="${F.muted}" fill-opacity=".45"/><rect x="${320 - 40}" y="${y + 22}" width="58" height="11" rx="5.5" fill="${i === 0 ? F.green : F.ink}" fill-opacity="${i === 0 ? 1 : 0.7}"/>`;
  }).join('')}
  <rect x="140" y="780" width="120" height="6" rx="3" fill="${F.ink}" fill-opacity=".8"/>
</g>
</svg>`;

export const coin = (c1, c2) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
<circle cx="100" cy="106" r="88" fill="${c2}"/>
<circle cx="100" cy="94" r="88" fill="${c1}"/>
<circle cx="100" cy="94" r="64" fill="none" stroke="${c2}" stroke-width="8" stroke-opacity=".5"/>
<path d="M78 112 C78 124 122 126 122 108 C122 88 78 100 78 80 C78 64 120 64 120 76 M100 56 V132" fill="none" stroke="${c2}" stroke-width="10" stroke-linecap="round"/>
</svg>`;
