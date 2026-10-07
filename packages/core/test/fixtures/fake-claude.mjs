#!/usr/bin/env node
// Test double for the `claude` CLI. Scenario via FAKE_CLAUDE_SCENARIO: ok | tool | crash | hang | hang_ignore_term | garbage | error_result | leak_fd
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
const sessionId = resumeAt >= 0 ? args[resumeAt + 1] : 'fake-session-1';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rl = createInterface({ input: process.stdin });
rl.once('line', async (line) => {
  const msg = JSON.parse(line);
  const prompt = typeof msg.message?.content === 'string' ? msg.message.content : '';
  if (scenario === 'crash') { process.stderr.write('boom: something failed\n'); process.exit(2); }
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
