import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerMessage } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { runDoctor } from '../src/doctor.ts';
import { buildServer } from '../src/server/app.ts';
import { replyInstruction, setLocale } from '../src/i18n.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let app: FastifyInstance;
let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-srv-'));
  app = await buildServer({ uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')),
    git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
    doctor: async () => [{ id: 'git', label: 'Git', ok: true, required: true, message: 'ok' }],
  });
});
afterEach(async () => { await app.close(); delete process.env.FAKE_CLAUDE_SCENARIO; delete process.env.FAKE_CLAUDE_ARGS_FILE; });

const buildWith = (opts: Partial<Parameters<typeof buildServer>[0]> = {}) => buildServer({ uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
  appConfig: new AppConfigStore(join(base, 'config')),
  git: new Git(),
  runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
  doctor: async () => [],
  ...opts,
});

const setWorkspace = (path = join(base, 'Spazio di lavoro')) =>
  app.inject({ method: 'PUT', url: '/api/workspace', payload: { path } });

describe('workspace', () => {
  it('starts unconfigured and returns 409 for projects', async () => {
    expect((await app.inject('/api/workspace')).json()).toEqual({ path: null, settings: null, error: null });
    const res = await app.inject('/api/projects');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('workspace');
  });
  it('configures a workspace (creating it) and returns settings', async () => {
    const res = await setWorkspace();
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({ maxConcurrentJobs: 2 });
  });
  it('rejects relative paths and files', async () => {
    expect((await setWorkspace('relative/path')).statusCode).toBe(400);
    const file = join(base, 'f.txt');
    await writeFile(file, 'x');
    expect((await setWorkspace(file)).statusCode).toBe(400);
  });
  it('expands ~ to the home folder', async () => {
    const home = process.env.HOME;
    process.env.HOME = base;
    try {
      const res = await setWorkspace('~/Studio');
      expect(res.statusCode).toBe(200);
      expect(res.json().path).toBe(join(base, 'Studio'));
      expect((await stat(join(base, 'Studio', '.studio', 'settings.json'))).isFile()).toBe(true);
    } finally {
      process.env.HOME = home;
    }
  });
  it('reports a configured workspace folder that no longer exists without recreating it', async () => {
    const gone = join(base, 'sparito');
    await new AppConfigStore(join(base, 'config')).setWorkspacePath(gone);
    await app.close();
    app = await buildWith();
    const body = (await app.inject('/api/workspace')).json();
    expect(body).toMatchObject({ path: gone, settings: null, error: { code: 'not-found' } });
    expect(body.error.message).toContain(gone);
    expect(await stat(gone).catch(() => null)).toBeNull();
    expect((await app.inject('/api/projects')).statusCode).toBe(409);
  });
  it('reports corrupt workspace settings as invalid and leaves the file untouched', async () => {
    await setWorkspace();
    const settingsFile = join(base, 'Spazio di lavoro', '.studio', 'settings.json');
    await writeFile(settingsFile, '{corrupt');
    await app.close();
    app = await buildWith();
    const body = (await app.inject('/api/workspace')).json();
    expect(body).toMatchObject({ path: join(base, 'Spazio di lavoro'), settings: null, error: { code: 'invalid' } });
    expect(body.error.message).toContain('settings.json');
    expect(await readFile(settingsFile, 'utf8')).toBe('{corrupt');
  });
  it('validates settings updates', async () => {
    await setWorkspace();
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxConcurrentJobs: 4 } })).json()).toMatchObject({ maxConcurrentJobs: 4 });
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxConcurrentJobs: 0 } })).statusCode).toBe(400);
  });
});

describe('projects', () => {
  it('creates, lists and reads projects', async () => {
    await setWorkspace();
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Lumen Caffè' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().slug).toBe('lumen-caffe');
    expect((await app.inject('/api/projects')).json()).toHaveLength(1);
    expect((await app.inject('/api/projects/lumen-caffe')).json().project.name).toBe('Lumen Caffè');
    expect((await app.inject('/api/projects/nope')).statusCode).toBe(404);
  });
  it('returns 400 for an empty name', async () => {
    await setWorkspace();
    expect((await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '' } })).statusCode).toBe(400);
  });
});

describe('doctor', () => {
  it('returns the checks', async () => {
    expect((await app.inject('/api/doctor')).json()[0]).toMatchObject({ id: 'git', ok: true });
  });
  it('includes the sandbox check from the server sandbox detection', async () => {
    const exec = async () => ({ code: 0, stdout: '1.0.0', stderr: '', notFound: false });
    let calls = 0;
    const other = await buildWith({
      doctor: (extra) => runDoctor({ exec, claudeCommand: ['claude'], sandbox: extra?.sandbox }),
      sandbox: async () => { calls++; return { available: false, reason: 'Mancano bubblewrap e socat' }; },
    });
    const checks = (await other.inject('/api/doctor')).json() as Array<{ id: string; ok: boolean; message: string }>;
    expect(checks.find((c) => c.id === 'sandbox')).toMatchObject({ ok: false, message: 'Mancano bubblewrap e socat' });
    expect(calls).toBe(1);
    await other.close();
  });
});

