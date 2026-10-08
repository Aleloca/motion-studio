import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
let http: Server;
let calls: Array<{ url: string; token: string | undefined; body: unknown }>;
let child: ChildProcessWithoutNullStreams;
let responses: Map<number, any>;
let port: number;
const dirs: string[] = [];

function startChild(env: Record<string, string>) {
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, MOTION_STUDIO_BRIDGE_TOKEN: '', MOTION_STUDIO_BRIDGE_TOKEN_FILE: '', MOTION_STUDIO_BRIDGE_URL: `http://127.0.0.1:${port}`, MOTION_STUDIO_TOOLS: 'report_progress,validate_output', ...env } });
  responses = new Map();
  createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); responses.set(m.id, m); });
}

beforeEach(async () => {
  calls = [];
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      calls.push({ url: req.url!, token: req.headers['x-motion-studio-bridge'] as string, body: JSON.parse(raw || '{}') });
      if (req.url === '/api/bridge/validate_output') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Validazione disponibile solo nelle creatività' })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/bridge/approve' ? { behavior: 'deny', message: 'no' } : { ok: true }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  port = (http.address() as { port: number }).port;
  startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok' });
});
afterEach(async () => {
  child.kill(); http.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const rpc = async (id: number, method: string, params: unknown = {}) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  for (let i = 0; i < 200 && !responses.has(id); i++) await new Promise((r) => setTimeout(r, 10));
  return responses.get(id);
};

describe('mcp-studio server', () => {
  it('initializes and lists approve plus the enabled tools only', async () => {
    expect((await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'studio' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const names = (await rpc(2, 'tools/list')).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['approve', 'report_progress', 'validate_output']);
  });
  it('forwards calls with the token and maps errors', async () => {
    await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
    const ok = await rpc(2, 'tools/call', { name: 'report_progress', arguments: { message: 'ciao' } });
    expect(ok.result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
    expect(calls[0]).toEqual({ url: '/api/bridge/report_progress', token: 'tok', body: { message: 'ciao' } });
    const bad = await rpc(3, 'tools/call', { name: 'validate_output', arguments: {} });
    expect(bad.result).toEqual({ content: [{ type: 'text', text: 'Validazione disponibile solo nelle creatività' }], isError: true });
    const approve = await rpc(4, 'tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'x' }, tool_use_id: 'u' } });
    expect(JSON.parse(approve.result.content[0].text)).toEqual({ behavior: 'deny', message: 'no' });
    expect((await rpc(5, 'nope/method')).error.code).toBe(-32601);
  });
  it('reads the token from MOTION_STUDIO_BRIDGE_TOKEN_FILE (trimmed), preferring it to the env token', async () => {
    child.kill();
    const dir = await mkdtemp(join(tmpdir(), 'ms-mcp-'));
    dirs.push(dir);
    const file = join(dir, 'a.token');
    await writeFile(file, 'filetok\n', { mode: 0o600 });
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN_FILE: file, MOTION_STUDIO_BRIDGE_TOKEN: 'envtok' });
    await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
    await rpc(2, 'tools/call', { name: 'report_progress', arguments: { message: 'x' } });
    expect(calls[0]!.token).toBe('filetok');
  });
  it('without a readable token every call fails without reaching the core', async () => {
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN_FILE: '/nonexistent/ms.token' });
    await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
    const res = await rpc(2, 'tools/call', { name: 'report_progress', arguments: { message: 'x' } });
    expect(res.result).toEqual({ content: [{ type: 'text', text: 'Motion Studio non raggiungibile: token mancante' }], isError: true });
    expect(calls).toEqual([]);
  });
});
