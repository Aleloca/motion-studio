#!/usr/bin/env node
// Motion Studio MCP server: a dependency-free stdio bridge. Every tool call is forwarded to the Motion Studio core
// on loopback with the per-job token; the core holds the API keys and does the work.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const URL_BASE = (process.env.MOTION_STUDIO_BRIDGE_URL ?? '').replace(/\/+$/, '');
// The launcher hands the token over in a private file (never in argv or the config); the env var is a fallback.
const TOKEN = (() => {
  const file = process.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE;
  if (file) {
    try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
  }
  return (process.env.MOTION_STUDIO_BRIDGE_TOKEN ?? '').trim();
})();
// Just above the agent's MCP_TOOL_TIMEOUT (15 min): an approval waits for the user with no response headers, so no shorter timeout may apply.
const CAP_MS = Number(process.env.MOTION_STUDIO_BRIDGE_TIMEOUT_MS) || 16 * 60 * 1000;
const ENABLED = new Set((process.env.MOTION_STUDIO_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const TOOLS = [
  { name: 'approve', description: 'Internal to Motion Studio (permission requests).', inputSchema: { type: 'object', properties: { tool_name: str('Tool'), input: { type: 'object' }, tool_use_id: str('Id') }, additionalProperties: true } },
  { name: 'report_progress', description: 'Tell the user where you are (one short sentence).', inputSchema: { type: 'object', properties: { message: str('Short sentence', { maxLength: 300 }) }, required: ['message'] } },
  { name: 'validate_output', description: 'Checks the outputs of the current version against the contract and returns the problems.', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_brand_kit', description: 'Reads the project brand kit and guidelines.', inputSchema: { type: 'object', properties: {} } },
  { name: 'generate_image', description: 'Generates or edits an image with gpt-image-2 (paid; may ask the user for confirmation). Returns the path of the file saved in the assets.', inputSchema: { type: 'object', properties: { prompt: str('Description'), width: { type: 'integer' }, height: { type: 'integer' }, quality: { enum: ['low', 'medium', 'high', 'auto'] }, background: { enum: ['transparent', 'opaque', 'auto'] }, references: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Project images to use as references' }, name: str('File name (optional)') }, required: ['prompt', 'width', 'height'] } },
  { name: 'tts', description: 'Generates a voice-over (paid; may ask for confirmation). Returns the path of the audio file.', inputSchema: { type: 'object', properties: { text: str('Text to read'), provider: { enum: ['openai', 'elevenlabs'] }, voice: str('Voice'), instructions: str('Tone and style (OpenAI only)'), format: { enum: ['mp3', 'wav'] }, name: str('File name (optional)') }, required: ['text'] } },
  { name: 'stock_search', description: 'Searches photos or videos on Pexels or Unsplash.', inputSchema: { type: 'object', properties: { provider: { enum: ['pexels', 'unsplash'] }, query: str('Search query (works best in English)'), kind: { enum: ['photo', 'video'] }, orientation: { enum: ['landscape', 'portrait', 'square'] }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['provider', 'query'] } },
  { name: 'stock_download', description: 'Downloads a stock result into the project assets, with the required attribution.', inputSchema: { type: 'object', properties: { provider: { enum: ['pexels', 'unsplash'] }, id: str('Result id'), kind: { enum: ['photo', 'video'] } }, required: ['provider', 'id'] } },
  { name: 'fonts_fetch', description: 'Downloads a font from Google Fonts into the project assets.', inputSchema: { type: 'object', properties: { family: str('Family, e.g. "Manrope"'), weights: { type: 'array', items: { type: 'integer' } }, italic: { type: 'boolean' } }, required: ['family'] } },
  { name: 'download_file', description: 'Downloads a file (logo, image or font) from a website into the project assets: give the URL and the destination in assets/brand/ or assets/fonts/', inputSchema: { type: 'object', properties: { url: str('http(s) URL of the file to download'), dest: str('Destination, e.g. "assets/brand/logo.svg" or "assets/fonts/Inter-400.woff2"') }, required: ['url', 'dest'] } },
];

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const listed = () => TOOLS.filter((t) => t.name === 'approve' || ENABLED.has(t.name));
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

// node:http instead of fetch: undici cuts a request without response headers after 5 minutes.
function post(path, payload) {
  return new Promise((resolve, reject) => {
    const req = request(`${URL_BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-motion-studio-bridge': TOKEN } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => req.destroy(new Error('no response within the maximum time')), CAP_MS);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(payload);
  });
}

async function call(name, args) {
  if (!listed().some((t) => t.name === name)) return fail(`Tool not available: ${name}`);
  if (!TOKEN) return fail('Motion Studio is unreachable: token missing');
  try {
    const { status, body } = await post(`/api/bridge/${encodeURIComponent(name)}`, JSON.stringify(args ?? {}));
    if (status < 200 || status > 299) return fail(body?.error ?? `Error ${status}`);
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  } catch (err) {
    return fail(`Motion Studio is unreachable: ${err.message}`);
  }
}

let inflight = 0;
let closed = false;
const maybeExit = () => { if (closed && inflight === 0) process.exit(0); };
createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.id === undefined) return; // notification
  inflight++;
  try { await handle(msg); } finally { inflight--; maybeExit(); }
}).on('close', () => { closed = true; maybeExit(); });

async function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'studio', version: '0.4.0' } } });
    case 'ping':
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { tools: listed() } });
    case 'tools/call':
      return send({ jsonrpc: '2.0', id: msg.id, result: await call(msg.params?.name, msg.params?.arguments) });
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unsupported method: ${msg.method}` } });
  }
}