describe('doctor and the sandbox setting', () => {
  it('reports the sandbox as off when the workspace disabled it, whatever the system supports', async () => {
    const exec = async () => ({ code: 0, stdout: '1.0.0', stderr: '', notFound: false });
    const other = await buildWith({
      doctor: (extra) => runDoctor({ exec, claudeCommand: ['claude'], sandbox: extra?.sandbox }),
      sandbox: async () => ({ available: true, reason: 'Disponibile' }),
    });
    const sandboxCheck = async () => ((await other.inject('/api/doctor')).json() as Array<{ id: string; ok: boolean; message: string }>).find((c) => c.id === 'sandbox');
    expect(await sandboxCheck()).toMatchObject({ ok: true });
    await other.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws-off') } });
    await other.inject({ method: 'PUT', url: '/api/settings', payload: { sandboxMode: 'off' } });
    expect(await sandboxCheck()).toMatchObject({ ok: false, message: 'Isolamento disattivato nelle Impostazioni' });
    await other.close();
  });
});

describe('turns over WebSocket', () => {
  async function connect(): Promise<{ messages: ServerMessage[]; ws: WebSocket }> {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    return { messages, ws };
  }
  const waitFor = async (cond: () => boolean, ms = 5000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('runs a turn and streams job + agent events', async () => {
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages, ws } = await connect();
    const res = await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'ciao' } });
    expect(res.statusCode).toBe(202);
    const jobId = res.json().id;
    await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === jobId && m.job.state === 'succeeded'));
    expect(messages[0]).toMatchObject({ type: 'snapshot' });
    const agentKinds = messages.filter((m) => m.type === 'agent' && m.jobId === jobId).map((m) => (m as any).event.kind);
    // The final usage is re-emitted by the launcher, with per-run values, once the run is over.
    expect(agentKinds).toEqual(['session', 'text', 'result', 'usage']);
    ws.close();
  });
  it('asks the console agent to reply in the language set when the turn was sent', async () => {
    const promptFile = join(base, 'prompts.jsonl');
    process.env.FAKE_CLAUDE_PROMPT_FILE = promptFile;
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages, ws } = await connect();
    setLocale('en');
    try {
      const id = (await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'ciao' } })).json().id;
      setLocale('it');
      await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === id && m.job.state === 'succeeded'));
      const { prompt } = JSON.parse((await readFile(promptFile, 'utf8')).trim().split('\n')[0]!) as { prompt: string };
      expect(prompt).toBe(`ciao\n\n${replyInstruction('en')}`);
    } finally { setLocale('it'); delete process.env.FAKE_CLAUDE_PROMPT_FILE; ws.close(); }
  });
  it('broadcasts a project message when the project is updated', async () => {
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages, ws } = await connect();
    expect((await app.inject({ method: 'PUT', url: '/api/projects/acme', payload: { name: 'Acme 2' } })).statusCode).toBe(200);
    await waitFor(() => messages.some((m) => m.type === 'project' && m.project === 'acme'));
    ws.close();
  });
  it('passes the existing linked codebases read-only to the console, ignoring missing and overlapping ones', async () => {
    process.env.FAKE_CLAUDE_ARGS_FILE = join(base, 'args.json');
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const codebase = await mkdtemp(join(tmpdir(), 'ms-cb-'));
    const projectJson = join(base, 'Spazio di lavoro', 'acme', 'project.json');
    const project = JSON.parse(await readFile(projectJson, 'utf8'));
    await writeFile(projectJson, JSON.stringify({ ...project, linkedCodebases: [{ path: base }, { path: codebase }, { path: join(base, 'manca') }] }));
    const { messages, ws } = await connect();
    const id = (await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'x' } })).json().id;
    await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === id && m.job.state === 'succeeded'));
    const args = JSON.parse(await readFile(join(base, 'args.json'), 'utf8')).args as string[];
    expect(args.filter((a, i) => args[i - 1] === '--add-dir')).toEqual([codebase]);
    expect(args).toContain(`Edit(/${codebase}/**)`);
    expect(args).not.toContain('--allowedTools'); // the console has no default tools
    expect(args).toContain(`Edit(/${join(base, 'Spazio di lavoro', 'acme', '.studio')}/**)`);
    ws.close();
  });
  it('rejects a second concurrent turn on the same project, and cancels a hanging one', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages, ws } = await connect();
    const first = await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'a' } });
    const second = await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'b' } });
    expect(second.statusCode).toBe(409);
    const id = first.json().id;
    await waitFor(() => messages.some((m) => m.type === 'agent' && m.jobId === id));
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel` })).json()).toEqual({ cancelled: true });
    await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === id && m.job.state === 'cancelled'));
    ws.close();
  });
  it('cancels running jobs when the server closes', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages } = await connect();
    const id = (await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'a' } })).json().id;
    await waitFor(() => messages.some((m) => m.type === 'agent' && m.jobId === id));
    const start = Date.now();
    await app.close();
    expect(Date.now() - start).toBeLessThan(3000);
    await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === id && m.job.state === 'cancelled'));
  });
  it('marks the job failed with a readable error when claude crashes', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'crash';
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages, ws } = await connect();
    const id = (await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'a' } })).json().id;
    await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === id && m.job.state === 'failed'));
    const failed = messages.find((m) => m.type === 'job' && m.job.id === id && m.job.state === 'failed');
    expect(failed && failed.type === 'job' && failed.job.error).toContain('boom');
    ws.close();
  });
  it('exposes the job key on the project and the session id on the job', async () => {
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages, ws } = await connect();
    const { jobKey } = (await app.inject('/api/projects/acme')).json();
    expect(jobKey).toBe(`project:${join(base, 'Spazio di lavoro')}:acme`);
    const job = (await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'x' } })).json();
    expect(job.key).toBe(jobKey);
    await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === job.id && m.job.state === 'succeeded'));
    expect(messages.some((m) => m.type === 'job' && m.job.id === job.id && m.job.state === 'running' && m.job.sessionId === 'fake-session-1')).toBe(true);
    expect((await app.inject('/api/jobs')).json()[0]).toMatchObject({ id: job.id, sessionId: 'fake-session-1' });
    ws.close();
  });
  it('validates resumeSessionId', async () => {
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    for (const resumeSessionId of ['--model', 'a b', 'x'.repeat(129), 42]) {
      const res = await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'x', resumeSessionId } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('sessione');
    }
    const ok = await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'x', resumeSessionId: '0b9c-AF12' } });
    expect(ok.statusCode).toBe(202);
  });
  it('rejects an empty prompt with 400', async () => {
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    expect((await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: '  ' } })).statusCode).toBe(400);
  });
});

describe('loopback guard and client errors', () => {
  it('rejects non-loopback Host and Origin headers', async () => {
    expect((await app.inject({ url: '/api/health', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/projects', headers: { origin: 'https://evil.example' }, payload: { name: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/health', headers: { origin: 'not a url' } })).statusCode).toBe(403);
  });
  it('rejects look-alike hosts and origins', async () => {
    for (const host of ['evil.com@127.0.0.1', '127.0.0.1.evil.com', 'localhost.evil.com:4317', '127.0.0.1:4317/x', '127.0.0.1:']) {
      expect((await app.inject({ url: '/api/health', headers: { host } })).statusCode, host).toBe(403);
    }
    for (const origin of ['http://evil.com@127.0.0.1', 'http://127.0.0.1.evil.com', 'file://localhost', 'http://u:p@localhost:5173']) {
      expect((await app.inject({ url: '/api/health', headers: { origin } })).statusCode, origin).toBe(403);
    }
    expect((await app.inject({ url: '/api/health', headers: { host: 'LOCALHOST:4317', origin: 'http://[::1]:4317' } })).statusCode).toBe(200);
  });
  it('replies 404 with an error body for unknown API routes without a web folder', async () => {
    const res = await app.inject('/api/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Non trovato' });
  });
  it('serves the web app for unknown pages and 404 for unknown API routes with a web folder', async () => {
    const webDir = await mkdtemp(join(tmpdir(), 'ms-web-'));
    await writeFile(join(webDir, 'index.html'), '<html>studio</html>');
    await app.close();
    app = await buildWith({ webDir });
    expect((await app.inject('/qualcosa')).body).toContain('studio');
    expect((await app.inject('/api/nope')).json()).toEqual({ error: 'Non trovato' });
  });
  it('accepts loopback hosts and a localhost dev origin', async () => {
    for (const host of ['127.0.0.1:4317', 'localhost:4317', '[::1]:4317']) {
      expect((await app.inject({ url: '/api/health', headers: { host, origin: 'http://localhost:5173' } })).statusCode).toBe(200);
    }
  });
  it('refuses a cross-origin WebSocket upgrade but accepts a local one', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `${address.replace('http', 'ws')}/api/events`;
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { origin: 'https://evil.example' } });
      ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); res.destroy(); ws.terminate(); });
      ws.once('open', () => reject(new Error('should not open')));
      ws.once('error', () => undefined);
    });
    expect(status).toBe(403);
    const ok = new WebSocket(url, { headers: { origin: 'http://localhost:5173' } });
    await new Promise((r) => ok.once('open', r));
    await new Promise((r) => { ok.once('close', r); ok.close(); });
  });
  it('returns 400 for a malformed JSON body', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/workspace', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });
});
