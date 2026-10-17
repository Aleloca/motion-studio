import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AgentEvent, ApprovalRequest, ServerMessage } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { AgentBridge, type BridgeContext } from '../src/bridge/bridge.ts';
import { registerBridgeRoutes } from '../src/bridge/bridge-routes.ts';
import { registerApprovalRoutes } from '../src/server/settings-routes.ts';

// User note 8: the agent's AskUserQuestion reaches a question card (kind `question`), and the answer goes back to Claude Code
// as `allow` with the original input plus `answers` (question text → label(s), several joined with ", ").

let app: FastifyInstance;
let bridge: AgentBridge;
let approvals: ApprovalBroker;
let events: AgentEvent[];
let sent: ServerMessage[];
let projectDir: string;
let abort: AbortController;

const QUESTION = {
  questions: [
    { question: 'Il brief dice circa 30 s, il titolo 12 s: quale durata uso?', header: 'Durata', multiSelect: false,
      options: [{ label: '12 s', description: 'Come nel titolo e nell’obiettivo' }, { label: '30 s', description: 'Come nel brief' }] },
    { question: 'Quali formati aggiorno?', header: 'Formati', multiSelect: true,
      options: [{ label: 'Instagram', description: '1:1' }, { label: 'Story', description: '9:16' }, { label: 'Banner', description: '300×250' }] },
  ],
};

/** A bare server that answers a WorkspaceError with its status, as the core's error handler does. */
const server = () => Fastify().setErrorHandler((e, _req, reply) => reply.status((e as { status?: number }).status ?? 500).send({ error: e.message }));
const register = (o: Partial<BridgeContext> = {}) => bridge.register({ jobId: 'j1', kind: 'creative', projectSlug: 'acme', projectDir, creativeSlug: 'c1', sandboxed: true, autoApproveAtStart: true, emit: (e) => events.push(e), signal: abort.signal, ...o });
let token: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ms-ask-'));
  bridge = new AgentBridge();
  sent = [];
  approvals = new ApprovalBroker({ broadcast: (m) => sent.push(m) });
  events = [];
  abort = new AbortController();
  token = register();
  app = server();
  // Every workspace setting that could approve by itself is on: a question still waits for the user.
  registerBridgeRoutes(app, { bridge, approvals, settings: async () => ({ autoApproveSandboxed: true }) });
  registerApprovalRoutes(app, approvals);
});
afterEach(async () => { await app.close(); approvals.cancelAll(); await rm(projectDir, { recursive: true, force: true }); });

