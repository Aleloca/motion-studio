#!/usr/bin/env node
// Probe: does the installed Claude Code CLI accept (1) a user message sent mid-turn on stream-json input, and (2) an
// interrupt control_request? Prints one JSON object.
//
// It runs ONLY when a person starts it by hand. No test, script or CI job runs it, and agents must not: it starts the
// REAL `claude` (or CLAUDE_BIN) with model haiku in a throwaway temp folder, on the account of whoever runs it, at a cost
// of a few cents. Run it yourself:  node scripts/spike/stream-input-probe.mjs
// The output of the run on Claude Code 2.1.301 (2026-10-16) and its reading: docs/superpowers/notes/2026-10-16-stream-input-probe.md
// (decision 804 in docs/decisions-log.md).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
  '--permission-mode', 'default', '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch'];
const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';

function run(name, script) {
  return new Promise((resolve) => {
    const cwd = mkdtempSync(join(tmpdir(), 'ms-probe-'));
    const t0 = Date.now();
    const events = [];
    let buf = '';
    let stderr = '';
    const child = spawn(CLAUDE, ARGS, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const at = () => Date.now() - t0;
    const send = (line) => { if (!child.stdin.destroyed) child.stdin.write(line); };
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try { const e = JSON.parse(line); events.push({ t: at(), type: e.type, subtype: e.subtype, e }); script.onEvent?.(e, send, child); } catch { events.push({ t: at(), raw: line.slice(0, 200) }); }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => child.kill('SIGTERM'), 120_000);
    child.on('close', (code) => {
      clearTimeout(killer);
      rmSync(cwd, { recursive: true, force: true });
      resolve({ name, exitCode: code, ms: at(), ...script.summary(events), stderrTail: stderr.slice(-400) });
    });
    script.start(send, child);
  });
}

const texts = (events) => events.filter((x) => x.type === 'assistant')
  .flatMap((x) => (x.e.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text));

// 1. Mid-turn user message: a slow first request, then a second message while the first turn is still running.
const midTurn = {
  sent: false,
  start(send) { send(user('Count slowly from 1 to 40, one number per line, then say DONE-ONE.')); },
  onEvent(e, send, child) {
    if (!this.sent && e.type === 'assistant') {
      this.sent = true;
      send(user('Also, after that, reply with the single word PINEAPPLE.'));
    }
    if (e.type === 'result' && this.sent) { this.results = (this.results ?? 0) + 1; if (this.results >= 2) child.stdin.end(); }
  },
  summary(events) {
    const all = texts(events).join('\n');
    return { results: events.filter((x) => x.type === 'result').length, sawSecondAnswer: /PINEAPPLE/i.test(all),
      firstAnswerDone: /DONE-ONE/i.test(all), lastResult: events.filter((x) => x.type === 'result').at(-1)?.e?.subtype ?? null };
  },
};

// 2. Interrupt control_request while the turn is running.
const interrupt = {
  sent: false,
  start(send) { send(user('Write a numbered list of 200 short facts about the ocean.')); },
  onEvent(e, send, child) {
    if (!this.sent && e.type === 'assistant') {
      this.sent = true;
      send(JSON.stringify({ type: 'control_request', request_id: 'probe-int-1', request: { subtype: 'interrupt' } }) + '\n');
      setTimeout(() => child.stdin.end(), 15_000);
    }
    if (e.type === 'result') child.stdin.end();
  },
  summary(events) {
    const ctl = events.filter((x) => x.type === 'control_response').map((x) => x.e);
    const res = events.filter((x) => x.type === 'result').at(-1)?.e ?? null;
    return { controlResponses: ctl.map((c) => c.response ?? c), resultSubtype: res?.subtype ?? null,
      interruptedEarly: res ? (texts(events).join('\n').match(/^\s*\d+\./gm)?.length ?? 0) < 150 : null };
  },
};

const version = await new Promise((r) => { const c = spawn(CLAUDE, ['--version']); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', () => r(o.trim())); });
const out = { cliVersion: version, midTurn: await run('mid-turn user message', midTurn), interrupt: await run('interrupt control_request', interrupt) };
console.log(JSON.stringify(out, null, 2));
