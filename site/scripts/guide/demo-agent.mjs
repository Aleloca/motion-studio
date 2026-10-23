#!/usr/bin/env node
// The guide's demo agent: stands in for the `claude` CLI so the screenshots show a real Motion Studio at work without
// Claude Code, a model or any paid service. It speaks the same stream-json as the test double
// (packages/core/test/fixtures/fake-claude.mjs) and answers each kind of job with fixed, plausible work:
// - a creative turn writes one composition per format (the site's "Ember Coffee" teaser where the size matches, a simple
//   brand card elsewhere, the Ember mark for identity formats);
// - a brand analysis proposes the Ember Coffee kit; an asset description writes short descriptions;
// - a brief session fills the New creative form through the studio bridge (as the MCP server would).
// GUIDE_COMPOSITIONS: the site's compositions folder; GUIDE_FONTS: the site's fonts; GUIDE_HOLD: while that file exists, a
// creative turn waits after its first step (the "agent at work" screenshots).
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.301 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, subscriptionType: 'max' })); process.exit(0); }

const COMPS = process.env.GUIDE_COMPOSITIONS;
const FONTS = process.env.GUIDE_FONTS;
const HOLD = process.env.GUIDE_HOLD;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resumeAt = args.indexOf('--resume');
const sessionId = resumeAt >= 0 ? `${args[resumeAt + 1]}${args.includes('--fork-session') ? '-fork' : ''}` : `demo-${process.pid}`;
const mcpAt = args.indexOf('--mcp-config');
const bridgeEnv = (() => { try { return JSON.parse(readFileSync(args[mcpAt + 1], 'utf8')).mcpServers.studio.env; } catch { return null; } })();

const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>Ember mark</title><rect width="512" height="512" rx="112" fill="#0F0F0F"/><ellipse id="bean" cx="256" cy="256" rx="150" ry="190" fill="#FF5A1F" transform="rotate(-24 256 256)"/><path id="crease" d="M214 98c70 70 20 150 70 200s20 110-10 116" fill="none" stroke="#0F0F0F" stroke-width="26" stroke-linecap="round"/></svg>';
const FONT_LIST = [
  { family: 'Bricolage Grotesque', src: 'assets/fonts/BricolageGrotesque.woff2', weight: 800 },
  { family: 'Instrument Sans', src: 'assets/fonts/InstrumentSans.woff2', weight: 400 },
  { family: 'Instrument Sans', src: 'assets/fonts/InstrumentSans.woff2', weight: 500 },
  { family: 'JetBrains Mono', src: 'assets/fonts/JetBrainsMono.woff2', weight: 400 },
];
/** Each later version changes the headline, so every turn makes a new version. */
const HEADLINES = ['Brew something bold.', 'Bold coffee, your way.', 'Your order, ready when you are.', 'Wake up to something bold.'];

function copyFonts(dir) {
  mkdirSync(join(dir, 'assets', 'fonts'), { recursive: true });
  for (const f of readdirSync(FONTS).filter((n) => n.endsWith('.woff2'))) copyFileSync(join(FONTS, f), join(dir, 'assets', 'fonts', f));
}

/** The site's teaser of the same size, with three named scenes, or null. */
function teaser(f, n) {
  const id = { '1080x1920': 'hero-9x16', '1080x1080': 'hero-1x1', '1920x1080': 'hero-16x9' }[`${f.width}x${f.height}`];
  if (!id || f.kind !== 'video' || !existsSync(join(COMPS, id, 'composition.json'))) return null;
  const c = JSON.parse(readFileSync(join(COMPS, id, 'composition.json'), 'utf8'));
  const d = c.duration;
  c.scenes = [
    { id: 'open', name: 'Opening: the bean', start: 0, duration: Math.round(d * 0.3 * 10) / 10 },
    { id: 'headline', name: 'The headline rises', start: Math.round(d * 0.3 * 10) / 10, duration: Math.round(d * 0.4 * 10) / 10 },
    { id: 'cta', name: 'Call to action', start: Math.round(d * 0.7 * 10) / 10, duration: Math.round((d - Math.round(d * 0.7 * 10) / 10) * 10) / 10 },
  ];
  const names = { label: 'Brand label', headline: 'Headline', sub: 'Subtitle', 'cta-label': 'Button label', cta: 'Button', bean: 'Coffee bean', crease: 'Bean crease' };
  for (const t of c.tracks) {
    t.name = t.kind === 'text' ? 'Texts' : 'Shapes';
    for (const clip of t.clips) {
      const key = clip.id.replace(/-\d+$/, '');
      if (names[key]) clip.name = names[key];
      if (key === 'headline') clip.props.text = HEADLINES[(n - 1) % HEADLINES.length];
    }
  }
  return c;
}

