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
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, MOTION_STUDIO_BRIDGE_TOKEN: '', MOTION_STUDIO_BRIDGE_TOKEN_FILE: '', MOTION_STUDIO_BRIDGE_URL: `http://127.0.0.1:${port}`, MOTION_STUDIO_TOOLS: 'report_progress,validate_composition,preview_frames', ...env } });
  responses = new Map();
  createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); responses.set(m.id, m); });
}

beforeEach(async () => {
  calls = [];
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const msg = (JSON.parse(raw || '{}') as { message?: string }).message;
      const delay = msg === 'slow' ? 1500 : msg === 'hang' ? 60_000 : 0;
      setTimeout(() => respond(), delay);
      function respond() {
      calls.push({ url: req.url!, token: req.headers['x-motion-studio-bridge'] as string, body: JSON.parse(raw || '{}') });
      if (req.url === '/api/bridge/validate_composition') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Validazione disponibile solo nelle creatività' })); return; }
      if (req.url === '/api/bridge/preview_frames') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, frames: [{ t: 0, width: 2, height: 2 }], images: [{ mimeType: 'image/png', data: 'iVBORw0K' }, { mimeType: 'text/html', data: 'PGI+' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/bridge/approve' ? { behavior: 'deny', message: 'no' } : { ok: true }));
      }
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  port = (http.address() as { port: number }).port;
  startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok' });
});
afterEach(async () => {
  child.kill(); http.closeAllConnections(); http.close();
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
    expect(names).toEqual(['approve', 'report_progress', 'validate_composition', 'preview_frames']);
  });
  it('lists download_file for brand analysis with url and dest required', async () => {
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: 'report_progress,read_brand_kit,fonts_fetch,download_file' });
    const tools = (await rpc(3, 'tools/list')).result.tools as Array<{ name: string; description: string; inputSchema: { required: string[]; properties: Record<string, { type: string }> } }>;
    const dl = tools.find((t) => t.name === 'download_file')!;
    expect(dl.description).toBe('Downloads a file (logo, image or font) from a website into the project assets: give the URL and the destination in assets/brand/ or assets/fonts/');
    expect(dl.inputSchema.required).toEqual(['url', 'dest']);
    expect(dl.inputSchema.properties.url!.type).toBe('string');
    expect(dl.inputSchema.properties.dest!.type).toBe('string');
    const res = await rpc(4, 'tools/call', { name: 'download_file', arguments: { url: 'https://acme.example/logo.svg', dest: 'assets/brand/logo.svg' } });
    expect(res.result.isError).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ url: '/api/bridge/download_file', body: { url: 'https://acme.example/logo.svg', dest: 'assets/brand/logo.svg' } });
  });
  it('lists inspect_site_fonts for brand analysis and the phase of report_progress', async () => {
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: 'report_progress,read_brand_kit,fonts_fetch,download_file,inspect_site_fonts' });
    const tools = (await rpc(3, 'tools/list')).result.tools as Array<{ name: string; inputSchema: { required?: string[]; properties: Record<string, { type?: string; enum?: string[] }> } }>;
    const inspect = tools.find((t) => t.name === 'inspect_site_fonts')!;
    expect(inspect.inputSchema.required).toEqual(['url']);
    expect(inspect.inputSchema.properties.url!.type).toBe('string');
    expect(tools.find((t) => t.name === 'report_progress')!.inputSchema.properties.phase!.enum).toEqual(['reading', 'fonts', 'colors', 'logos', 'tone', 'writing']);
    await rpc(4, 'tools/call', { name: 'inspect_site_fonts', arguments: { url: 'https://acme.example' } });
    expect(calls.at(-1)).toMatchObject({ url: '/api/bridge/inspect_site_fonts', body: { url: 'https://acme.example' } });
  });
  it('lists import_codebase_file for brand analysis with source and dest required, and forwards it', async () => {
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: 'report_progress,download_file,import_codebase_file' });
    const tools = (await rpc(3, 'tools/list')).result.tools as Array<{ name: string; description: string; inputSchema: { required: string[]; properties: Record<string, { type: string }> } }>;
    const imp = tools.find((t) => t.name === 'import_codebase_file')!;
    expect(imp.inputSchema.required).toEqual(['source', 'dest']);
    expect(imp.inputSchema.properties.source!.type).toBe('string');
    expect(imp.description).toMatch(/secret files, files outside the codebase and files over 50 MB are refused/);
    await rpc(4, 'tools/call', { name: 'import_codebase_file', arguments: { source: 'public/logo.svg', dest: 'assets/brand/logo.svg' } });
    expect(calls.at(-1)).toMatchObject({ url: '/api/bridge/import_codebase_file', body: { source: 'public/logo.svg', dest: 'assets/brand/logo.svg' } });
  });
  it('lists submit_variant_directions alone for a directions turn (phase 15), with directions required, and forwards it', async () => {
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: 'submit_variant_directions' });
    const tools = (await rpc(3, 'tools/list')).result.tools as Array<{ name: string; description: string; inputSchema: { required: string[]; properties: Record<string, { type: string; items?: { maxLength: number } }> } }>;
    expect(tools.map((t) => t.name)).toEqual(['approve', 'submit_variant_directions']);
    const tool = tools[1]!;
    expect(tool.inputSchema.required).toEqual(['directions']);
    expect(tool.inputSchema.properties.directions!.type).toBe('array');
    expect(tool.inputSchema.properties.directions!.items!.maxLength).toBe(140);
    expect(tool.description).toMatch(/^Variant directions turns only/);
    await rpc(4, 'tools/call', { name: 'submit_variant_directions', arguments: { directions: ['Minimal pastello', 'Retro anni 80'] } });
    expect(calls.at(-1)).toMatchObject({ url: '/api/bridge/submit_variant_directions', body: { directions: ['Minimal pastello', 'Retro anni 80'] } });
    // Not enabled for another job: refused without reaching the core.
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok' });
    const before = calls.length;
    expect((await rpc(5, 'tools/call', { name: 'submit_variant_directions', arguments: { directions: ['x'] } })).result.isError).toBe(true);
    expect(calls).toHaveLength(before);
  });
  it('lists list_formats and fill_brief alone for a brief session and forwards fill_brief', async () => {
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: 'report_progress,read_brand_kit,list_formats,fill_brief' });
    const tools = (await rpc(3, 'tools/list')).result.tools as Array<{ name: string; description: string; inputSchema: { additionalProperties?: boolean; minProperties?: number; properties: Record<string, { type?: unknown; items?: unknown }> } }>;
    expect(tools.map((t) => t.name)).toEqual(['approve', 'report_progress', 'read_brand_kit', 'list_formats', 'fill_brief']);
    const fill = tools.find((t) => t.name === 'fill_brief')!;
    expect(fill.inputSchema.additionalProperties).toBe(false);
    expect(fill.inputSchema.minProperties).toBe(1);
    expect(Object.keys(fill.inputSchema.properties)).toEqual(['goal', 'message', 'notes', 'durationSec', 'assets', 'linkedCodebases', 'formats', 'variants', 'reclaim']);
    expect(fill.description).toMatch(/^Brief sessions only/);
    expect(tools.find((t) => t.name === 'list_formats')!.inputSchema.additionalProperties).toBe(false);
    await rpc(4, 'tools/call', { name: 'fill_brief', arguments: { goal: 'Lancio' } });
    expect(calls.at(-1)).toMatchObject({ url: '/api/bridge/fill_brief', body: { goal: 'Lancio' } });
    await rpc(5, 'tools/call', { name: 'list_formats', arguments: {} });
    expect(calls.at(-1)).toMatchObject({ url: '/api/bridge/list_formats' });
  });
  it('lists write_video_analysis alone for a video analysis and forwards it (decision 1468)', async () => {
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: 'report_progress,write_video_analysis' });
    const tools = (await rpc(3, 'tools/list')).result.tools as Array<{ name: string; description: string; inputSchema: { additionalProperties?: boolean; minProperties?: number; properties: Record<string, unknown> } }>;
    expect(tools.map((t) => t.name)).toEqual(['approve', 'report_progress', 'write_video_analysis']);
    const w = tools.find((t) => t.name === 'write_video_analysis')!;
    expect(w.description).toMatch(/^Video analysis jobs only: writes the analysis of the frames you were given/);
    expect(w.inputSchema).toMatchObject({ additionalProperties: false, minProperties: 1 });
    expect(Object.keys(w.inputSchema.properties)).toEqual(['summary', 'timeline', 'usableMoments', 'look', 'tags']);
    await rpc(4, 'tools/call', { name: 'write_video_analysis', arguments: { tags: ['demo'] } });
    expect(calls.at(-1)).toMatchObject({ url: '/api/bridge/write_video_analysis', body: { tags: ['demo'] } });
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: 'report_progress,fill_brief' });
    expect(((await rpc(5, 'tools/list')).result.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain('write_video_analysis');
  });
  it('lists start_subtitles and edit_subtitles only when the job names them, drawn required (U9, Task 19), and forwards them', async () => {
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: 'report_progress,start_subtitles,edit_subtitles' });
    const tools = (await rpc(3, 'tools/list')).result.tools as Array<{ name: string; description: string; inputSchema: { additionalProperties?: boolean; required?: string[]; properties: Record<string, unknown> } }>;
    expect(tools.map((t) => t.name)).toEqual(['approve', 'report_progress', 'start_subtitles', 'edit_subtitles']);
    const s = tools.find((t) => t.name === 'start_subtitles')!;
    expect(s.inputSchema.additionalProperties).toBe(false);
    expect(s.inputSchema.required).toEqual(['drawn']);
    expect(Object.keys(s.inputSchema.properties)).toEqual(['drawn', 'lang']);
    expect(s.description).toContain('AskUserQuestion');
    expect(s.description).toContain('Never write subtitles as text clips');
    expect(s.description).not.toContain('draws nothing into the video');
    const e = tools.find((t) => t.name === 'edit_subtitles')!;
    expect(e.inputSchema).toMatchObject({ additionalProperties: false, required: ['lang'] });
    expect(Object.keys(e.inputSchema.properties)).toEqual(['lang', 'replace', 'cues']);
    expect(e.inputSchema.properties.replace).toMatchObject({ maxItems: 20 });
    expect(e.inputSchema.properties.cues).toMatchObject({ maxItems: 200, items: { required: ['id', 'was', 'text'] } });
    expect(e.description).toContain('each with was, its text as you read it');
    await rpc(4, 'tools/call', { name: 'start_subtitles', arguments: { drawn: true, lang: 'it' } });
    expect(calls.at(-1)).toMatchObject({ url: '/api/bridge/start_subtitles', body: { drawn: true, lang: 'it' } });
    await rpc(5, 'tools/call', { name: 'edit_subtitles', arguments: { lang: 'it', replace: [{ find: 'motion studio', with: 'Motion Studio' }] } });
    expect(calls.at(-1)).toMatchObject({ url: '/api/bridge/edit_subtitles', body: { lang: 'it', replace: [{ find: 'motion studio', with: 'Motion Studio' }] } });
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: 'report_progress,update_brief' });
    const names = ((await rpc(6, 'tools/list')).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain('start_subtitles');
    expect(names).not.toContain('edit_subtitles');
  });
  it('describes every tool in English', async () => {
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: 'report_progress,validate_composition,preview_frames,read_brand_kit,generate_image,tts,stock_search,stock_download,fonts_fetch,download_file,inspect_site_fonts,list_formats,fill_brief' });
    const tools = (await rpc(3, 'tools/list')).result.tools as Array<{ name: string }>;
    expect(tools).toHaveLength(14);
    const text = JSON.stringify(tools);
    expect(text).not.toMatch(/[àèéìòù]|\b(Genera|Scarica|Cerca|Legge|Controlla|Comunica|Uso interno|italiano)\b/);
    expect(text).toContain('Searches photos or videos on Pexels or Unsplash.');
  });
  it('forwards calls with the token and maps errors', async () => {
    await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
    const ok = await rpc(2, 'tools/call', { name: 'report_progress', arguments: { message: 'ciao' } });
    expect(ok.result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
    expect(calls[0]).toEqual({ url: '/api/bridge/report_progress', token: 'tok', body: { message: 'ciao' } });
    const bad = await rpc(3, 'tools/call', { name: 'validate_composition', arguments: {} });
    expect(bad.result).toEqual({ content: [{ type: 'text', text: 'Validazione disponibile solo nelle creatività' }], isError: true });
    const approve = await rpc(4, 'tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'x' }, tool_use_id: 'u' } });
    expect(JSON.parse(approve.result.content[0].text)).toEqual({ behavior: 'deny', message: 'no' });
    expect((await rpc(5, 'nope/method')).error.code).toBe(-32601);
  });
  it('returns preview_frames images as MCP image content (PNG/JPEG only), the rest as text', async () => {
    const res = await rpc(2, 'tools/call', { name: 'preview_frames', arguments: { format: 'reel', times: [0] } });
    expect(res.result).toEqual({ content: [
      { type: 'text', text: JSON.stringify({ ok: true, frames: [{ t: 0, width: 2, height: 2 }] }) },
      { type: 'image', data: 'iVBORw0K', mimeType: 'image/png' },
    ] });
    expect(calls.at(-1)).toMatchObject({ url: '/api/bridge/preview_frames', body: { format: 'reel', times: [0] } });
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
    expect(res.result).toEqual({ content: [{ type: 'text', text: 'Motion Studio is unreachable: token missing' }], isError: true });
    expect(calls).toEqual([]);
  });
  it('waits for a slow response (no headers timeout of its own)', async () => {
    await rpc(1, 'initialize');
    const res = await rpc(2, 'tools/call', { name: 'report_progress', arguments: { message: 'slow' } });
    expect(res.result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
  });
  it('gives up with isError after the overall cap', async () => {
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_BRIDGE_TIMEOUT_MS: '300' });
    const res = await rpc(1, 'tools/call', { name: 'report_progress', arguments: { message: 'hang' } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/^Motion Studio is unreachable: /);
  });
  it('answers id 0 and string ids, concurrent calls with the right ids, and ignores malformed or null lines', async () => {
    child.stdin.write('not json\nnull\n42\n"x"\n');
    const raw = new Map<string | number, any>();
    createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); raw.set(m.id, m); });
    const wait = async (id: string | number) => { for (let i = 0; i < 300 && !raw.has(id); i++) await new Promise((r) => setTimeout(r, 10)); return raw.get(id); };
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'abc', method: 'tools/call', params: { name: 'report_progress', arguments: { message: 'slow' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'fast', method: 'tools/call', params: { name: 'report_progress', arguments: { message: 'f' } } })}\n`);
    expect((await wait(0)).result).toEqual({});
    const fast = await wait('fast');
    expect(raw.has('abc')).toBe(false); // the slow one is still pending
    expect(fast.result.content[0].text).toBe('{"ok":true}');
    expect((await wait('abc')).result.content[0].text).toBe('{"ok":true}');
    expect(raw.size).toBe(3); // nothing was emitted for the ignored lines
  });
  it('lists the app actions of a creative turn with strict schemas and forwards them (decision 917)', async () => {
    const actions = ['update_brief', 'add_format', 'duplicate_format', 'name_formats', 'add_language', 'add_variant', 'discard_variant', 'restore_variant', 'set_pick', 'render_version', 'prepare_export'];
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: ['report_progress', ...actions].join(',') });
    const tools = (await rpc(1, 'tools/list')).result.tools as Array<{ name: string; description: string; inputSchema: { additionalProperties?: boolean; required?: string[]; properties: Record<string, unknown> } }>;
    expect(tools.map((t) => t.name)).toEqual(['approve', 'report_progress', ...actions]);
    for (const t of tools.filter((x) => actions.includes(x.name))) {
      // No tool takes a path, a project or a creative: the core scopes every call to the turn's creative.
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
      for (const key of Object.keys(t.inputSchema.properties)) expect(key, t.name).not.toMatch(/path|project|slug|dest|job/i);
    }
    expect(tools.find((t) => t.name === 'add_variant')!.inputSchema.required).toEqual(['direction']);
    // No cap on variants (decision 978): a variant is any id a…z, aa… (the core checks it is a member).
    for (const name of ['discard_variant', 'restore_variant', 'set_pick']) {
      const v = tools.find((t) => t.name === name)!.inputSchema.properties.variant as { pattern: string; enum?: unknown };
      expect(v.enum, name).toBeUndefined();
      expect(['aa', 'f', 'b'].every((x) => new RegExp(v.pattern).test(x)) && !new RegExp(v.pattern).test('B'), name).toBe(true);
    }
    expect(tools.find((t) => t.name === 'add_variant')!.description).not.toMatch(/At most 5/);
    expect(tools.find((t) => t.name === 'update_brief')!.description).toContain('durationSec');
    const res = await rpc(2, 'tools/call', { name: 'update_brief', arguments: { durationSec: 60 } });
    expect(res.result.isError).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ url: '/api/bridge/update_brief', token: 'tok', body: { durationSec: 60 } });
    // Not enabled for this job (e.g. a brand analysis): refused by the server itself, the core is not called.
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: 'report_progress' });
    const before = calls.length;
    expect((await rpc(3, 'tools/call', { name: 'add_variant', arguments: { direction: 'Ironico' } })).result).toMatchObject({ isError: true });
    expect(calls.length).toBe(before);
  });
  it('lists the coordinator\'s tools of a group turn with strict schemas and forwards them (phase 3 of the single agent)', async () => {
    const names = ['report_progress', 'read_brand_kit', 'list_variants', 'work_on_variants', 'add_variants', 'update_brief', 'discard_variant', 'restore_variant', 'set_pick', 'render_version', 'prepare_export'];
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: names.join(',') });
    type Schema = { type?: string; additionalProperties?: boolean; required?: string[]; properties: Record<string, any>; items?: any; minItems?: number; maxItems?: number };
    const tools = (await rpc(1, 'tools/list')).result.tools as Array<{ name: string; description: string; inputSchema: Schema }>;
    expect(tools.map((t) => t.name)).toEqual(['approve', 'report_progress', 'list_variants', 'work_on_variants', 'add_variants', 'read_brand_kit', 'update_brief', 'discard_variant', 'restore_variant', 'set_pick', 'render_version', 'prepare_export']);
    const tool = (n: string) => tools.find((t) => t.name === n)!;
    for (const n of ['list_variants', 'work_on_variants', 'add_variants']) expect(tool(n).inputSchema.additionalProperties, n).toBe(false);
    const work = tool('work_on_variants').inputSchema.properties.items;
    expect(tool('work_on_variants').inputSchema.required).toEqual(['items']);
    expect(work.items.required).toEqual(['variant', 'instruction']);
    expect(work.items.additionalProperties).toBe(false);
    expect(work.items.properties.instruction.maxLength).toBe(4000);
    expect(new RegExp(work.items.properties.variant.pattern).test('aa')).toBe(true);
    expect(tool('work_on_variants').description).toMatch(/AskUserQuestion/);
    const add = tool('add_variants').inputSchema.properties.items;
    expect(add.items.required).toEqual(['direction']);
    expect(add.items.properties.direction).toMatchObject({ minLength: 3, maxLength: 140 });
    expect(add.maxItems).toBe(26);
    expect(tool('render_version').inputSchema.properties.variant).toBeTruthy();
    expect(JSON.stringify(tools)).not.toMatch(/[àèéìòù]/);
    await rpc(2, 'tools/call', { name: 'work_on_variants', arguments: { items: [{ variant: 'b', instruction: 'Bigger title' }] } });
    expect(calls.at(-1)).toMatchObject({ url: '/api/bridge/work_on_variants', token: 'tok', body: { items: [{ variant: 'b', instruction: 'Bigger title' }] } });
    // A creative turn does not list them.
    child.kill();
    startChild({ MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: 'report_progress,add_variant' });
    const before = calls.length;
    expect((await rpc(3, 'tools/call', { name: 'work_on_variants', arguments: { items: [] } })).result).toMatchObject({ isError: true });
    expect(calls.length).toBe(before);
  });
  it('exits on stdin close once in-flight calls are answered', async () => {
    const exited = new Promise<void>((r) => child.on('exit', () => r()));
    const out = rpc(1, 'tools/call', { name: 'report_progress', arguments: { message: 'slow' } });
    await new Promise((r) => setTimeout(r, 100));
    child.stdin.end();
    expect((await out).result.content[0].text).toBe('{"ok":true}');
    await exited;
  });
});
