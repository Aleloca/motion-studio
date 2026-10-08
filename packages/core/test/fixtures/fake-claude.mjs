#!/usr/bin/env node
// Test double for the `claude` CLI. Scenario via FAKE_CLAUDE_SCENARIO: ok | tool | crash | hang | hang_ignore_term | garbage | error_result | leak_fd | render | render_missing_once | render_never | render_then_crash | render_touch | brand | brand_invalid | brand_many_dropped | brand_big_guidelines | brand_symlink_summary | brand_outside_assets | brand_mixed
// FAKE_CLAUDE_TAMPER=1: brand/describe turns also overwrite brand/brand-kit.json and assets/assets.json directly.
// FAKE_CLAUDE_SYMLINK_BRAND=<dir>: describe turns move brand/ to <dir>, tamper the kit there and leave a symlink.
// FAKE_CLAUDE_WAIT_FILE=<path>: brand/describe turns wait for that file to exist before finishing.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
// The MCP config file as claude sees it at startup (mode and contents), when one is passed.
const mcpConfigAt = process.argv.indexOf('--mcp-config');
const mcpConfigFile = mcpConfigAt >= 0 ? (() => { const p = process.argv[mcpConfigAt + 1]; try { return { path: p, mode: statSync(p).mode & 0o777, content: readFileSync(p, 'utf8') }; } catch { return { path: p, mode: null, content: null }; } })() : null;
// The token file named by the MCP config, as claude sees it at startup.
const tokenFile = (() => { try { const p = JSON.parse(mcpConfigFile.content).mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE; return { path: p, mode: statSync(p).mode & 0o777, content: readFileSync(p, 'utf8') }; } catch { return null; } })();
if (process.env.FAKE_CLAUDE_ARGS_FILE) writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify({ args, tokenFile, cwd: process.cwd(), pid: process.pid, env: process.env.MS_TEST_ENV ?? null, mcpTimeout: process.env.MCP_TOOL_TIMEOUT ?? null, envKeys: Object.keys(process.env), mcpConfigFile }));
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  const loggedIn = process.env.FAKE_CLAUDE_LOGGED_IN !== '0';
  console.log(JSON.stringify({ loggedIn }));
  process.exit(loggedIn ? 0 : 1);
}

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'ok';
const resumeAt = args.indexOf('--resume');
const resumed = resumeAt >= 0 ? args[resumeAt + 1] : null;
const sessionId = resumed ? (args.includes('--fork-session') ? `${resumed}-fork` : resumed) : 'fake-session-1';
const hasFfmpeg = () => spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
// Real (tiny) media when ffmpeg is installed, so tests that use real MediaTools see valid files.
const writeMedia = (file, f, durationSec) => {
  if (!ffmpegOk) { writeFileSync(file, 'fake-media'); return; }
  const input = ['-f', 'lavfi', '-i', `color=c=blue:s=${f.width}x${f.height}${f.kind === 'video' ? `:d=${durationSec}:r=5` : ''}`];
  const output = f.kind === 'video' ? ['-pix_fmt', 'yuv420p', file] : ['-frames:v', '1', file];
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, ...output], { stdio: 'ignore' });
  if (r.status !== 0) writeFileSync(file, 'fake-media');
};
const ffmpegOk = hasFfmpeg();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let currentPrompt = '';
const describeBlockEarly = () => /```motion-studio-describe\n/.test(currentPrompt);

const rl = createInterface({ input: process.stdin });
rl.once('line', async (line) => {
  const msg = JSON.parse(line);
  const prompt = typeof msg.message?.content === 'string' ? msg.message.content : '';
  currentPrompt = prompt;
  if (process.env.FAKE_CLAUDE_PROMPT_FILE) appendFileSync(process.env.FAKE_CLAUDE_PROMPT_FILE, `${JSON.stringify({ prompt, args })}\n`);
  // Same rule as parseStudioBlock: the last motion-studio fence wins.
  const block = (() => { const m = [...prompt.matchAll(/```motion-studio\n([\s\S]*?)\n```/g)].at(-1); return m ? JSON.parse(m[1]) : null; })();
  const isFix = prompt.includes('do not meet the contract');
  const render = (skipLast) => {
    mkdirSync(block.outputDir, { recursive: true });
    mkdirSync(block.workDir, { recursive: true });
    writeFileSync(join(block.workDir, 'scene.txt'), `${prompt.length}:${Date.now()}`);
    const formats = skipLast ? block.formats.slice(0, -1) : block.formats;
    const files = formats.map((f) => {
      const file = `${f.id}.${f.extensions[0]}`;
      writeMedia(join(block.outputDir, file), f, block.durationSec ?? 10);
      return { format: f.id, file, width: f.width, height: f.height, ...(f.kind === 'video' ? { durationSec: block.durationSec ?? 10 } : {}) };
    });
    writeFileSync(join(block.outputDir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files, tools: ['fake'], renderCommand: 'node render.js' }));
  };
  if (block && scenario === 'render') render(false);
  if (scenario === 'render_touch' && block) { render(false); if (process.env.FAKE_CLAUDE_TOUCH) writeFileSync(process.env.FAKE_CLAUDE_TOUCH, 'modified'); if (process.env.FAKE_CLAUDE_GIT_INIT) spawnSync('git', ['init', '-q'], { cwd: process.env.FAKE_CLAUDE_GIT_INIT }); }
  const brandBlock = (() => { const m = prompt.match(/```motion-studio-brand\n([\s\S]*?)\n```/); return m ? JSON.parse(m[1]) : null; })();
  if (brandBlock && (scenario === 'brand' || scenario === 'render' || scenario.startsWith('brand_'))) {
    const kit = JSON.parse(readFileSync(brandBlock.kitFile, 'utf8'));
    const url = brandBlock.sources.find((s) => s.kind === 'website')?.url ?? 'https://acme.example';
    kit.colors.push({ id: 'arancio', name: 'Arancio', hex: '#FF7A45', role: 'accent', source: { kind: 'website', ref: url } });
    mkdirSync('assets/brand', { recursive: true });
    writeFileSync('assets/brand/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync('assets/brand/unlisted.png', 'x');
    kit.logos.push({ id: 'logo', file: 'assets/brand/logo.svg', variant: 'primary', background: 'light', source: { kind: 'website', ref: url } });
    kit.logos.push({ id: 'ghost', file: 'assets/brand/ghost.svg', variant: 'icon', background: 'any', source: { kind: 'website', ref: url } });
    writeFileSync(brandBlock.kitFile, JSON.stringify(kit));
    writeFileSync(brandBlock.guidelinesFile, '# Linee guida\nTono energico.');
    writeFileSync(brandBlock.assetsListFile, JSON.stringify([{ file: 'brand/logo.svg', sourceUrl: `${url}/logo.svg`, description: 'Logo principale', tags: ['logo'] }, { file: '../evil' }]));
    writeFileSync(brandBlock.summaryFile, 'Palette arancio/blu, tono energico.');
    if (scenario === 'brand_many_dropped') {
      for (let i = 0; i < 25; i++) kit.logos.push({ id: `ghost-${i}`, file: `assets/brand/ghost-${i}.svg`, variant: 'icon', background: 'any', source: { kind: 'website', ref: url } });
      writeFileSync(brandBlock.kitFile, JSON.stringify(kit));
    }
    if (scenario === 'brand_outside_assets') {
      kit.logos.push({ id: 'progetto', file: 'project.json', variant: 'icon', background: 'any', source: { kind: 'website', ref: url } });
      kit.fonts.push({ id: 'ref-font', family: 'Ref', role: 'body', weights: [400], file: 'brand/guidelines.md', source: { kind: 'website', ref: url } });
      writeFileSync(brandBlock.kitFile, JSON.stringify(kit));
    }
    if (scenario === 'brand_mixed') {
      // Shapes a real agent produced on an empty kit: unknown enums, string notes, string weights.
      kit.colors.push({ id: 'blu-scuro', name: 'Blu scuro', hex: '#123456', role: 'brand', source: { kind: 'website', ref: url } });
      kit.colors[0] = { ...kit.colors[0], role: 'principale' };
      kit.fonts.push({ id: 'sans', family: 'Open Sans', role: 'body', weights: '400, 700', file: null, source: { kind: 'website', ref: url } });
      kit.fonts.push({ id: 'mono', family: 'Mono', role: 'code', weights: ['400'], file: null, source: { kind: 'website', ref: url } });
      kit.fonts.push({ id: 'serif', family: 'Serif', role: 'heading', weights: ['400', 700], file: null, source: { kind: 'website', ref: url } });
      kit.logos.push({ id: 'wordmark', file: 'assets/brand/logo.svg', variant: 'wordmark', background: 'light', source: { kind: 'website', ref: url } });
      kit.tone = 'Chiaro, amichevole e tecnico.';
      kit.dos = ['Usa esempi di codice reali', { text: 'Cita la community', source: { kind: 'image', ref: 'brand/sources/x.png' } }];
      kit.donts = [{ id: 'gergo', text: '', source: { kind: 'website', ref: url } }];
      writeFileSync(brandBlock.kitFile, JSON.stringify(kit));
    }
    if (scenario === 'brand_big_guidelines') writeFileSync(brandBlock.guidelinesFile, 'x'.repeat(200_001));
    if (scenario === 'brand_symlink_summary') { writeFileSync('outside-summary.md', 'SEGRETO'); spawnSync('rm', ['-f', brandBlock.summaryFile]); symlinkSync(join(process.cwd(), 'outside-summary.md'), brandBlock.summaryFile); }
  }
  if (brandBlock && scenario === 'brand_invalid') writeFileSync(brandBlock.kitFile, '{oops');
  if (describeBlockEarly() && process.env.FAKE_CLAUDE_SYMLINK_BRAND) {
    const outside = process.env.FAKE_CLAUDE_SYMLINK_BRAND;
    spawnSync('cp', ['-R', 'brand', outside]);
    writeFileSync(join(outside, 'brand-kit.json'), '{"tampered":true}');
    spawnSync('rm', ['-rf', 'brand']);
    symlinkSync(outside, 'brand');
  }
  if ((brandBlock || describeBlockEarly()) && process.env.FAKE_CLAUDE_TAMPER) {
    writeFileSync('brand/brand-kit.json', '{"tampered":true}');
    writeFileSync('assets/assets.json', '{"tampered":true}');
  }
  const describeBlock = (() => { const m = prompt.match(/```motion-studio-describe\n([\s\S]*?)\n```/); return m ? JSON.parse(m[1]) : null; })();
  if (describeBlock) {
    mkdirSync(dirname(describeBlock.outFile), { recursive: true });
    writeFileSync(describeBlock.outFile, JSON.stringify(describeBlock.files.map((f) => ({ file: f.replace(/^assets\//, ''), description: `Descrizione di ${f}`, tags: ['auto'] }))));
  }
  if ((brandBlock || describeBlockEarly()) && process.env.FAKE_CLAUDE_WAIT_FILE) { while (!existsSync(process.env.FAKE_CLAUDE_WAIT_FILE)) await sleep(20); }
  if (block && scenario === 'render_missing_once') render(!isFix);
  if (block && scenario === 'render_never') render(true);
  if (block && scenario === 'render_then_crash') render(false);
  if (scenario === 'crash' || scenario === 'render_then_crash') { process.stderr.write('boom: something failed\n'); process.exit(2); }
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model' });
  if (scenario === 'garbage') process.stdout.write('this is not json\n');
  if (scenario === 'hang_ignore_term') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
  // Grandchildren share our stdio and process group; their pid is reported on stderr so tests can check they are killed.
  const grandchild = () => { const c = spawn('sleep', ['30'], { stdio: 'inherit' }); process.stderr.write(`grandchild-pid: ${c.pid}\n`); };
  if (scenario === 'hang') { grandchild(); setInterval(() => {}, 1000); return; }
  if (scenario === 'leak_fd') {
    // Leader exits after a successful result while a descendant keeps stdout/stderr open.
    grandchild();
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId, total_cost_usd: 0 });
    await sleep(50);
    process.exit(0);
  }
  if (scenario === 'tool') {
    out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] } });
    out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt' }] } });
  }
  if (scenario === 'error_result') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Usage limit reached', session_id: sessionId });
    process.exit(1);
  }
  const text = JSON.stringify({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${prompt}` }] } });
  process.stdout.write(text.slice(0, 10));
  await sleep(20);
  process.stdout.write(text.slice(10) + '\n');
  out({ type: 'result', subtype: 'success', is_error: false, result: `echo: ${prompt}`, session_id: sessionId, total_cost_usd: 0 });
  process.exit(0);
});
