#!/usr/bin/env node
// Test double for `claude -p --input-format stream-json` with a stdin that may stay open (Phase 13 Task 1).
// No real `claude` is ever started by the tests. Mode via FAKE_STREAM_MODE:
//   mid-turn            consumes a user message written during the turn's tool step, then ends the turn (one result)
//   after-result        ends the first turn, then runs one more turn (one more result) per message read afterwards
//   ignores             reads further user messages but never answers them (one result)
//   interrupt-ack       on a control_request interrupt: control_response success, then an error result; stays alive and
//                       runs one more turn per later user message
//   interrupt-result-first  on a control_request interrupt: the interrupted turn's error result first, then the
//                       control_response success (the ordering the real CLI might use; unverified live)
//   interrupt-error     on a control_request interrupt: control_response error (the CLI refuses it)
//   interrupt-no-ack    never answers a control_request; the turn hangs until stdin closes or it is killed
//   exits-early         exits with code 3 right after the first message, without a result
//   child-ignores-term  leaves a child (same process group) that ignores SIGTERM, and itself ignores SIGTERM and hangs
// Every mode ends when stdin closes (EOF) and nothing is pending, with exit code 0.
// Every line read is appended to FAKE_STREAM_LOG (JSON per line: { at, line } or { at, eof: true }).
// stderr: `fake-pid: <pid>` at start; `child-pid: <pid>` in child-ignores-term.
// The "tool step" lasts FAKE_STREAM_TOOL_MS (default 400) and is announced with a tool_use event.
// FAKE_STREAM_ACK_GAP_MS (interrupt-ack): delay between the control_response and the interrupted turn's result (default 0).
// A user message whose text starts with `fail:` ends its turn with an error result (error_max_turns); one starting with
// `abort:` ends it with error_during_execution (the interrupted shape, but nobody interrupted it).
// FAKE_STREAM_INTERRUPTED_EXIT (decision 804): the exit code at EOF when the last result was error_during_execution
// (Claude Code 2.1.301 exits with 1 after an interrupt; default 0).
// FAKE_STREAM_ACK_ID: the control_response echoes this request_id instead of the one received (an ack that is not ours).
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_STREAM_MODE ?? 'mid-turn';
const toolMs = Number(process.env.FAKE_STREAM_TOOL_MS ?? 400);
const ackGapMs = Number(process.env.FAKE_STREAM_ACK_GAP_MS ?? 0);
const interruptedExit = Number(process.env.FAKE_STREAM_INTERRUPTED_EXIT ?? 0);
const ackId = (c) => process.env.FAKE_STREAM_ACK_ID || c.request_id;
let lastInterruptedShape = false;
const log = (o) => { if (process.env.FAKE_STREAM_LOG) appendFileSync(process.env.FAKE_STREAM_LOG, `${JSON.stringify({ at: Date.now(), ...o })}\n`); };
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SESSION = 'fake-stream-session';
process.stderr.write(`fake-pid: ${process.pid}\n`);

const textOf = (m) => (typeof m.message?.content === 'string' ? m.message.content : '');
const result = (ok, text) => { lastInterruptedShape = !ok; out({ type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, session_id: SESSION, result: text }); };

let eof = false;
const userQueue = [];
const controlQueue = [];
let wake = null;
const notify = () => { const w = wake; wake = null; w?.(); };
const next = () => new Promise((r) => { wake = r; });

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  log({ line });
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_request') controlQueue.push(m);
  else if (m.type === 'user') userQueue.push(m);
  notify();
});
rl.on('close', () => { log({ eof: true }); eof = true; notify(); });

/** Waits until a line arrives, stdin closes or `ms` passes. */
const waitLine = (ms) => Promise.race([next(), sleep(ms)]);

async function turn(first) {
  out({ type: 'assistant', message: { id: `m-${Date.now()}`, content: [{ type: 'text', text: `working on: ${textOf(first)}` }] } });
  out({ type: 'assistant', message: { id: `t-${Date.now()}`, content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } });
  const until = Date.now() + toolMs;
  let interrupted = false;
  while (Date.now() < until) {
    const c = controlQueue.shift();
    if (c) {
      if (mode === 'interrupt-result-first') {
        out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } });
        result(false, 'interrupted');
        await sleep(150); // a separate read for the runner: the result is handled (and closes stdin) before the ack
        out({ type: 'control_response', response: { subtype: 'success', request_id: ackId(c), response: { still_queued: [] } } });
        return;
      }
      if (mode === 'interrupt-ack') { out({ type: 'control_response', response: { subtype: 'success', request_id: ackId(c), response: { still_queued: [] } } }); interrupted = true; break; }
      if (mode === 'interrupt-error') out({ type: 'control_response', response: { subtype: 'error', request_id: c.request_id, error: 'interrupt not supported' } });
      // Never answers and never ends the turn: only a kill stops it.
      if (mode === 'interrupt-no-ack') { setInterval(() => {}, 1000); await new Promise(() => {}); }
    }
    if (mode === 'mid-turn' && userQueue.length > 0) {
      const m = userQueue.shift();
      out({ type: 'assistant', message: { id: `a-${Date.now()}`, content: [{ type: 'text', text: `got mid-turn: ${textOf(m)}` }] } });
    }
    if (eof && Date.now() >= until) break;
    await waitLine(Math.max(1, until - Date.now()));
  }
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } });
  if (interrupted) { if (ackGapMs > 0) await sleep(ackGapMs); result(false, 'interrupted'); }
  else if (textOf(first).startsWith('fail:')) { lastInterruptedShape = false; out({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: SESSION, result: `failed: ${textOf(first)}` }); }
  else if (textOf(first).startsWith('abort:')) result(false, `aborted: ${textOf(first)}`);
  else result(true, `done: ${textOf(first)}`);
}

async function main() {
  while (userQueue.length === 0 && !eof) await next();
  const first = userQueue.shift();
  if (!first) process.exit(0);
  out({ type: 'system', subtype: 'init', session_id: SESSION, model: 'fake' });
  if (mode === 'exits-early') { process.stderr.write('fake: exiting early\n'); process.exit(3); }
  if (mode === 'child-ignores-term') {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
    process.stderr.write(`child-pid: ${child.pid}\n`);
    process.on('SIGTERM', () => {});
    out({ type: 'assistant', message: { id: 'h', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] } });
    setInterval(() => {}, 1000);
    return;
  }
  await turn(first);
  // After the result: modes that keep going answer later messages with a turn each; others only drain.
  for (;;) {
    if (userQueue.length > 0) {
      const m = userQueue.shift();
      if (mode === 'after-result' || mode === 'interrupt-ack') await turn(m);
      continue;
    }
    controlQueue.length = 0;
    if (eof) break;
    await next();
  }
  process.exit(lastInterruptedShape ? interruptedExit : 0);
}
void main();
