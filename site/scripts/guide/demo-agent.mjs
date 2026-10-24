#!/usr/bin/env node
// The guide's demo agent: stands in for the `claude` CLI so the screenshots show a real Motion Studio at work without
// Claude Code, a model or any paid service. It speaks the same stream-json as the test double
// (packages/core/test/fixtures/fake-claude.mjs) and answers each kind of job with fixed, plausible work. Its brand follows
// the project folder it runs in (kova, tidefall or fernwise: the site's three hero creatives):
// - a creative turn writes one composition per format: the site's hero of that brand where the size matches, a brand card
//   elsewhere, the brand's mark for identity formats; each later version changes the closing line, each variant of a group
//   gets its own palette (hue-rotated), and Fernwise videos get a spoken voice-over (macOS `say`, else a tone);
// - a brand analysis proposes the brand's kit; an asset description writes short descriptions; a video analysis writes its
//   timeline from the frames it is given; a brief session fills the New creative form; all through the studio bridge, as the
//   MCP server would.
// GUIDE_COMPOSITIONS / GUIDE_FONTS: the site's compositions and fonts. While the file GUIDE_HOLD says `hold`, a creative turn
// waits after its first step; when GUIDE_APPROVE says `ask`, it first asks the user's permission for a web page (an approval
// card) and writes `asked` there. Nothing is ever deleted.
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.301 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, subscriptionType: 'max' })); process.exit(0); }

const { GUIDE_COMPOSITIONS: COMPS, GUIDE_FONTS: FONTS, GUIDE_HOLD: HOLD, GUIDE_APPROVE: APPROVE } = process.env;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resumeAt = args.indexOf('--resume');
const sessionId = resumeAt >= 0 ? `${args[resumeAt + 1]}${args.includes('--fork-session') ? '-fork' : ''}` : `demo-${process.pid}`;
const mcpAt = args.indexOf('--mcp-config');
const bridgeEnv = (() => { try { return JSON.parse(readFileSync(args[mcpAt + 1], 'utf8')).mcpServers.studio.env; } catch { return null; } })();

