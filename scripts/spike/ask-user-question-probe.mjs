#!/usr/bin/env node
// Probe: does the installed Claude Code CLI take the answer to its built-in AskUserQuestion from a --permission-prompt-tool
// (an MCP tool) the way the Agent SDK documents it for `canUseTool`? Motion Studio answers with
//   { "behavior": "allow", "updatedInput": { ...original input, "answers": { "<question text>": "<label>" } } }
// (https://code.claude.com/docs/en/agent-sdk/user-input, "Return answers to Claude"); the docs do not say the MCP prompt tool
// path accepts it (decision 873 in docs/decisions-log.md). Prints one JSON object.
//
// It runs ONLY when a person starts it by hand. No test, script or CI job runs it, and agents must not: it starts the
// REAL `claude` (or CLAUDE_BIN) with model haiku in a throwaway temp folder, on the account of whoever runs it, at a cost
// of a few cents. Run it yourself:  node scripts/spike/ask-user-question-probe.mjs
// What to look for: `allow.reachedPromptTool` true (the CLI asked our tool), `allow.answerSeen` true (the agent's reply
// names the option we chose: COLOR-RED) and `allow.toolResult` holding the answer; with `deny`, the agent goes on without one.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const MCP = join(dirname(fileURLToPath(import.meta.url)), 'ask-user-question-probe-mcp.mjs');
const PROMPT = 'Before anything else, use the AskUserQuestion tool to ask me one question: "Which colour should the logo be?", '
  + 'header "Colour", options "Red" (warm) and "Blue" (cold), single choice. Then reply with exactly COLOR-<my answer in capitals>, '
  + 'or COLOR-NONE if you got no answer.';

function run(name, deny) {
  return new Promise((resolve) => {
    const cwd = mkdtempSync(join(tmpdir(), 'ms-ask-probe-'));
    const logFile = join(cwd, 'prompt-tool.jsonl');
    const config = join(cwd, 'mcp.json');
    writeFileSync(config, JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [MCP], env: { PROBE_LOG: logFile, PROBE_DENY: deny ? '1' : '0' } } } }));
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
      '--mcp-config', config, '--permission-prompt-tool', 'mcp__probe__approve',
      '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch'];
    const events = [];
    let buf = '';
    let stderr = '';
    const child = spawn(CLAUDE, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try { const e = JSON.parse(line); events.push(e); if (e.type === 'result') child.stdin.end(); } catch { /* not JSON */ }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => child.kill('SIGTERM'), 180_000);
    child.on('close', (code) => {
      clearTimeout(killer);
      let calls = [];
      try { calls = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
      rmSync(cwd, { recursive: true, force: true });
      const content = events.flatMap((e) => (e.type === 'assistant' || e.type === 'user' ? e.message?.content ?? [] : []));
      const askIds = new Set(content.filter((c) => c.type === 'tool_use' && c.name === 'AskUserQuestion').map((c) => c.id));
      const toolResult = content.filter((c) => c.type === 'tool_result' && askIds.has(c.tool_use_id));
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const result = events.filter((e) => e.type === 'result').at(-1) ?? null;
      resolve({
        name, exitCode: code, askedWithTool: askIds.size > 0, reachedPromptTool: calls.some((c) => c.request?.tool_name === 'AskUserQuestion'),
        promptToolCalls: calls, toolResult, finalText: result?.result ?? text.slice(-300), answerSeen: /COLOR-RED/.test(`${text}\n${result?.result ?? ''}`),
        resultSubtype: result?.subtype ?? null, stderrTail: stderr.slice(-400),
      });
    });
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: PROMPT }] } })}\n`);
  });
}

const version = await new Promise((r) => { const c = spawn(CLAUDE, ['--version']); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', () => r(o.trim())); });
console.log(JSON.stringify({ cliVersion: version, allow: await run('answered (first option)', false), deny: await run('not answered (deny)', true) }, null, 2));
