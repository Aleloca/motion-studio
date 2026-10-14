# Motion Studio — Phase 13: Interactive agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- While the agent works, the user can send it a message that reaches the running turn ("Send to agent"), or queue a request for after the turn.
- The user can stop a turn (the session is remembered, so the next turn knows what was stopped) or stop and redirect it with a new message in the same session.
- A fallback path (queue, then cancel and resume) works whenever the installed Claude Code does not support a live behaviour.

**Architecture:**
- **Runner:** `ClaudeCodeRunner` keeps stdin open in stream-json mode and exposes `send(message)` and `interrupt()` on the run handle; stdin closes at the final `result`. A capability probe (`liveInput`, `interrupt`) is cached per CLI version.
- **Core:**
  - live-message routes and the per-creative queue (`creative.json.queued[]`);
  - redirect and stop-with-remembered-session in `creative-turns.ts`;
  - console support;
  - new job events.
- **Web:** active composer during work ("Send to agent" / "Queue for after"), message states, queued list, split Stop button.

**Tech Stack:** TypeScript, Node child processes (existing runner), zod, Fastify, React 19. No new runtime dependencies, and no Agent SDK.

**Spec:** `docs/superpowers/specs/2026-10-14-motion-studio-phase13-interactive-agent-design.md`. Read `docs/agent-backends.md` first.

## Global Constraints

**Process safety.**
- Every child process belongs to the job's process group and is ended by the existing group kill.
- Tests assert there are no leftover PIDs, checking only PIDs the test itself started. Never kill by pattern.
- stdin is never written after it closes or after the process exits: guard and test.

**Fallback.**
- Every live behaviour has a fallback that keeps the user's words: queue for a live message, cancel and resume for an interrupt.
- The doctor and `/api/agent/capabilities` say which path is active.

**User words.**
- Live, queued and redirect messages are user entries in `conversation.jsonl`.
- Repair prompts carry the original request plus every live message of the turn, delimited as the user's words (phase 11 F4).

**Paid actions.**
- Stop cancels every open approval of the job.
- Redirect cancels the open approvals of the job before delivering the message. No spending after a stop.

**Limits:** 4000 chars per message, 10 live messages per turn, 5 queued requests per creative. Pins allowed, no attachments in live messages.

**Compatibility.**
- `creative.json`, `conversation.jsonl` and job events: additive, optional fields.
- Old conversations render unchanged.

**Real folders.** Same rules as phases 10a–12:
- mtimes checked before and after live checks;
- isolation guard on;
- `MOTION_STUDIO_USER_DATA_DIR` for every Electron launch, verified before acting;
- no packaged app launches.

