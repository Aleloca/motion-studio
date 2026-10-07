#!/usr/bin/env node
// Test double for the `claude` CLI. Scenario via FAKE_CLAUDE_SCENARIO: ok | tool | crash | hang | hang_ignore_term | garbage | error_result | leak_fd | render | render_missing_once | render_never | render_then_crash
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS_FILE) writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify({ args, cwd: process.cwd(), pid: process.pid }));
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

const rl = createInterface({ input: process.stdin });
rl.once('line', async (line) => {
  const msg = JSON.parse(line);
  const prompt = typeof msg.message?.content === 'string' ? msg.message.content : '';
  if (process.env.FAKE_CLAUDE_PROMPT_FILE) appendFileSync(process.env.FAKE_CLAUDE_PROMPT_FILE, `${JSON.stringify({ prompt, args })}\n`);
  // Same rule as parseStudioBlock: the last motion-studio fence wins.
  const block = (() => { const m = [...prompt.matchAll(/```motion-studio\n([\s\S]*?)\n```/g)].at(-1); return m ? JSON.parse(m[1]) : null; })();
  const isFix = prompt.includes('non rispettano il contratto');
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
