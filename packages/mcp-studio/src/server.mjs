#!/usr/bin/env node
// Motion Studio MCP server: a dependency-free stdio bridge. Every tool call is forwarded to the Motion Studio core
// on loopback with the per-job token; the core holds the API keys and does the work.
import { readFileSync } from 'node:fs';
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
const ENABLED = new Set((process.env.MOTION_STUDIO_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const TOOLS = [
  { name: 'approve', description: 'Uso interno di Motion Studio (richieste di permesso).', inputSchema: { type: 'object', properties: { tool_name: str('Strumento'), input: { type: 'object' }, tool_use_id: str('Id') }, additionalProperties: true } },
  { name: 'report_progress', description: "Comunica all'utente a che punto sei (una frase breve).", inputSchema: { type: 'object', properties: { message: str('Frase breve', { maxLength: 300 }) }, required: ['message'] } },
  { name: 'validate_output', description: 'Controlla gli output della versione corrente rispetto al contratto e restituisce i problemi.', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_brand_kit', description: 'Legge brand kit e linee guida del progetto.', inputSchema: { type: 'object', properties: {} } },
  { name: 'generate_image', description: "Genera o modifica un'immagine con gpt-image-2 (a pagamento; può chiedere conferma all'utente). Restituisce il percorso del file salvato negli asset.", inputSchema: { type: 'object', properties: { prompt: str('Descrizione'), width: { type: 'integer' }, height: { type: 'integer' }, quality: { enum: ['low', 'medium', 'high', 'auto'] }, background: { enum: ['transparent', 'opaque', 'auto'] }, references: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Immagini del progetto da usare come riferimento' }, name: str('Nome file (facoltativo)') }, required: ['prompt', 'width', 'height'] } },
  { name: 'tts', description: 'Genera una voce fuori campo (a pagamento; può chiedere conferma). Restituisce il percorso del file audio.', inputSchema: { type: 'object', properties: { text: str('Testo da leggere'), provider: { enum: ['openai', 'elevenlabs'] }, voice: str('Voce'), instructions: str('Tono e stile (solo OpenAI)'), format: { enum: ['mp3', 'wav'] }, name: str('Nome file (facoltativo)') }, required: ['text'] } },
  { name: 'stock_search', description: 'Cerca foto o video su Pexels o Unsplash.', inputSchema: { type: 'object', properties: { provider: { enum: ['pexels', 'unsplash'] }, query: str('Ricerca (in inglese funziona meglio)'), kind: { enum: ['photo', 'video'] }, orientation: { enum: ['landscape', 'portrait', 'square'] }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['provider', 'query'] } },
  { name: 'stock_download', description: "Scarica un risultato di stock negli asset del progetto, con l'attribuzione richiesta.", inputSchema: { type: 'object', properties: { provider: { enum: ['pexels', 'unsplash'] }, id: str('Id del risultato'), kind: { enum: ['photo', 'video'] } }, required: ['provider', 'id'] } },
  { name: 'fonts_fetch', description: 'Scarica un font da Google Fonts negli asset del progetto.', inputSchema: { type: 'object', properties: { family: str('Famiglia, es. "Manrope"'), weights: { type: 'array', items: { type: 'integer' } }, italic: { type: 'boolean' } }, required: ['family'] } },
];

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const listed = () => TOOLS.filter((t) => t.name === 'approve' || ENABLED.has(t.name));
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

async function call(name, args) {
  if (!listed().some((t) => t.name === name)) return fail(`Strumento non disponibile: ${name}`);
  if (!TOKEN) return fail('Motion Studio non raggiungibile: token mancante');
  try {
    const res = await fetch(`${URL_BASE}/api/bridge/${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-motion-studio-bridge': TOKEN }, body: JSON.stringify(args ?? {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return fail(body.error ?? `Errore ${res.status}`);
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  } catch (err) {
    return fail(`Motion Studio non raggiungibile: ${err.message}`);
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification
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
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Metodo non supportato: ${msg.method}` } });
  }
});
