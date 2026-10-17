#!/usr/bin/env node
// Helper of ask-user-question-probe.mjs (never started on its own): a minimal stdio MCP server with one tool, `approve`,
// used as Claude Code's --permission-prompt-tool. Each call is appended to PROBE_LOG. For AskUserQuestion it answers as
// Motion Studio does (decision 874): `allow` with the original input plus `answers` (question text → the FIRST option's
// label), or `deny` when PROBE_DENY=1. Any other tool is denied.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const log = (o) => { if (process.env.PROBE_LOG) appendFileSync(process.env.PROBE_LOG, `${JSON.stringify(o)}\n`); };

function answer(args) {
  const input = args.input ?? args.tool_input ?? {};
  if (args.tool_name !== 'AskUserQuestion') return { behavior: 'deny', message: 'Probe: only AskUserQuestion is answered.' };
  if (process.env.PROBE_DENY === '1') return { behavior: 'deny', message: 'The user chose not to answer. Go on with your best judgment and say what you assumed.' };
  const answers = Object.fromEntries((input.questions ?? []).map((q) => [q.question, q.options?.[0]?.label ?? '']));
  return { behavior: 'allow', updatedInput: { ...input, answers } };
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '0.0.1' } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'approve', description: 'Permission prompts (probe).', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, additionalProperties: true } }] } });
  if (msg.method === 'tools/call') {
    const args = msg.params?.arguments ?? {};
    const reply = answer(args);
    log({ request: args, reply });
    return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