const ask = (input: unknown, t = token) => app.inject({ method: 'POST', url: '/api/bridge/approve', payload: { tool_name: 'AskUserQuestion', input, tool_use_id: 'toolu_q1' } as object, headers: { 'x-motion-studio-bridge': t } });
const pendingQuestion = async (): Promise<ApprovalRequest> => {
  for (let i = 0; i < 100; i++) {
    const p = approvals.pending();
    if (p.length) return p[0]!;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no question card');
};
const answer = (id: string, answers: unknown) => app.inject({ method: 'POST', url: `/api/approvals/${id}/answer`, payload: { answers } as object });

describe('AskUserQuestion through the permission prompt', () => {
  it('shows a question card (no explanation, no "Always", no JSON detail) and answers with the documented shape', async () => {
    const reply = ask(QUESTION);
    const req = await pendingQuestion();
    expect(req).toMatchObject({ kind: 'question', toolName: 'AskUserQuestion', alwaysRule: null, explanation: null, detail: '', toolUseId: 'toolu_q1', title: 'L\'agente ti fa una domanda' });
    expect(req.questions).toEqual(QUESTION.questions);
    // It goes to the clients like any card, so a reload finds it in the snapshot (pending()).
    expect(sent).toContainEqual({ type: 'approval', approval: req });
    const r = await answer(req.id, [{ selected: [0] }, { selected: [2, 0] }]);
    expect(r.statusCode, r.body).toBe(200);
    expect((await reply).json()).toEqual({
      behavior: 'allow',
      updatedInput: { ...QUESTION, answers: { [QUESTION.questions[0]!.question]: '12 s', [QUESTION.questions[1]!.question]: 'Instagram, Banner' } },
    });
    expect(events).toEqual([{ kind: 'question_answered', outcome: 'answered', toolUseId: 'toolu_q1', items: [
      { header: 'Durata', question: QUESTION.questions[0]!.question, answer: '12 s' },
      { header: 'Formati', question: QUESTION.questions[1]!.question, answer: 'Instagram, Banner' },
    ] }]);
    // Never a permission entry.
    expect(events.some((e) => e.kind === 'approval_decided' || e.kind === 'auto_approved')).toBe(false);
  });

  it('"Other": the user\'s own words are the answer (alone for one choice, after the labels for several)', async () => {
    const reply = ask(QUESTION);
    const req = await pendingQuestion();
    expect((await answer(req.id, [{ selected: [], other: '  20 s  ' }, { selected: [1], other: 'anche il reel' }])).statusCode).toBe(200);
    const body = (await reply).json();
    expect(body.updatedInput.answers).toEqual({ [QUESTION.questions[0]!.question]: '20 s', [QUESTION.questions[1]!.question]: 'Story, anche il reel' });
  });

  it('refuses answers that do not fit, and keeps the card pending', async () => {
    void ask(QUESTION);
    const req = await pendingQuestion();
    for (const bad of [
      [{ selected: [0, 1] }, { selected: [0] }], // two choices for a single-choice question
      [{ selected: [0], other: 'x' }, { selected: [0] }], // an option and a text for a single-choice question
      [{ selected: [] }, { selected: [0] }], // nothing chosen
      [{ selected: [0] }, { selected: [3] }], // no such option
      [{ selected: [0] }, { selected: [1, 1] }], // repeated
      [{ selected: [0] }], // one answer for two questions
      [{ selected: [0], label: '<b>' }, { selected: [0] }], // unknown field
      'Instagram',
    ]) {
      expect((await answer(req.id, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(approvals.pending().map((p) => p.id)).toEqual([req.id]);
    // "Allow"/"Always" of a permission card do not answer a question.
    for (const decision of ['once', 'always']) {
      expect((await app.inject({ method: 'POST', url: `/api/approvals/${req.id}`, payload: { decision } })).statusCode).toBe(400);
    }
    expect(approvals.pending()).toHaveLength(1);
  });

  it('"Don\'t answer" denies with a message that lets the agent go on, recorded as a question', async () => {
    const reply = ask(QUESTION);
    const req = await pendingQuestion();
    expect((await app.inject({ method: 'POST', url: `/api/approvals/${req.id}`, payload: { decision: 'deny' } })).statusCode).toBe(200);
    expect((await reply).json()).toEqual({ behavior: 'deny', message: 'L\'utente ha scelto di non rispondere. Prosegui con la scelta più ragionevole e di\' cosa hai deciso.' });
    expect(events).toEqual([{ kind: 'question_answered', outcome: 'deny', toolUseId: 'toolu_q1', items: QUESTION.questions.map((q) => ({ header: q.header, question: q.question })) }]);
  });

  it('a stop of the turn cancels it, and so does the timer (same rules as a permission card)', async () => {
    const reply = ask(QUESTION);
    await pendingQuestion();
    approvals.cancelJob('j1');
    expect((await reply).json()).toMatchObject({ behavior: 'deny' });
    expect(events.at(-1)).toMatchObject({ kind: 'question_answered', outcome: 'cancelled' });
    expect(approvals.pending()).toEqual([]);

    await app.close();
    approvals = new ApprovalBroker({ broadcast: () => {}, timeoutMs: 50 });
    app = server();
    registerBridgeRoutes(app, { bridge, approvals });
    registerApprovalRoutes(app, approvals);
    const expired = await ask(QUESTION);
    expect(expired.json()).toEqual({ behavior: 'deny', message: 'Nessuna risposta entro 10 minuti. Prosegui con la scelta più ragionevole e di\' cosa hai deciso.' });
    expect(events.at(-1)).toMatchObject({ kind: 'question_answered', outcome: 'expired' });
  });

  it('a job already stopped gets no card', async () => {
    abort.abort();
    expect((await ask(QUESTION)).json()).toMatchObject({ behavior: 'deny' });
    expect(approvals.pending()).toEqual([]);
  });

  it('an input that is not a valid question is denied without a card (no generic "Use AskUserQuestion" card)', async () => {
    const long = 'x'.repeat(4001);
    for (const input of [
      {},
      { questions: [] },
      { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'Solo', description: '' }] }] },
      { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'A' }, { label: 'A' }] }] },
      { questions: [{ question: long, header: 'H', options: [{ label: 'A' }, { label: 'B' }] }] },
      { questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }, { question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] },
      { questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: 'yes' }] },
    ]) {
      expect((await ask(input)).json(), JSON.stringify(input).slice(0, 80)).toEqual({ behavior: 'deny', message: 'Richiesta non valida.' });
    }
    expect(approvals.pending()).toEqual([]);
  });

  it('turns that may not ask anything keep refusing it without a card', async () => {
    for (const kind of ['localize', 'variant-directions'] as const) {
      const t = register({ kind });
      expect((await ask(QUESTION, t)).json()).toMatchObject({ behavior: 'deny' });
    }
    expect(approvals.pending()).toEqual([]);
  });

  it('an answer only adds `answers`: everything else the agent sent goes back untouched, and a look-alike name is a permission', async () => {
    const input = { ...QUESTION, metadata: { source: 'agent' } };
    const reply = ask(input);
    const req = await pendingQuestion();
    await answer(req.id, [{ selected: [1] }, { selected: [0] }]);
    const out = (await reply).json();
    expect(out.updatedInput).toEqual({ ...input, answers: expect.any(Object) });
    // `askuserquestion` is not the built-in tool: an ordinary permission card.
    const other = app.inject({ method: 'POST', url: '/api/bridge/approve', payload: { tool_name: 'askuserquestion', input: QUESTION, tool_use_id: 't2' }, headers: { 'x-motion-studio-bridge': token } });
    const card = await pendingQuestion();
    expect(card.kind).toBe('tool');
    expect(card.questions).toBeUndefined();
    await approvals.decide(card.id, 'deny');
    await other;
  });
});
