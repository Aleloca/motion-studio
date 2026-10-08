import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AgentEvent } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { registerBridgeRoutes } from '../src/bridge/bridge-routes.ts';
import { BrandStore } from '../src/brand/brand-store.ts';

let app: FastifyInstance;
let bridge: AgentBridge;
let approvals: ApprovalBroker;
let events: AgentEvent[];
let token: string;
let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ms-br-'));
  await new BrandStore(projectDir).writeKit({ schemaVersion: 1, colors: [{ id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: { kind: 'manual', ref: null } }] });
  bridge = new AgentBridge();
  approvals = new ApprovalBroker({ broadcast: () => {} });
  events = [];
  token = bridge.register({ jobId: 'j1', kind: 'creative', projectSlug: 'acme', projectDir, creativeSlug: 'c1', emit: (e) => events.push(e), validate: async () => ({ problems: ['Manca il formato X'], outputs: [] }) });
  app = Fastify();
  registerBridgeRoutes(app, { bridge, approvals });
});
afterEach(async () => { await app.close(); approvals.cancelAll(); await rm(projectDir, { recursive: true, force: true }); });
const call = (tool: string, payload: unknown, t: string | undefined = token) =>
  app.inject({ method: 'POST', url: `/api/bridge/${tool}`, payload: payload as object, headers: t ? { 'x-motion-studio-bridge': t } : {} });

describe('bridge', () => {
  it('rejects missing, malformed and unknown tokens', async () => {
    expect((await call('report_progress', { message: 'x' }, '')).statusCode).toBe(401); // '' = no header (undefined would pick the default token)
    expect((await call('report_progress', { message: 'x' }, 'abc')).statusCode).toBe(401);
    const unknown = await call('report_progress', { message: 'x' }, 'f'.repeat(64));
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual({ error: 'Accesso al bridge non valido' });
    expect((await call('report_progress', { message: 'x' }, token.toUpperCase())).statusCode).toBe(401);
  });
  it('a token is no longer valid once unregistered', async () => {
    bridge.unregister(token);
    expect((await call('report_progress', { message: 'x' })).statusCode).toBe(401);
  });
  it('turns progress into agent events', async () => {
    expect((await call('report_progress', { message: 'Rendering 9:16' })).json()).toEqual({ ok: true });
    expect(events).toEqual([{ kind: 'progress', text: 'Rendering 9:16' }]);
    expect((await call('report_progress', { message: '' })).statusCode).toBe(400);
    expect((await call('report_progress', { message: 'x'.repeat(301) })).statusCode).toBe(400);
    expect((await call('report_progress', {})).statusCode).toBe(400);
  });
  it('asks the user and answers the permission prompt', async () => {
    const pending = call('approve', { tool_name: 'Bash', input: { command: 'brew install ffmpeg' }, tool_use_id: 't1' });
    await new Promise((r) => setTimeout(r, 20));
    const [req] = approvals.pending();
    expect(req).toMatchObject({ jobId: 'j1', creativeSlug: 'c1', toolName: 'Bash' });
    await approvals.decide(req!.id, 'once');
    expect((await pending).json()).toEqual({ behavior: 'allow', updatedInput: { command: 'brew install ffmpeg' } });
    const denied = call('approve', { tool_name: 'Write', input: { file_path: '/x' }, tool_use_id: 't2' });
    await new Promise((r) => setTimeout(r, 20));
    await approvals.decide(approvals.pending()[0]!.id, 'deny');
    expect((await denied).json()).toEqual({ behavior: 'deny', message: "L'utente ha negato questa azione." });
  });
  it('denies the prompt when the job is cancelled', async () => {
    const pending = call('approve', { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't3' });
    await new Promise((r) => setTimeout(r, 20));
    approvals.cancelJob('j1');
    expect((await pending).json()).toEqual({ behavior: 'deny', message: 'Il lavoro è stato annullato.' });
  });
  it('denies the prompt when nobody answers in time', async () => {
    const quick = new ApprovalBroker({ broadcast: () => {}, timeoutMs: 10 });
    const app2 = Fastify();
    registerBridgeRoutes(app2, { bridge, approvals: quick });
    const res = await app2.inject({ method: 'POST', url: '/api/bridge/approve', payload: { tool_name: 'Bash', input: { command: 'ls' } }, headers: { 'x-motion-studio-bridge': token } });
    expect(res.json()).toEqual({ behavior: 'deny', message: 'Nessuna risposta entro 10 minuti: azione negata.' });
    await app2.close();
  });
  it('validates outputs and reads the brand kit', async () => {
    expect((await call('validate_output', {})).json()).toEqual({ problems: ['Manca il formato X'], outputs: [] });
    expect((await call('read_brand_kit', {})).json().kit.colors[0].hex).toBe('#1E3A5F');
    expect((await call('nope', {})).statusCode).toBe(404);
    expect((await call('constructor', {})).statusCode).toBe(404);
  });
  it('reports a corrupt kit without failing', async () => {
    await writeFile(join(projectDir, 'brand', 'brand-kit.json'), '{oops');
    const body = (await call('read_brand_kit', {})).json();
    expect(body.kit).toBeNull();
    expect(typeof body.error).toBe('string');
  });
  it('refuses tools that are not part of the job kind', async () => {
    const describeToken = bridge.register({ jobId: 'j2', kind: 'describe', projectSlug: 'acme', projectDir, creativeSlug: null, emit: () => {} });
    const res = await call('read_brand_kit', {}, describeToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Strumento non disponibile in questo lavoro' });
    expect((await call('validate_output', {}, describeToken)).statusCode).toBe(403);
    expect((await call('report_progress', { message: 'ok' }, describeToken)).statusCode).toBe(200);
    const consoleToken = bridge.register({ jobId: 'j3', kind: 'console', projectSlug: 'acme', projectDir, creativeSlug: null, emit: () => {} });
    expect((await call('validate_output', {}, consoleToken)).statusCode).toBe(403);
  });
  it('explains that validation is only for creatives when the context has none', async () => {
    const t = bridge.register({ jobId: 'j4', kind: 'creative', projectSlug: 'acme', projectDir, creativeSlug: 'c2', emit: () => {} });
    const res = await call('validate_output', {}, t);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validazione disponibile solo nelle creatività');
  });
});