/** A brand card for any other size: the mark, the name and a line. */
function card(f, n, identity) {
  const still = f.kind === 'image';
  const duration = still ? 0 : Math.min(6, f.maxDurationSec ?? 6);
  if (identity) {
    return { $schema: 'motion-studio/composition@1', width: f.width, height: f.height, fps: 30, duration: 0, background: '#0F0F0F', fonts: [], scenes: [],
      tracks: [{ id: 'mark', name: 'Mark', kind: 'visual', clips: [{ id: 'mark', name: 'Ember mark', type: 'svg', src: 'assets/logo.svg', start: 0, duration: 0, props: { fit: 'contain' } }] }] };
  }
  const s = Math.min(f.width, f.height);
  const wide = f.width / f.height > 2;
  const markSize = Math.round(s * (wide ? 0.6 : 0.32));
  const anim = (preset) => (still ? [] : [{ preset, start: 0, duration: 0.6 }]);
  return {
    $schema: 'motion-studio/composition@1', width: f.width, height: f.height, fps: 30, duration, background: '#0F0F0F', fonts: FONT_LIST,
    scenes: still ? [] : [{ id: 'main', name: 'Brand card', start: 0, duration }],
    tracks: [
      { id: 'visual', name: 'Mark', kind: 'visual', clips: [{ id: 'mark', name: 'Ember mark', type: 'svg', src: 'assets/logo.svg', start: 0, duration, props: { x: Math.round(f.width * 0.08), y: Math.round(wide ? (f.height - markSize) / 2 : f.height * 0.12), width: markSize, height: markSize }, animations: anim('popIn') }] },
      { id: 'text', name: 'Texts', kind: 'text', clips: [
        { id: 'headline', name: 'Headline', type: 'text', start: 0, duration, props: { text: HEADLINES[(n - 1) % HEADLINES.length], fontFamily: 'Bricolage Grotesque', fontWeight: 800, color: '#F5F1EC', fontSize: Math.round(s * (wide ? 0.18 : 0.09)), x: Math.round(wide ? f.width * 0.08 + markSize * 1.3 : f.width * 0.08), y: Math.round(wide ? f.height * 0.3 : f.height * 0.55), width: Math.round(wide ? f.width * 0.6 : f.width * 0.84), height: Math.round(s * (wide ? 0.4 : 0.25)) }, animations: anim('fadeIn') },
        { id: 'label', name: 'Brand label', type: 'text', start: 0, duration, props: { text: 'EMBER COFFEE', fontFamily: 'JetBrains Mono', fontWeight: 400, color: '#FF5A1F', fontSize: Math.max(12, Math.round(s * (wide ? 0.08 : 0.035))), x: Math.round(wide ? f.width * 0.08 + markSize * 1.3 : f.width * 0.08), y: Math.round(wide ? f.height * 0.12 : f.height * 0.48), width: Math.round(f.width * 0.6), height: Math.round(s * (wide ? 0.12 : 0.05)) }, animations: anim('fadeIn') },
      ] },
    ],
  };
}