const BRANDS = {
  kova: {
    // The end card is held 4 s longer (16 s in all), so the middle of the film, where the app takes a board's poster frame,
    // lands on the finished specs instead of a counter mid-count.
    hold: 4,
    name: 'KOVA', site: 'https://kova-labs.example', bg: '#06070B', fg: '#EEF2F7', accent: '#7CF5FF', label: 'KOVA LABS',
    headline: 'Silence, engineered.', closing: /^tag-/, lines: ['Hear only what matters.', 'Only what matters. Nothing else.', 'Quiet is the new loud.', 'Made for the quiet hours.'],
    colors: [['signal', 'Signal cyan', '#7CF5FF', 'primary'], ['void', 'Void', '#06070B', 'background'], ['ice', 'Ice', '#EEF2F7', 'text'], ['graphite', 'Graphite', '#232A36', 'secondary'], ['slate', 'Slate', '#8A93A6', 'other']],
    tone: 'Quiet, precise and confident. Few words, exact numbers.', dos: 'Lead with one measured number.', donts: 'No lifestyle clichés, no shouting.',
    mark: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>KOVA mark</title><rect width="512" height="512" rx="120" fill="#06070B"/><circle id="ring" cx="256" cy="256" r="150" fill="none" stroke="#7CF5FF" stroke-width="28"/><path id="k" d="M206 160v192M206 262l92-102M234 232l70 120" fill="none" stroke="#EEF2F7" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  tidefall: {
    name: 'TIDEFALL', site: 'https://tidefall-festival.example', bg: '#0D0B26', fg: '#FFF1DA', accent: '#FF3C7E', label: 'TIDEFALL  VOL. 04',
    headline: 'Three nights by the sea.', closing: /^cta-label-/, lines: ['Tickets Friday, 10:00  →', 'Last tickets on sale now  →', 'See you on the shore  →', 'Doors open at sunset  →'],
    colors: [['pink', 'Tide pink', '#FF3C7E', 'primary'], ['night', 'Night', '#0D0B26', 'background'], ['sand', 'Sand', '#FFF1DA', 'text'], ['lime', 'Lime', '#D6FF3D', 'accent'], ['electric', 'Electric', '#2B1CFF', 'secondary']],
    tone: 'Loud, warm and playful.', dos: 'Big type, bold colour blocks.', donts: 'No grey, no stock crowds.',
    mark: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>TIDEFALL mark</title><rect width="512" height="512" rx="120" fill="#0D0B26"/><circle cx="256" cy="220" r="110" fill="#FF3C7E"/><path d="M96 330q40-36 80 0t80 0 80 0 80 0M96 390q40-36 80 0t80 0 80 0 80 0" fill="none" stroke="#FFF1DA" stroke-width="22" stroke-linecap="round"/></svg>',
  },
  fernwise: {
    name: 'Fernwise', site: 'https://fernwise.example', bg: '#0E2A1F', fg: '#FFFFFF', accent: '#A7E8C3', label: 'FERNWISE',
    headline: 'Where did 2026 go?', closing: /^tag-/, lines: ['Watch your money grow.', 'See where it all went.', 'Grow it, one month at a time.', 'Your year, in one minute.'],
    colors: [['forest', 'Forest', '#0E2A1F', 'background'], ['fern', 'Fern', '#17784A', 'primary'], ['mint', 'Mint', '#A7E8C3', 'accent'], ['paper', 'Paper', '#D9CFBD', 'secondary'], ['white', 'White', '#FFFFFF', 'text']],
    tone: 'Calm, clear and encouraging. Numbers first, no jargon.', dos: 'Show the real number.', donts: 'No piles of cash, no hype.',
    mark: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>Fernwise mark</title><rect width="512" height="512" rx="120" fill="#0E2A1F"/><path d="M256 400V150M256 300q-90-20-110-110 90 10 110 110zM256 240q90-20 110-110-90 10-110 110z" fill="#A7E8C3" stroke="#A7E8C3" stroke-width="14" stroke-linejoin="round"/></svg>',
  },
};
const brandKey = Object.keys(BRANDS).find((k) => basename(process.cwd()).startsWith(k)) ?? 'kova';
const B = BRANDS[brandKey];
const SCRIPT = 'Where did twenty twenty-six go? Fernwise shows you, in one minute. What you spent, what you saved, and what comes next. Start free for thirty days.';

const fontFiles = () => readdirSync(FONTS).filter((n) => n.endsWith('.woff2'));
const FONT_LIST = [
  { family: 'Bricolage Grotesque', src: 'assets/fonts/BricolageGrotesque.woff2', weight: 800 },
  { family: 'Instrument Sans', src: 'assets/fonts/InstrumentSans.woff2', weight: 400 },
  { family: 'JetBrains Mono', src: 'assets/fonts/JetBrainsMono.woff2', weight: 400 },
];

/** Hue rotation of every #rrggbb in a text (a variant's own palette). */
function rotateHues(text, deg) {
  if (!deg) return text;
  return text.replace(/#[0-9A-Fa-f]{6}\b/g, (hex) => {
    let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    let h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    }
    h = ((h * 60 + deg) % 360 + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return `#${[r1, g1, b1].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  });
}
const HUES = { a: 0, b: 150, c: 230, d: 300, e: 60 };

/** The site's hero of this brand at the same size (with its assets), or null. */
function hero(f) {
  if (f.kind !== 'video') return null;
  const id = { '1080x1920': '9x16', '1080x1080': '1x1', '1920x1080': '16x9', '1080x1350': '4x5' }[`${f.width}x${f.height}`];
  const dir = id && join(COMPS, `${brandKey}-${id}`);
  return dir && existsSync(join(dir, 'composition.json')) ? dir : null;
}

/** A brand card for any other size: the mark, the name and a line. */
function card(f, line, identity) {
  const still = f.kind === 'image';
  const duration = still ? 0 : Math.min(12, f.maxDurationSec ?? 12);
  if (identity) {
    return { $schema: 'motion-studio/composition@1', width: f.width, height: f.height, fps: 30, duration: 0, background: B.bg, fonts: [], scenes: [],
      tracks: [{ id: 'vector', name: 'Mark', kind: 'visual', clips: [{ id: 'mark', name: `${B.name} mark`, type: 'svg', src: 'assets/logo.svg', start: 0, duration: 0, props: { fit: 'contain' } }] }] };
  }
  const s = Math.min(f.width, f.height);
  const wide = f.width / f.height > 2;
  const markSize = Math.round(s * (wide ? 0.6 : 0.32));
  const anim = (preset) => (still ? [] : [{ preset, start: 0, duration: 0.6 }]);
  const x = Math.round(wide ? f.width * 0.08 + markSize * 1.3 : f.width * 0.08);
  return {
    $schema: 'motion-studio/composition@1', width: f.width, height: f.height, fps: 30, duration, background: B.bg, fonts: FONT_LIST,
    scenes: still ? [] : [{ id: 'main', name: 'Brand card', start: 0, duration }],
    tracks: [
      { id: 'visual', name: 'Mark', kind: 'visual', clips: [{ id: 'mark', name: `${B.name} mark`, type: 'svg', src: 'assets/logo.svg', start: 0, duration, props: { x: Math.round(f.width * 0.08), y: Math.round(wide ? (f.height - markSize) / 2 : f.height * 0.12), width: markSize, height: markSize }, animations: anim('popIn') }] },
      { id: 'text', name: 'Texts', kind: 'text', clips: [
        { id: 'headline', name: 'Headline', type: 'text', start: 0, duration, props: { text: B.headline, fontFamily: 'Bricolage Grotesque', fontWeight: 800, color: B.fg, fontSize: Math.round(s * (wide ? 0.18 : 0.09)), x, y: Math.round(wide ? f.height * 0.3 : f.height * 0.55), width: Math.round(wide ? f.width * 0.6 : f.width * 0.84), height: Math.round(s * (wide ? 0.4 : 0.25)) }, animations: anim('fadeIn') },
        { id: 'line', name: 'Closing line', type: 'text', start: 0, duration, props: { text: line, fontFamily: 'Instrument Sans', fontWeight: 400, color: B.accent, fontSize: Math.max(12, Math.round(s * (wide ? 0.08 : 0.04))), x, y: Math.round(wide ? f.height * 0.75 : f.height * 0.82), width: Math.round(f.width * 0.84), height: Math.round(s * (wide ? 0.12 : 0.06)) }, animations: anim('fadeIn') },
        { id: 'label', name: 'Brand label', type: 'text', start: 0, duration, props: { text: B.label, fontFamily: 'JetBrains Mono', fontWeight: 400, color: B.accent, fontSize: Math.max(12, Math.round(s * (wide ? 0.08 : 0.035))), x, y: Math.round(wide ? f.height * 0.12 : f.height * 0.48), width: Math.round(f.width * 0.6), height: Math.round(s * (wide ? 0.12 : 0.05)) }, animations: anim('fadeIn') },
      ] },
    ],
  };
}

/** A spoken voice-over (macOS `say`, else a soft tone) into `file`; its length in seconds. */
function voice(file) {
  // The raw speech goes to the demo's home (left there: the demo folder is the user's to remove).
  const tmp = join(process.env.HOME ?? dirname(file), `voice-${process.pid}.aiff`);
  const said = spawnSync('say', ['-v', 'Samantha', '-r', '175', '-o', tmp, SCRIPT]).status === 0 || spawnSync('say', ['-o', tmp, SCRIPT]).status === 0;
  const input = said ? ['-i', tmp] : ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=9'];
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-ac', '1', '-ar', '44100', '-b:a', '128k', file]);
  const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Math.round(Number(p.stdout.trim() || 9) * 10) / 10;
}

function writeCompositions(block) {
  const n = Number(/v(\d+)$/.exec(block.outputDir.replace(/\/+$/, ''))?.[1] ?? 1);
  const variant = /~([b-e])(?:\/|$)/.exec(block.outputDir)?.[1] ?? 'a';
  const line = B.lines[(n - 1) % B.lines.length];
  mkdirSync(block.workDir, { recursive: true });
  writeFileSync(join(block.workDir, 'plan.md'), `# ${B.name}, v${n}\n`);
  for (const f of block.formats) {
    const dir = f.compositionDir ?? join(block.outputDir, 'compositions', f.id);
    mkdirSync(join(dir, 'assets', 'fonts'), { recursive: true });
    for (const font of fontFiles()) copyFileSync(join(FONTS, font), join(dir, 'assets', 'fonts', font));
    const identity = /^identity-/.test(f.id);
    const src = identity ? null : hero(f);
    let c;
    if (src) {
      c = JSON.parse(readFileSync(join(src, 'composition.json'), 'utf8'));
      if (B.hold) {
        const end = c.duration;
        for (const t of c.tracks) for (const clip of t.clips) if (clip.start + clip.duration >= end - 0.01) clip.duration = Math.round((clip.duration + B.hold) * 1000) / 1000;
        const last = c.scenes.at(-1);
        if (last) last.duration = Math.round((last.duration + B.hold) * 1000) / 1000;
        c.duration = end + B.hold;
      }
      for (const a of readdirSync(join(src, 'assets'), { withFileTypes: true })) {
        if (a.isFile()) writeFileSync(join(dir, 'assets', a.name), rotateHues(readFileSync(join(src, 'assets', a.name), 'utf8'), HUES[variant]));
      }
      for (const t of c.tracks) for (const clip of t.clips) if (clip.type === 'text' && B.closing.test(clip.id) && n > 1) clip.props.text = line;
      // Readable names in the editor: a text by its words, anything else by its id ("case-58" → "Case").
      for (const t of c.tracks) for (const clip of t.clips) {
        clip.name ??= clip.type === 'text' ? clip.props.text.replace(/\s+/g, ' ').trim().slice(0, 40) : clip.id.replace(/-\d+$/, '').replace(/-/g, ' ').replace(/^./, (x) => x.toUpperCase());
      }
      if (brandKey === 'fernwise' && block.formats.indexOf(f) === 0) {
        const len = voice(join(dir, 'assets', 'voice-over.mp3'));
        c.tracks.push({ id: 'voice', name: 'Voice-over', kind: 'audio', clips: [{ id: 'vo', name: 'Voice-over', type: 'audio', src: 'assets/voice-over.mp3', start: 0.5, duration: Math.min(len, c.duration - 0.5), role: 'voice', script: SCRIPT }] });
      }
    } else {
      c = card(f, line, identity);
    }
    writeFileSync(join(dir, 'assets', 'logo.svg'), identity ? B.mark : rotateHues(B.mark, HUES[variant]));
    writeFileSync(join(dir, 'composition.json'), `${rotateHues(JSON.stringify(c, null, 2), identity ? 0 : HUES[variant])}\n`);
  }
  return { n, variant };
}

function brandAnalysis(b) {
  const kit = JSON.parse(readFileSync(b.kitFile, 'utf8'));
  const url = b.sources.find((s) => s.kind === 'website')?.url ?? B.site;
  const src = { kind: 'website', ref: url };
  const add = (list, item) => { if (!list.some((x) => x.id === item.id)) list.push(item); };
  for (const [id, name, hex, role] of B.colors) add(kit.colors, { id, name, hex, role, source: src });
  mkdirSync('assets/fonts', { recursive: true });
  for (const f of ['BricolageGrotesque.woff2', 'InstrumentSans.woff2', 'JetBrainsMono.woff2']) copyFileSync(join(FONTS, f), join('assets/fonts', f));
  add(kit.fonts, { id: 'bricolage', family: 'Bricolage Grotesque', role: 'heading', weights: [800], file: 'assets/fonts/BricolageGrotesque.woff2', source: src });
  add(kit.fonts, { id: 'instrument', family: 'Instrument Sans', role: 'body', weights: [400, 500], file: 'assets/fonts/InstrumentSans.woff2', source: src });
  add(kit.fonts, { id: 'jetbrains', family: 'JetBrains Mono', role: 'accent', weights: [400], file: 'assets/fonts/JetBrainsMono.woff2', source: src });
  mkdirSync('assets/brand', { recursive: true });
  writeFileSync(`assets/brand/${brandKey}-mark.svg`, B.mark);
  add(kit.logos, { id: `${brandKey}-mark`, file: `assets/brand/${brandKey}-mark.svg`, variant: 'icon', background: 'any', source: src });
  kit.tone = { id: 'tone', text: B.tone, source: src };
  add(kit.dos, { id: 'do-1', text: B.dos, source: src });
  add(kit.donts, { id: 'dont-1', text: B.donts, source: src });
  writeFileSync(b.kitFile, JSON.stringify(kit));
  writeFileSync(b.guidelinesFile, `# ${B.name}\n\n${B.tone}\n`);
  writeFileSync(b.assetsListFile, JSON.stringify([
    { file: `brand/${brandKey}-mark.svg`, sourceUrl: `${url}/mark.svg`, description: `The ${B.name} mark`, tags: ['logo'] },
    { file: 'fonts/BricolageGrotesque.woff2', sourceUrl: `${url}/fonts/display.woff2`, description: 'Headline font', tags: ['font'] },
    { file: 'fonts/InstrumentSans.woff2', sourceUrl: `${url}/fonts/text.woff2`, description: 'Text font', tags: ['font'] },
    { file: 'fonts/JetBrainsMono.woff2', sourceUrl: `${url}/fonts/mono.woff2`, description: 'Labels and numbers', tags: ['font'] },
  ]));
  writeFileSync(b.summaryFile, `${B.colors[0][1]} (${B.colors[0][2]}) on ${B.colors.find((c) => c[3] === 'background')[1].toLowerCase()}. Bricolage Grotesque for headlines, Instrument Sans for text, JetBrains Mono for labels. ${B.tone}`);
}

async function bridge(tool, payload) {
  if (!bridgeEnv) return null;
  const token = readFileSync(bridgeEnv.MOTION_STUDIO_BRIDGE_TOKEN_FILE, 'utf8').trim();
  const res = await fetch(`${bridgeEnv.MOTION_STUDIO_BRIDGE_URL}/api/bridge/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-motion-studio-bridge': token }, body: JSON.stringify(payload) });
  return res.json().catch(() => null);
}

/** A video analysis: one timeline item per frame it was given, written once with `write_video_analysis`. */
async function videoAnalysis(prompt) {
  const frames = [...prompt.matchAll(/^- \d\d:\d\d(?::\d\d)? \(([\d.]+) s\): (\S+\.jpg)$/gm)].map((m) => ({ at: Number(m[1]), name: basename(m[2]) }));
  const end = Number(/to [\d:]+ \(([\d.]+) s to ([\d.]+) s\)/.exec(prompt)?.[2] ?? /Duration: [\d:]+ \(([\d.]+) s\)/.exec(prompt)?.[1] ?? (frames.at(-1)?.at ?? 0) + 0.4);
  const shots = ['The year\'s savings, $12,480, beside the savings curve', 'Where the money went: spending by category on a square card', 'The app\'s year summary, the total in large type', 'End card: the Fernwise logo and the free trial'];
  const timeline = frames.map((f, i) => ({ from: f.at, to: Math.max(f.at + 0.1, frames[i + 1]?.at ?? end), onScreen: shots[i % shots.length], onScreenText: i === 0 ? ['$12,480', 'Savings, month by month'] : ['SPENDING', 'Where it went.'], frame: f.name }));
  const write = /part \d+ of \d+/.test(prompt) ? { timeline } : {
    ...(/Timeline written from the frames/.test(prompt) ? {} : { timeline }),
    summary: 'A short talk to camera on the Fernwise app: where the year\'s money went, the savings curve and the free trial.',
    usableMoments: frames.length ? [{ from: frames[0].at, to: Math.min(end, frames[0].at + 3), why: 'Clean opening line, good for a hook' }] : [],
    look: { colours: ['#0E2A1F', '#17784A', '#A7E8C3', '#D9CFBD'], typography: 'Bold grotesque titles, light sans text', framing: 'Centred, calm, lots of space', audio: 'One voice, no music' },
    tags: ['fernwise', 'talking head', 'finance', 'app'],
  };
  return bridge('write_video_analysis', write);
}

let step = 0;
const usage = { input_tokens: 1200, output_tokens: 600, cache_read_input_tokens: 18000, cache_creation_input_tokens: 2400 };
const say = (text) => out({ type: 'assistant', session_id: sessionId, message: { id: `msg_${++step}`, role: 'assistant', content: [{ type: 'text', text }], usage } });
const tool = (name, input, result) => {
  const id = `tu_${++step}`;
  out({ type: 'assistant', session_id: sessionId, message: { id: `msg_${step}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
};

const rl = createInterface({ input: process.stdin });
rl.once('line', async (line) => {
  const msg = JSON.parse(line);
  const content = msg.message?.content;
  const prompt = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c.text ?? '').join('\n') : '';
  if (process.env.GUIDE_AGENT_LOG) appendFileSync(process.env.GUIDE_AGENT_LOG, `${JSON.stringify({ cwd: process.cwd(), args, prompt })}\n`);
  const fence = (name) => { const m = [...prompt.matchAll(new RegExp('```' + name + '\\n([\\s\\S]*?)\\n```', 'g'))].at(-1); return m ? JSON.parse(m[1]) : null; };
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-demo' });
  let reply = 'Done.';
  const block = fence('motion-studio');
  const brand = fence('motion-studio-brand');
  const describe = fence('motion-studio-describe');
  const all = prompt + args.join(' ');
  if (block) {
    say('I read the brief and the brand kit, then I lay out each format on its own grid.');
    tool('Read', { file_path: 'brand/brand-kit.json' }, B.colors.map((c) => `${c[1]} ${c[2]}`).join(', '));
    if (APPROVE && existsSync(APPROVE) && readFileSync(APPROVE, 'utf8') === 'ask') {
      writeFileSync(APPROVE, 'asked');
      say('The brand guide links a press kit on another site: I need your permission to read it.');
      await bridge('approve', { tool_name: 'WebFetch', input: { url: `${B.site.replace('https://', 'https://press.')}/press-kit`, prompt: 'List the product photos and the approved claims.' }, tool_use_id: `tu_${++step}` });
    }
    if (HOLD) while (existsSync(HOLD) && readFileSync(HOLD, 'utf8') === 'hold') await sleep(200);
    const { n, variant } = writeCompositions(block);
    tool('Write', { file_path: `${block.outputDir}/compositions/${block.formats[0]?.id}/composition.json` }, 'File written');
    reply = n === 1
      ? `Here is the first version${variant !== 'a' ? ` of variant ${variant.toUpperCase()}` : ''}: every format is recomposed for its own frame (${block.formats.map((f) => f.id).join(', ')}).`
      : `Version ${n} is ready: the closing line is now "${B.lines[(n - 1) % B.lines.length]}", same timing and layout.`;
  } else if (brand) {
    say('Reading the site: colours, fonts, the logo and the tone.');
    tool('WebFetch', { url: brand.sources.find((s) => s.kind === 'website')?.url ?? '' }, 'Page read');
    brandAnalysis(brand);
    reply = 'I found the palette, three fonts, the mark and the tone. Review the proposal entry by entry.';
  } else if (describe) {
    mkdirSync(dirname(describe.outFile), { recursive: true });
    writeFileSync(describe.outFile, JSON.stringify(describe.files.map((f) => ({ file: f.replace(/^assets\//, ''), description: `${B.name}: ${basename(f).replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')}`, tags: [brandKey] }))));
    reply = 'Descriptions written.';
  } else if (/write_video_analysis/.test(all)) {
    await videoAnalysis(prompt);
    reply = 'Analysis written.';
  } else if (/fill_brief/.test(all)) {
    await bridge('fill_brief', {
      goal: 'A launch film for KOVA Air, our new noise-cancelling earbuds: from the noise of the city to silence.',
      message: 'Silence, engineered.', durationSec: 16, notes: 'Dark, precise, cyan accents. Show the specs as numbers.',
      formats: ['instagram-reel-9x16', 'instagram-post-1x1', 'youtube-16x9'],
    });
    reply = 'I filled in the goal, the key message, a 16 s length and three formats: Reel 9:16, Post 1:1 and YouTube 16:9. Change anything you like, then press Generate.';
  }
  say(reply);
  out({
    type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sessionId, duration_ms: 42_000, num_turns: 6, total_cost_usd: 0.42,
    usage: { input_tokens: 2400, output_tokens: 3100, cache_read_input_tokens: 64000, cache_creation_input_tokens: 9800 },
    modelUsage: { 'claude-demo': { inputTokens: 2400, outputTokens: 3100, cacheReadInputTokens: 64000, cacheCreationInputTokens: 9800, costUSD: 0.42 } },
  });
  process.exit(0);
});