**Process.**
- No push, PR, release or publish.
- Never kill processes by pattern.
- No `git stash`, `git reset`, `git checkout -- <path>`, `git clean`, history rewrites or any command that discards changes: undo with a new commit or by editing the file.
- Commit trailers exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01KxKL6zuy8dbnJieqN1eCNg`
- `pnpm test`, `pnpm typecheck` and `pnpm check:i18n` stay green. Per-file timeouts only.
- Decisions-log entries from 530 on (520–529 are the orchestrator's for this phase).
- On a safety-classifier stop: stop, report, never rephrase around it.

## Review Focus

1. **A message that arrives at the edge of the turn.**
   - Cases: just after the agent's final `result`, while the core runs checks or saves the version, or in the gap between two repair attempts.
   - Expected: never lost, never written to a closed stdin.
     - Between attempts: delivered as part of the next attempt's prompt.
     - After the final attempt: queued as the next request, with the translated notice.
   - Tests in Task 2 using a fake runner with controllable timing.
2. **Stop or redirect while a paid approval is open, or while a long core tool runs** (preview render, generation, font download).
   - Expected:
     - the approval card resolves as cancelled and no provider call starts;
     - the tool's abort signal fires;
     - no child process remains;
     - `work/` is left as it was, and the next attempt's prompt says files may be partial.
   - Tests in Task 2 (approvals) and Task 1 (process group).
3. **A burst of messages.**
   - Cases: 12 live messages in two seconds, a 4001-character message, the same message sent twice by a double click.
   - Expected: limits enforced with translated reasons, idempotency by a client message id, delivery order preserved.
   - Tests in Task 2 and Task 3.
4. **App restart with queued requests or after a stop.**
   - Expected:
     - queued requests are shown and run only on "Run next";
     - the remembered session of a stopped turn is used by the next turn as a fork;
     - a remembered session that no longer exists in Claude Code (a resume error) falls back to the last version's session, with a system note, never a failed turn.
   - Tests in Task 2.
5. **A Claude Code version without live input or interrupt support, or one that changes the protocol.**
   - Expected: the probe marks the capability off, the UI shows "Queue for after" as the only send action and Stop and redirect uses cancel and resume, and nothing hangs waiting for an acknowledgement (timeouts).
   - Tests in Task 1 with fake CLIs for each variant.

---

### Task 0: Spike — what the installed Claude Code does with streaming input and interrupt

**Files:**
- Create: `docs/superpowers/notes/2026-10-14-phase13-stream-input-spike.md`, `scripts/spike/stream-input-probe.mjs` (kept as a dev script, not shipped)

- Use the installed `claude` with haiku and a throwaway config dir: `CLAUDE_CONFIG_DIR` is not the user's, and the working dir is a temp dir in the scratchpad.
- Use cheap prompts, a total budget of about $0.20, and at most 3 sessions per experiment.
- Record the exact stream-json lines sent and received, with timestamps. Redact session ids in the notes, and never put keys in them.
- Experiments:
  1. Keep stdin open after the first user message. While the agent is in a tool call, for example a short `sleep`-free Read loop the prompt asks for, write a second user message. When is it consumed (after the current tool, after the turn's `result`, never)? Does a second `result` follow?
  2. Send a `control_request` with `subtype: 'interrupt'` mid-turn. Record the `control_response`, what `result` follows (subtype or `is_error`), whether the process stays alive for a further user message, and whether the session can be resumed.
  3. Close stdin after the first `result`: the process exits cleanly, and the exit code is recorded.
  4. A user message written after the `result` but before stdin closes: is it processed?
- Conclusion in the notes: which path is primary (live input yes/no, interrupt yes/no), the observed timings, and the exact message shapes Task 1 must use. If the classifier stops any experiment, stop and report; never rephrase.
- [ ] **Step 1.** Run the experiments, write the notes and commit: `docs: phase 13 stream-input and interrupt spike`.

---

### Task 1: Runner — live input, interrupt, capability probe

**Files:**
- Modify: `packages/core/src/agent/{runner.ts,claude-code-runner.ts,claude-stream-parser.ts,launcher.ts}`, `packages/core/src/doctor.ts`
- Create: `packages/core/src/agent/agent-capabilities.ts`, `packages/core/test/fixtures/fake-claude-stream.mjs`
- Test: `packages/core/test/{claude-runner-live-input,claude-runner-interrupt,agent-capabilities}.test.ts`

**Interfaces:**
```ts
// runner.ts
export interface AgentRunHandle {
  done: Promise<AgentRunResult>;
  cancel(): void;
  killGroup?(): void;
  /** Writes a user message into the running session. Resolves 'written' or 'closed' (stdin already closed or the process gone): never throws. */
  send?(msg: { text: string; clientId: string }): Promise<'written' | 'closed'>;
  /** Asks the CLI to stop the current step. Resolves 'interrupted' on ack, 'unsupported' or 'timeout' (5 s): never throws. */
  interrupt?(): Promise<'interrupted' | 'unsupported' | 'timeout'>;
}
// AgentEvent additions: { kind: 'user_message_delivered'; clientId: string } | { kind: 'interrupted' }
// agent-capabilities.ts
export interface AgentCapabilities { cliVersion: string | null; liveInput: boolean; interrupt: boolean; checkedAt: string }
export function capabilitiesFor(version: string | null): AgentCapabilities; // table from the Task 0 notes, keyed by min version; unknown version = both false
// GET /api/agent/capabilities -> AgentCapabilities
```
- Keep stdin open after the first message. Close it on the final `result` (or on cancel). `send` after close resolves `'closed'`.
- Delivery: emit `user_message_delivered` when the CLI shows it consumed the message, using the evidence identified in Task 0 (for example the echo or the next assistant event after the write). If Task 0 shows there is no reliable evidence, emit it on write and name it "sent" in the UI.
- Interrupt: write the `control_request` shape from Task 0 and await the matching `control_response` by `request_id` with a 5 s timeout. If the capability is off, resolve `'unsupported'` without writing.
- Doctor: show "Live messages: supported / queued only" and "Interrupt: supported / stop and resume".
- The fake CLI (`fake-claude-stream.mjs`) has modes: consumes mid-turn, consumes only after result, ignores, interrupt ack, interrupt no ack, exits early, spawns a child that ignores SIGTERM. It is used in all tests, so there is no real `claude` in tests.

- [ ] **Step 1. Failing tests:**
  - every fake mode;
  - no write after close (spy on the stream);
  - interrupt timeout;
  - unknown version means both capabilities off;
  - no orphan PIDs: the test records the PIDs it started and checks them after `done`;
  - the existing runner tests stay green.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): live input and interrupt in the Claude Code runner`.

---

### Task 2: Core — live messages, queue, stop with remembered session, redirect

**Files:**
- Modify: `packages/core/src/creatives/{creative-turns.ts,prompt.ts,creative-store.ts}`, `packages/core/src/server/creative-routes.ts`, `packages/core/src/server/app.ts` (console), `packages/shared/src/{creative.ts,events.ts}`, i18n
- Test: `packages/core/test/{live-messages,turn-queue,stop-redirect,console-live}.test.ts`