/** Each variant of a group gets its own look: B is light, C is orange, D cream on orange, E inverted grey. */
const LOOKS = {
  b: { '#0F0F0F': '#F5F1EC', '#F5F1EC': '#0F0F0F', '#A3A3A3': '#525252' },
  c: { '#0F0F0F': '#FF5A1F', '#FF5A1F': '#0F0F0F', '#C2410C': '#0F0F0F' },
  d: { '#0F0F0F': '#C2410C', '#FF5A1F': '#F5F1EC' },
  e: { '#0F0F0F': '#262626' },
};
function recolor(c, variant) {
  const look = LOOKS[variant];
  if (!look) return c;
  return JSON.parse(JSON.stringify(c).replace(/#[0-9A-Fa-f]{6}/g, (h) => look[h.toUpperCase()] ?? h));
}

function writeCompositions(block) {
  const n = Number(/v(\d+)$/.exec(block.outputDir.replace(/\/+$/, ''))?.[1] ?? 1);
  const variant = /~([b-e])(?:\/|$)/.exec(block.outputDir)?.[1] ?? 'a';
  mkdirSync(block.workDir, { recursive: true });
  writeFileSync(join(block.workDir, 'plan.md'), `# Ember Coffee teaser, v${n}\n`);
  for (const f of block.formats) {
    const dir = f.compositionDir ?? join(block.outputDir, 'compositions', f.id);
    mkdirSync(join(dir, 'assets'), { recursive: true });
    const identity = /^identity-/.test(f.id);
    let c = teaser(f, n) ?? card(f, n, identity);
    if (!identity) c = recolor(c, variant);
    if (c.fonts.length) copyFonts(dir);
    writeFileSync(join(dir, 'assets', 'logo.svg'), MARK);
    writeFileSync(join(dir, 'composition.json'), `${JSON.stringify(c, null, 2)}\n`);
  }
  return n;
}

function brandAnalysis(b) {
  const kit = JSON.parse(readFileSync(b.kitFile, 'utf8'));
  const url = b.sources.find((s) => s.kind === 'website')?.url ?? 'https://ember-coffee.example';
  const src = { kind: 'website', ref: url };
  const add = (list, item) => { if (!list.some((x) => x.id === item.id)) list.push(item); };
  add(kit.colors, { id: 'ember-orange', name: 'Ember orange', hex: '#FF5A1F', role: 'primary', source: src });
  add(kit.colors, { id: 'roast', name: 'Roast black', hex: '#0F0F0F', role: 'background', source: src });
  add(kit.colors, { id: 'foam', name: 'Foam', hex: '#F5F1EC', role: 'text', source: src });
  add(kit.colors, { id: 'crema', name: 'Crema', hex: '#C2410C', role: 'secondary', source: src });
  mkdirSync('assets/fonts', { recursive: true });
  for (const f of ['BricolageGrotesque.woff2', 'InstrumentSans.woff2']) copyFileSync(join(FONTS, f), join('assets/fonts', f));
  add(kit.fonts, { id: 'bricolage', family: 'Bricolage Grotesque', role: 'heading', weights: [800], file: 'assets/fonts/BricolageGrotesque.woff2', source: src });
  add(kit.fonts, { id: 'instrument', family: 'Instrument Sans', role: 'body', weights: [400, 500], file: 'assets/fonts/InstrumentSans.woff2', source: src });
  mkdirSync('assets/brand', { recursive: true });
  writeFileSync('assets/brand/ember-mark.svg', MARK);
  add(kit.logos, { id: 'ember-mark', file: 'assets/brand/ember-mark.svg', variant: 'icon', background: 'any', source: src });
  kit.tone = { id: 'tone', text: 'Warm, direct and a little bold. Short sentences, no jargon.', source: src };
  add(kit.dos, { id: 'short', text: 'Lead with one short, confident line.', source: src });
  add(kit.donts, { id: 'stock', text: 'No generic stock coffee cups.', source: src });
  writeFileSync(b.kitFile, JSON.stringify(kit));
  writeFileSync(b.guidelinesFile, '# Ember Coffee\n\nWarm, direct and a little bold. Orange on roast black, cream text.\n');
  writeFileSync(b.assetsListFile, JSON.stringify([
    { file: 'brand/ember-mark.svg', sourceUrl: `${url}/mark.svg`, description: 'The Ember coffee bean mark', tags: ['logo'] },
    { file: 'fonts/BricolageGrotesque.woff2', sourceUrl: `${url}/fonts/bricolage.woff2`, description: 'Headline font', tags: ['font'] },
    { file: 'fonts/InstrumentSans.woff2', sourceUrl: `${url}/fonts/instrument.woff2`, description: 'Text font', tags: ['font'] },
  ]));
  writeFileSync(b.summaryFile, 'Orange (#FF5A1F) on roast black, with cream text. Bricolage Grotesque for headlines, Instrument Sans for text. A warm, direct tone.');
}

async function bridge(tool, payload) {
  if (!bridgeEnv) return null;
  const token = readFileSync(bridgeEnv.MOTION_STUDIO_BRIDGE_TOKEN_FILE, 'utf8').trim();
  const res = await fetch(`${bridgeEnv.MOTION_STUDIO_BRIDGE_URL}/api/bridge/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-motion-studio-bridge': token }, body: JSON.stringify(payload) });
  return res.json().catch(() => null);
}

let step = 0;
const say = (text) => out({ type: 'assistant', session_id: sessionId, message: { id: `msg_${++step}`, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 1200, output_tokens: 600, cache_read_input_tokens: 18000, cache_creation_input_tokens: 2400 } } });
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
  if (process.env.GUIDE_AGENT_LOG) appendFileSync(process.env.GUIDE_AGENT_LOG, `${JSON.stringify({ args, prompt })}\n`);
  const fence = (name) => { const m = [...prompt.matchAll(new RegExp('```' + name + '\\n([\\s\\S]*?)\\n```', 'g'))].at(-1); return m ? JSON.parse(m[1]) : null; };
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-demo' });
  let reply = 'Done.';
  const block = fence('motion-studio');
  const brand = fence('motion-studio-brand');
  const describe = fence('motion-studio-describe');
  if (block) {
    say('I read the brief and the brand kit, then I will lay out each format on its own grid.');
    tool('Read', { file_path: 'brand/brand-kit.json' }, 'Ember orange #FF5A1F, Roast black #0F0F0F, Foam #F5F1EC');
    if (HOLD) while (existsSync(HOLD)) await sleep(200);
    const n = writeCompositions(block);
    tool('Write', { file_path: `${block.outputDir}/compositions/${block.formats[0]?.id}/composition.json` }, 'File written');
    reply = n === 1
      ? `Here is the first version: the bean pops in, the headline rises under the label and the button lands last. Each format has its own layout (${block.formats.map((f) => f.id).join(', ')}).`
      : `Version ${n} is ready: new headline "${HEADLINES[(n - 1) % HEADLINES.length]}", same timing and layout.`;
  } else if (brand) {
    say('Reading the site: colours, fonts, the logo and the tone.');
    tool('WebFetch', { url: brand.sources.find((s) => s.kind === 'website')?.url ?? '' }, 'Page read');
    brandAnalysis(brand);
    reply = 'I found the palette, two fonts, the bean mark and the tone. Review the proposal entry by entry.';
  } else if (describe) {
    mkdirSync(join(describe.outFile, '..'), { recursive: true });
    writeFileSync(describe.outFile, JSON.stringify(describe.files.map((f) => ({ file: f.replace(/^assets\//, ''), description: `Ember Coffee: ${basename(f).replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')}`, tags: ['ember', 'coffee'] }))));
    reply = 'Descriptions written.';
  } else if (/fill_brief/.test(prompt + args.join(' '))) {
    await bridge('fill_brief', {
      goal: 'A launch teaser for the Ember Coffee app: order ahead, skip the line.',
      message: 'Brew something bold.', durationSec: 6, notes: 'Warm and bold, the bean mark, orange on roast black.',
      formats: ['instagram-reel-9x16', 'instagram-post-1x1', 'youtube-16x9'],
    });
    reply = 'I filled in the goal, the key message, a 6 s length and three formats: Reel 9:16, Post 1:1 and YouTube 16:9. Change anything you like, then press Generate.';
  } else {
    reply = 'Done.';
  }
  say(reply);
  out({
    type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sessionId, duration_ms: 42_000, num_turns: 6, total_cost_usd: 0.42,
    usage: { input_tokens: 2400, output_tokens: 3100, cache_read_input_tokens: 64000, cache_creation_input_tokens: 9800 },
    modelUsage: { 'claude-demo': { inputTokens: 2400, outputTokens: 3100, cacheReadInputTokens: 64000, cacheCreationInputTokens: 9800, costUSD: 0.42 } },
  });
  process.exit(0);
});