**Interfaces:**
```ts
// POST /api/projects/:slug/creatives/:c/messages   { clientId: string (uuid), text: string, pins?: Pin[], mode: 'live' | 'queued' }
//   -> { entry: ConversationEntry; outcome: 'delivered-pending' | 'queued' | 'queued-after-finish' | 'queued-unsupported' }
//   409 'limit' with a translated reason; idempotent on clientId (same response)
// DELETE /api/projects/:slug/creatives/:c/queue/:clientId     PUT same with { text, pins }   (only while queued)
// POST   /api/projects/:slug/creatives/:c/queue/run-next
// POST   /api/jobs/:id/stop       -> { status }           (Stop; replaces the UI use of /cancel, /cancel stays)
// POST   /api/jobs/:id/redirect   { clientId, text, pins? } -> { outcome: 'interrupted' | 'restarted' }
// creative.json additions: queued?: { clientId, text, pins, at }[]; stoppedSession?: { sessionId: string; at: string; jobId: string }
// ConversationEntry user additions: jobId?: string; mode?: 'live' | 'queued' | 'redirect'; clientId?: string; deliveredAt?: string
// JobSummary: liveMessages?: number
```
- Live:
  - while the creative's job runs (and is not finalizing), append the user entry, then call `run.send`;
  - on `'closed'`: if another attempt follows, keep the message for the next attempt's prompt; if it is the last attempt or finalizing, queue it with `queued-after-finish`;
  - with no `send` capability, queue it with `queued-unsupported`.
- Repair prompt: the original request plus the live messages of the turn, in order, delimited as the user's words.
- Queue: when the turn ends, if `queued[0]` exists and the app did not restart since it was queued, start it as a normal turn. After a restart, wait for `run-next`.
- Stop:
  - `approvals.cancelJob`, then `run.cancel()` as today;
  - store `stoppedSession` from the live `JobSummary.sessionId`;
  - the next turn resumes `stoppedSession` with `forkSession: true` and the prompt note from the spec, and clears it when a version is saved;
  - a resume error falls back to the last version's session with a system note (Review Focus 4).
- Redirect:
  - cancel the job's open approvals;
  - abort the job's running core tools through their signals, keeping the job alive;
  - with interrupt support, `run.interrupt()` then `run.send(redirect)`, with the same job and remaining attempts;
  - otherwise cancel the process, then start a new attempt in the same job with `--resume` of the live session (not forked) and the redirect text as the prompt plus the partial-files note.
  - Emit `interrupted`. Write a user entry with mode `redirect`.
- Console: `/api/console/:job/messages` with the same live semantics, and Stop/redirect through the same job routes. No queue for the console.

- [ ] **Step 1. Failing tests:**
  - every outcome above with the fake runner and controllable timing (Review Focus 1);
  - limits and idempotency (Review Focus 3);
  - repair carries the live messages;
  - stop: approval cancelled, no fetch, `stoppedSession` stored and used, resume-error fallback;
  - redirect with an open approval and with a running preview render (abort fired, no PIDs left);
  - restart: the queue is not auto-run, `run-next` works;
  - console live message.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): live messages, request queue, stop with remembered session and redirect`.

---

### Task 3: Web — active composer, message states, queue, Stop menu

**Files:**
- Modify: `packages/web/src/components/Conversation.tsx`, `packages/web/src/api.ts`, `packages/web/src/shell/ActivityCenter.tsx`, console screen, i18n
- Create: `packages/web/src/components/{QueuedRequests.tsx,StopMenu.tsx}`
- Test: `packages/web/test/{composer-live,QueuedRequests,StopMenu,console-live}.test.tsx`

- Composer while busy:
  - the primary action is "Send to agent" (Enter);
  - a split menu offers "Queue for after";
  - with no `liveInput` capability, only "Queue for after", with a one-line explanation.
  - `clientId` is created per message, so a double click sends once.
- Message bubbles show sending, delivered (or sent) and queued, and the `queued-after-finish` notice.
- Queued requests sit in a list above the composer, with edit, remove and drag to reorder (order saved), and "Run next" after a restart.
- The Stop button is a split button:
  - "Stop" asks no confirmation;
  - "Stop and redirect…" focuses the composer in redirect mode, where the send action is "Redirect".
  - The Activity center uses the same Stop menu.
- Esc in the composer while busy does not stop: stopping is always an explicit click.

- [ ] **Step 1. Failing tests:** each state, capability off, double click, queue edit/remove/reorder/run-next, Stop and redirect flow, console.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): talk to the agent while it works, queue requests, stop and redirect`.

---

### Task 4: Live verification and docs

**Files:**
- Create: `docs/superpowers/notes/2026-10-14-phase13-live-checks.md`
- Modify: `README.md`, `docs/agent-backends.md`, `docs/decisions-log.md`

- Throwaway core and userData, `MemoryVault` without keys, haiku, headless Chrome via CDP for the UI. Check the mtimes before and after.
- Checks:
  1. A live message mid-turn ("make the title red") lands in the same version.
  2. Stop, then a new request "continue": the agent refers to the stopped work (remembered session).
  3. Stop and redirect during `preview_frames`: no leftover process (only own PIDs checked), the turn continues.
  4. A message after finish becomes queued and runs next.
  5. A paid approval open, then Stop: no provider call (fake `fetch` injected).
  6. Capability forced off: the fallback paths work.
- [ ] **Step 1.** Run the checks and record results, costs and mtimes.
- [ ] **Step 2.** Docs. Commit: `docs: phase 13 live check and docs`.
