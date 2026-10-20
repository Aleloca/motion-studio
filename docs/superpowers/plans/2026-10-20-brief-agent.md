# Brief with the agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** on "Nuova creatività" the user opens a read-only Claude Code session in a glass chat panel, links local folders and library assets, and the agent fills the real NewCreative form (never creating anything); Genera / Salva bozza hand the conversation and the agent's memory to the new creative; later, every chat in the app takes the same glass look.

**Architecture:** a new agent job kind `brief` (policy: read-only, codebase secrets scan, no Bash/Grep/Edit, no paid tools) run by a `BriefSessionService` in the core, one open session per project, persisted in the core's config folder (out of git and of the agent's reach) with a `ConversationEntry` log so `<Conversation>` renders it unchanged. The agent writes the form only through two MCP tools (`list_formats`, `fill_brief`); the core never overwrites fields the user edited. The create route takes the session id, copies its log into the creative's chat and stores the brief's Claude session in the creative's side state, so the first turn (or the group coordinator) resumes it as a fork, with a digest fallback.

**Tech Stack:** TypeScript, Fastify (core), zod (shared), React 19 + Vitest/jsdom (web), the project's real-Chrome layout harness, the `studio` MCP server (`server.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-20-brief-agent-design.md` (approved prototype: artboard A, `Main.dc.html`; its values are copied below where a task needs them).

## Global Constraints

- Three phases, three branches, merged in order: Phase 1 `feat/brief-agent-core` (Tasks 1–9), Phase 2 `feat/brief-agent-web` (Tasks 10–15), Phase 3 `feat/chat-glass` (Tasks 16–17). Each builder works only in its own worktree, branched from `main` after the previous phase merged.
- Agent jobs only through `AgentLauncher.start` and `buildAgentPolicy`; app actions only as `studio` MCP tools served by `/api/bridge/<tool>`.
- Tests: fake agent only (`ControlledRunner`, `buildServer` on a temp workspace, `MemoryVault`, temp `MOTION_STUDIO_CONFIG_DIR` under the scratchpad); never the real `claude`, the app, a paid provider or the keychain. Real Chrome only through the project harness with `MS_REQUIRE_CHROME=1`.
- Run only the task's test files plus `pnpm -r typecheck` and `pnpm -s check:i18n` (`pnpm vitest run <file>`); never the full suite.
- Every UI and agent-visible core string in `packages/shared/src/i18n/en.ts` and `it.ts`; Italian copy is the prototype's, verbatim, where this plan quotes it.
- Motion only through `packages/web/src/motion` (WAAPI helpers) or CSS transitions written with the tokens `--d-*` / `--e-*`; the global `prefers-reduced-motion` rule in `theme.css` then makes them instant. No literal colors (the `no-literal-colors` test).
- Copy and sizes from the spec: panel 448 px wide, inset 12 px, radius 20; form card inset 12 px, radius 16, 1 px line; brief column 380 px open / 480 px closed; footer a floating card inset 12 px, radius 16, height 64; composer box padding 12/10/10/14, gap 10, radius 16; context row 10 px below the composer; open: space first (480 ms `--e-out`), panel from −32 px, scale .98→1, delayed 0.6 × `--d-s`; close: panel first (`--e-in`), space after 0.6 × `--d-s`; fill glow 1.6 s `--e-std`; tile spring `--d-l` `--e-spring`; Genera: form recedes (scale .98, fade, 320 ms `--e-in`), panel moves (480 ms `--e-out`), canvas after 0.6 × `--d-s`, boards 16 px rise, scale .97, 70 ms apart.
- Commits small; every message ends with exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_019pFVuDZefGiQPfptrkkr1A`
- Decisions 1410–1424 in `docs/decisions-log.md`, appended in order, Italian, format of the last entries (`1409. 🟢 **Titolo (decisione: …).** testo *Costo cambio:* …`): 1410–1423 by Task 9, 1424 by Task 17. No other numbers.
- Before finishing a phase: the personal-data scan of the diff (patterns in the builder rules file) finds nothing; tree clean.

## Review Focus

1. **A user edit racing an agent write** (the user types in a field while `fill_brief` is in flight, before the debounced form save reaches the core): the user's text must win on screen and in the next snapshot. Pinned by Task 12 test "a fill never replaces a field edited locally since the last save" and Task 6 test "fill after PUT form keeps the field".
2. **Genera or Salva bozza while the brief agent works, or from a second window after the other started over**: no creative is created on a half-moved session, and nothing is lost. Pinned by Task 8 tests `brief-session-busy` / `brief-session-gone` (no creative listed afterwards) and Task 14 "Genera is disabled while the brief job runs".
3. **A message that adds a folder while the agent runs**: the running process cannot read a folder it was not started with, so it must not be delivered live as if it could. Pinned by Task 6 test "a message that adds context is queued, never live".
4. **The brief's Claude session no longer exists when the creative's first turn starts** (aged out, another machine): the turn must still run, from the digest, once. Pinned by Task 8 test "missing brief session: one fresh attempt with the digest and a chat line".
5. **The minimum window width (1024 × 700)**: panel + form + board must fit without horizontal scroll and the board stays usable. Pinned by Task 15 layout test at 1024 × 700 (panel 360 px, board ≥ 280 px).

---

# Phase 1 — core (`feat/brief-agent-core`)

## File Structure (Phase 1)

- Create `packages/shared/src/brief-session.ts` — schemas and types of the session, the form, a fill, the context, the API bodies.
- Modify `packages/shared/src/events.ts` (`JobKind`, `ServerMessage`), `packages/shared/src/creative.ts` (`ConversationEntry` user `context`, system `origin: 'brief'`), `packages/shared/src/render-views.ts` (`briefJobKey`), `packages/shared/src/index.ts`, i18n `en.ts` / `it.ts`.
- Modify `packages/core/src/agent/policy.ts`, `launcher.ts`, `packages/core/src/bridge/bridge.ts`, `bridge-routes.ts`; move `consoleCodebases` from `server/app.ts` to `packages/core/src/codebases.ts` as `agentCodebases`.
- Create `packages/core/src/brief/brief-session-store.ts` (files), `brief-tools.ts` (`list_formats`, `fill_brief` logic), `brief-prompt.ts` (prompts), `brief-session.ts` (`BriefSessionService`: jobs, messages, handoff), `packages/core/src/server/brief-routes.ts` (routes).
- Modify `packages/core/src/server/app.ts` (wiring), `server/creative-routes.ts` (create route handoff), `creatives/creative-side-state.ts` (`briefSession`), `creatives/creative-turns.ts` (first-turn fork), `creatives/group-turn.ts` (coordinator fork), `creatives/prompt.ts` (`briefChat` section), `creatives/creative-store.ts` (batch append), `packages/mcp-studio/src/server.mjs`.
- Docs: `docs/agent-backends.md`, `docs/decisions-log.md`.

### Task 1: Shared types, events and core copy

**Files:**
- Create: `packages/shared/src/brief-session.ts`; Test: `packages/shared/test/brief-session.test.ts`
- Modify: `packages/shared/src/events.ts:86` (`JobKind` + `'brief'`), `events.ts:191-214` (`ServerMessage`), `packages/shared/src/creative.ts:478,489` (entries), `packages/shared/src/render-views.ts:5`, `packages/shared/src/index.ts`, `packages/shared/src/i18n/en.ts`, `it.ts`

**Interfaces:**
- Produces (all exported from `@motion-studio/shared`):
  - `BRIEF_FIELDS = ['goal','message','durationSec','assets','linkedCodebases','notes','formats','variants'] as const`; `type BriefField`.
  - `BRIEF_VARIANTS_MAX = 5`; `BRIEF_MESSAGE_MAX = 10_000`.
  - `briefFormSchema`: `{ goal: string ≤ BRIEF_TEXT_MAX (may be empty), message, notes: string ≤ BRIEF_TEXT_MAX, durationSec: int 1..600 | null, assets: string[] ≤ 200 (each /^assets\//), linkedCodebases: LinkedCodebase[] ≤ 20, formats: string[] ≤ 100 (INSTANCE_ID_RE, unique), variants: int 1..BRIEF_VARIANTS_MAX }`; `type BriefForm`.
  - `briefFillSchema`: strict partial of the form, at least one key, `goal` min 1 after trim, `formats` min 1; `type BriefFill`.
  - `briefContextSchema = { codebases: LinkedCodebase[] ≤ 20, assets: string[] ≤ 200 }`; `type BriefContext`.
  - `briefMessageSchema = { clientId: 1..100, text: ≤ BRIEF_MESSAGE_MAX, context: BriefContext, form: BriefForm, userEdited: BriefField[], mode?: 'live'|'queued' }`; `type BriefMessageInput`.
  - `briefFormSaveSchema = { form: BriefForm, userEdited: BriefField[] }`.
  - `briefQueuedSchema = { clientId, text, at, context: { codebases: string[]; assets: string[] } }`; `type BriefQueued`.
  - `interface BriefSessionView { id: string; createdAt: string; updatedAt: string; context: BriefContext; form: BriefForm; userEdited: BriefField[]; agentFields: BriefField[]; queued: BriefQueued[]; jobId: string | null }`.
  - `type BriefSendResult = { outcome: 'started'; job: JobSummary } | { outcome: 'delivered-pending' | 'queued' }`.
  - `briefJobKey(root, projectSlug) => \`brief:${root}:${projectSlug}\``.
  - `ServerMessage` gains `{ type: 'brief-session'; project: string; sessionId: string; fill?: { written: BriefField[]; kept: BriefField[] }; ended?: true }`.
  - `ConversationEntry` user: `context?: { codebases: string[]; assets: string[] }` (items added with that message); system: `origin?: 'agent' | 'brief'`.
  - Core i18n (`t()`): `jobs.briefLabel({ name })` (it "{name} · brief con l'agente", en "{name} · brief with the agent"); `briefSession.filled({ parts })` (it "Compilato il brief: {parts}", en "Filled in the brief: {parts}"); `briefSession.parts.{ texts, length, assets({count}), codebases({count}), formats({count}), variants({count}) }` (it "testi", "durata", "{count} asset", "{count} codebase", "{count} formati"/"1 formato", "{count} varianti"); `briefSession.keptYours({ fields })` (it " · tenuti i tuoi: {fields}", en " · kept yours: {fields}"); `briefSession.fieldNames.<BriefField>` (it: "Cosa vuoi realizzare", "Messaggio chiave", "Durata dei video", "Asset da usare", "Codebase", "Note per l'agente", "Formati", "Varianti"); `briefSession.creativeStarts({ title, formats })` (it "{title} · {formats}. La sessione del brief resta qui sopra.", en "{title} · {formats}. The brief session stays above."); `briefSession.memoryUnavailable` (it "La memoria della sessione del brief non è più disponibile: l'agente riparte dal suo riassunto."); `errors.briefSessionGone`, `errors.briefSessionBusy`, `errors.briefUnknownFormat({ id })`, `errors.briefIdentityFormat({ id })`, `errors.briefAssetOutside({ path })`, `errors.briefCodebaseOutside({ path })`, `errors.briefFillLimit({ max })`; `approvals.briefReadOnly` (it "L'agente del brief legge solo le cartelle collegate e il progetto: nient'altro si può approvare.").

- [ ] **Step 1: Write the failing tests** in `packages/shared/test/brief-session.test.ts`:
  - `briefFillSchema` accepts `{ goal: 'Lancio', formats: ['instagram-post-1x1'] }`; refuses `{}`, `{ goal: '  ' }`, `{ formats: [] }`, `{ variants: 6 }`, `{ durationSec: 0 }`, `{ formats: ['a','a'] }`, `{ extra: 1 }` (strict).
  - `briefFormSchema` accepts an empty goal and `durationSec: null`; refuses an asset path not under `assets/`.
  - `briefJobKey('/w', 'acme') === 'brief:/w:acme'`.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/test/brief-session.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the schemas and types above; extend `JobKind`, `ServerMessage`, `ConversationEntry`; add the i18n keys (both languages, same shape).
- [ ] **Step 4: Run** the test, `pnpm -r typecheck` (fix exhaustive `JobKind` switches the compiler names, mapping `brief` like `console`), `pnpm -s check:i18n` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): brief session schemas, job kind and events`.

### Task 2: The `brief` policy, launcher and bridge rules

**Files:**
- Modify: `packages/core/src/agent/policy.ts:16,107-161`, `packages/core/src/agent/launcher.ts:32-46,95,237,268-282,301-306,378`, `packages/core/src/bridge/bridge.ts` (`BridgeContext.briefScope`), `packages/core/src/bridge/bridge-routes.ts:46-51,140-160`, `packages/core/src/codebases.ts` (`agentCodebases` moved from `server/app.ts:202`, `app.ts` imports it)
- Test: `packages/core/test/policy.test.ts`, `packages/core/test/bridge-routes.test.ts`, `packages/core/test/launcher.test.ts`

**Interfaces:**
- Produces: `AgentJobKind` + `'brief'`; `MCP_TOOLS.brief = ['report_progress', 'read_brand_kit', 'list_formats', 'fill_brief']`; `BRIEF_TOOLS = ['list_formats', 'fill_brief'] as const` (launcher.ts); `interface BriefScope { root: string; projectSlug: string; projectDir: string; sessionId: string }`; `BridgeContext.briefScope?: Readonly<BriefScope>` (frozen in `register`), `LaunchInput.briefScope?`; `agentCodebases(list: LinkedCodebase[], forbidden: string[]): Promise<{ paths: string[]; ignored: string[] }>`.
- Policy for `brief` (decision 1421): `disallowedTools` += `readOnlyRules(codebases)`, every editing tool on the codebases, `secretReadRules` per codebase, Read denies on the secrets found (as brand analysis), and `['Edit','Write','MultiEdit','NotebookEdit','Bash','Grep','WebFetch','WebSearch']`; `allowedTools` = `codebaseReadAllowRules(codebases)` + MCP tools only (no project "Always" rules); sandbox: no network, `autoAllowBashIfSandboxed: false`, the secrets in `denyRead`; `SANDBOXED_TOOLS.brief = LEGACY_TOOLS.brief = []`.
- Launcher: the secrets scan runs for `brief` with codebases too; `LIVE_JOB_KINDS` + `'brief'`; the usage tracker records `brief` runs as kind `'creative'` with `creativeSlug: null`; `briefScope` passed to the bridge only for `brief`.
- Bridge `approve`: `AskUserQuestion` keeps the question path for `brief`; any other tool of a `brief` job is denied without a card with `approvals.briefReadOnly`; `sameConditions` never auto-approves for `brief`.

- [ ] **Step 1: Write the failing tests**
  - `policy.test.ts` "brief: read-only codebases with the secrets scan, no Bash/Grep/Edit, no network": with `kind: 'brief', codebases: ['/c/app'], codebaseSecrets: { files: ['/c/app/.env'], dirs: [] }` expect `disallowedTools` ⊇ `['Bash','Grep','Edit','Write','WebFetch','Read(//c/app/.env)']`, `allowedTools` = `['Read(//c/app/**)','Glob(//c/app/**)', ...mcpTools]` (no `projectAllowRules`), `settings.sandbox.network` undefined, `autoAllowBashIfSandboxed` false, `denyRead` ⊇ `['/c/app/.env']`, `addDirs` = `['/c/app']`.
  - `bridge-routes.test.ts` "a brief job asks questions but gets nothing approved": with a registered `kind: 'brief'` context, `approve` with `AskUserQuestion` reaches `approvals.request` with `kind: 'question'`; `approve` with `Read` of `/etc/hosts` answers `{ behavior: 'deny', message: t().approvals.briefReadOnly }` and creates no approval; `generate_image` with the brief token → 403.
  - `launcher.test.ts` "a brief launch scans the codebases for secrets and registers its scope": a codebase holding `.env` → the run's `disallowedTools` contain its Read deny; the bridge context resolved from the run's token has `briefScope.sessionId` and `kind: 'brief'`; the run gets `capabilities` when the version and settings allow (live kind).
- [ ] **Step 2: Run** the three files — Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces (generalise the `brandCodebases` condition to `scansSecrets = (kind === 'brand-analysis' || kind === 'brief') && codebases.length > 0`, keeping brand analysis's own website rule untouched).
- [ ] **Step 4: Run** the three files and `policy.test.ts`'s existing cases, `pnpm -r typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): the brief job kind is read-only with the codebase secrets scan`.

### Task 3: Brief session storage

**Files:**
- Create: `packages/core/src/brief/brief-session-store.ts`; Test: `packages/core/test/brief-session-store.test.ts`

**Interfaces:**
- Produces `class BriefSessionStore`:
  - `constructor(configDir: string | null)` (null: memory only; `assertNotRealUserData(configDir)` like `CreativeSideStateStore`).
  - Layout (decision 1421): `<configDir>/brief-sessions/<sha256(realpath(projectDir)).slice(0,32)>/session.json` and `conversation.jsonl`; folders 0700, files 0600, atomic writes (tmp + rename), reads through `readRegularFile` (4 MiB cap for the JSON).
  - `type BriefSessionFile = { schemaVersion: 1; id: string (uuid); createdAt; updatedAt; context: BriefContext; form: BriefForm; userEdited: BriefField[]; agentFields: BriefField[]; claudeSessionId?: string; queued: BriefQueued[]; handingOff?: true }`.
  - `open(projectDir): Promise<BriefSessionFile | null>`; `create(projectDir, init: { form: BriefForm; userEdited: BriefField[] }): Promise<BriefSessionFile>` (returns the open one if any); `update(projectDir, id, fn: (s: BriefSessionFile) => Partial<BriefSessionFile>): Promise<BriefSessionFile>` (throws `CodedError(409, errors.briefSessionGone, 'brief-session-gone')` when `id` is not the open one); `append(projectDir, id, entry: ConversationEntry)`; `conversation(projectDir, id): Promise<ConversationEntry[]>` (via `parseConversation`); `remove(projectDir, id)`.
  - One `KeyedMutex` per project key serialises every call.

- [ ] **Step 1: Write the failing tests**: create → open returns it; a second create returns the same id; update with a stale id → 409 `brief-session-gone`; append three entries → `conversation` returns them in order with their `at`; remove → open null and the folder is gone; files are mode 0600 and the folder 0700; memory-only mode (`null`) writes nothing under the config dir; a corrupt `session.json` → `open` throws (never silently a new session).
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/brief-session-store.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `BriefSessionStore`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): brief sessions kept in the config folder`.

### Task 4: `list_formats` and `fill_brief` (validation and the no-overwrite rule)

**Files:**
- Create: `packages/core/src/brief/brief-tools.ts`; Test: `packages/core/test/brief-tools.test.ts`

**Interfaces:**
- Consumes: `briefFillSchema`, `BriefSessionFile`, `FormatPreset`, `formatLabel`.
- Produces:
  - `listFormats(presets: FormatPreset[], locale: Locale): { formats: Array<{ id: string; label: string; channel: string; kind: 'video'|'image'; width: number; height: number; maxDurationSec?: number }> }` — every catalog preset except identity ones (`p.identity`), catalog order.
  - `applyFill(s: Pick<BriefSessionFile,'form'|'userEdited'|'agentFields'|'context'>, raw: unknown, presets: FormatPreset[]): { form: BriefForm; written: BriefField[]; kept: Array<{ field: BriefField; reason: 'user-edited' }>; agentFields: BriefField[] }`.
  - Rules: parse with `briefFillSchema` (zod issues → `CodedError(400, …)` naming the field); each `formats` id must be a non-identity preset id of the catalog (else `briefUnknownFormat` / `briefIdentityFormat`); each asset must be in `context.assets ∪ form.assets` (else `briefAssetOutside`); each codebase path in `context.codebases ∪ form.linkedCodebases` paths (else `briefCodebaseOutside`); a field in `userEdited` is not changed and is listed in `kept` (list fields are whole: `assets`, `linkedCodebases`, `formats`); written fields join `agentFields` (deduplicated); nothing is changed when any check fails.
  - `fillLine(written: BriefField[], kept: BriefField[], form: BriefForm): string` — `t().briefSession.filled({ parts })` + `keptYours` when `kept` is not empty; parts in field order: `texts` (any of goal/message/notes once), `length`, `assets({count})`, `codebases({count})`, `formats({count})`, `variants({count})`, joined with ", " (prototype: "Compilato il brief: testi, durata, 3 asset, 2 codebase, 4 formati").

- [ ] **Step 1: Write the failing tests** (`brief-tools.test.ts`):
  - `listFormats` lists `instagram-post-1x1` with its label, leaves out `identity-logo`.
  - `applyFill` writes goal + formats: `written` `['goal','formats']`, `agentFields` the same, `kept` `[]`.
  - goal in `userEdited` → form goal unchanged, `kept` `[{ field: 'goal', reason: 'user-edited' }]`, message (not edited) written.
  - `assets` in `userEdited` → a fill with one context asset keeps the whole list.
  - unknown preset `nope-1x1` → 400 `briefUnknownFormat({ id: 'nope-1x1' })` and form unchanged; `identity-logo` → `briefIdentityFormat`; asset `assets/other.png` outside context and form → `briefAssetOutside`; codebase `/x` outside → `briefCodebaseOutside`.
  - `fillLine(['goal','message','durationSec','assets','linkedCodebases','formats'], [], form with 3 assets, 2 codebases, 4 formats)` in `it` === `'Compilato il brief: testi, durata, 3 asset, 2 codebase, 4 formati'`; with `kept ['goal']` ends with `' · tenuti i tuoi: Cosa vuoi realizzare'`.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/brief-tools.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `brief-tools.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): fill_brief validation and the user's fields are never overwritten`.

### Task 5: The brief prompt

**Files:**
- Create: `packages/core/src/brief/brief-prompt.ts`; Test: `packages/core/test/brief-prompt.test.ts`

**Interfaces:**
- Produces:
  - `buildBriefPrompt(i: { locale: Locale; projectName: string; codebases: Array<{ path: string; note?: string }>; missingCodebases: string[]; projectCodebases: string[]; assets: string[]; form: BriefForm; userEdited: BriefField[]; request: string; digest?: string }): string` — the first run of a session (and the fresh restart after a lost session, with `digest`).
  - `briefFollowUp(i: { form; userEdited; codebases; missingCodebases; assets; request: string }): string` — a later turn or a live message (the agent learns the current form and context with every message, spec §5.2/§5.4).
- Content (English, tested by substring): the role ("You help the user write the brief of a new creative in Motion Studio"); `## Brief fields` (goal, key message shown on screen, video length 1–600 s, assets = project library paths, linked codebases with a note on what each is for, notes for the agent, formats = preset ids from `list_formats` only, variants 1–5 only when the user asks); `## The user's form now` (each field as `quotePromptString`, user-edited ones suffixed `(the user's: never change it)`); `## Reference codebases (read-only)` with `- <path>: not available in this turn` for missing ones (as `prompt.ts:194-197`) and project codebases listed as "already linked to the project: do not add them"; `## Attached assets`; rules: write only with `fill_brief` (partial, repeatable), ask short choices with AskUserQuestion, never create, render or generate anything, never say the creative exists, end by telling the user to review the fields and press Genera; the user's words inside `USER_REQUEST_OPEN/CLOSE` with `defuseTags`; `replyInstruction(locale)` last; `digest` under `## The session so far`.

- [ ] **Step 1: Write the failing tests**: contains `'list_formats'`, `'fill_brief'`, `'never create'` (case-insensitive), `'AskUserQuestion'`; a user-edited goal line ends with `(the user's: never change it)`; missing `/gone` → `- /gone: not available in this turn`; a request holding `</user_request>` is defused; ends with `replyInstruction('it')`; `briefFollowUp` repeats the form section and the request, not the role.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/brief-prompt.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** both builders.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): the brief agent's prompt`.

### Task 6: `BriefSessionService`, routes and events

**Files:**
- Create: `packages/core/src/brief/brief-session.ts`, `packages/core/src/server/brief-routes.ts`; Test: `packages/core/test/brief-session.test.ts`
- Modify: `packages/core/src/server/app.ts` (construct the store and service after `turns`, register routes, add `...briefSessions.tools()` to `extraTools`)

**Interfaces:**
- Consumes: Tasks 1–5; `JobQueue`, `AgentLauncher`, `LiveSession` / `newLiveMessage` / `AnswerCache`, `resolveBrandCodebase` + `codebaseProblemText`, `agentCodebases`, `resumeErrorOf`, `groupDigest`, `FormatCatalog`.
- Produces `class BriefSessionService`:
  - `constructor(deps: { queue; launcher; store: BriefSessionStore; broadcast(m: ServerMessage): void; presets(): Promise<FormatPreset[]>; model(): Promise<string | null | undefined> })`.
  - `type BriefProjectRef = { root: string; projectSlug: string; projectDir: string; projectName: string; projectCodebases: LinkedCodebase[]; configDir: string }`.
  - `view(ref): Promise<BriefSessionView | null>`; `conversation(ref, id): Promise<ConversationEntry[]>`; `start(ref, init: { form; userEdited }): Promise<BriefSessionView>`; `send(ref, id, m: BriefMessageInput): Promise<BriefSendResult>`; `saveForm(ref, id, f): Promise<void>`; `setContext(ref, id, c: BriefContext): Promise<BriefSessionView>`; `removeQueued(ref, id, clientId): Promise<BriefSessionView>`; `discard(ref, id): Promise<void>`; `tools(): Record<'list_formats' | 'fill_brief', BridgeHandler>`; Task 8 adds `claim` / `release` / `handOff`.
- Routes (`registerBriefRoutes(app, ctx)`), all 404 for an unknown project, 409 `brief-session-gone` for a stale `:id`:
  - `GET /api/projects/:slug/brief-session` → `BriefSessionView | null`
  - `POST /api/projects/:slug/brief-session` body `briefFormSaveSchema` → 201 `BriefSessionView` (existing one when open)
  - `GET /api/projects/:slug/brief-session/:id/conversation` → `ConversationEntry[]`
  - `POST /api/projects/:slug/brief-session/:id/messages` body `briefMessageSchema` → `BriefSendResult` (202 when started)
  - `PUT /api/projects/:slug/brief-session/:id/form` body `briefFormSaveSchema` → `{ ok: true }`
  - `PUT /api/projects/:slug/brief-session/:id/context` body `briefContextSchema` → `BriefSessionView`
  - `DELETE /api/projects/:slug/brief-session/:id/queue/:clientId` → `BriefSessionView`
  - `DELETE /api/projects/:slug/brief-session/:id` → 204
- Behaviour (decisions 1421–1422):
  - Validation of every context codebase with `resolveBrandCodebase(path, [projectDir, ws.root, configDir])` (400 with `codebaseProblemText`); assets must be `assets/…` regular files inside the project (`safe-read`), else 400.
  - `send` when idle: store the form snapshot and context, append the user entry (`clientId`, `text`, `pins: []`, `attachments: []`, `context` = items added by this message, `jobId`), enqueue job `{ kind: 'brief', key: briefJobKey(root, slug), label: jobs.briefLabel({ name }) }`. The run: `launcher.start({ kind: 'brief', codebases: [...context codebases (validated), ...agentCodebases(project)], briefScope, request: { prompt, resumeSessionId: s.claudeSessionId, forkSession: false, model } })`; first run `buildBriefPrompt`, later ones `briefFollowUp`. Events: broadcast `{ type: 'agent', jobId, event }` and append `{ type: 'agent', at, jobId, event }` (not live `usage`); `session`/`result` ids → `claudeSessionId`. A resume failure (`resumeErrorOf` → not-found/guess) restarts once without resume, with `buildBriefPrompt({ …, digest: groupDigest(entries, { full: true }).text })`.
  - `send` while the job runs: `mode: 'live'`, live input on, a run attached and **no new context items** → write to the run `briefFollowUp(...)` text, `delivered-pending`; otherwise append to `queued` → `queued`. When the job settles (any state but a discard), queued messages start the next turn, all of them joined in one request in order; after a core restart they wait for the next send, which carries them first.
  - Stop is the existing `POST /api/jobs/:id/stop`; no redirect for `brief` (the `/redirect` route keeps answering 409 `redirect-unsupported`).
  - `fill_brief` handler: scope from `c.briefScope` (403 `tool-unavailable` without it or for another kind), 30 calls per job (`errors.briefFillLimit`, 429), session lock, `applyFill`, store `form` / `agentFields`, append `{ type: 'system', level: 'info', origin: 'agent', text: fillLine(...) }`, broadcast `{ type: 'brief-session', project, sessionId, fill: { written, kept } }`, return `{ ok: true, written, kept }`. `list_formats` returns `listFormats(presets, currentLocale())`.
  - `discard` cancels the running job (`queue.cancel`), removes the files, broadcasts `{ type: 'brief-session', …, ended: true }`.

- [ ] **Step 1: Write the failing tests** (`brief-session.test.ts`: `buildServer` on a temp workspace, `ControlledRunner`, bridge origin set, a codebase folder made under the test base with a `.env`; the bridge helper reads the run's token file as in `agent-actions.test.ts`):
  - "one session per project": two POSTs return the same id; GET returns it.
  - "a message starts a read-only brief job": the job has `kind: 'brief'`, `key: briefJobKey(...)`; the run's `addDirs` = [codebase], `disallowedTools` ⊇ `['Bash','Grep','Edit']` and the `.env` Read deny; the prompt contains the request and `## The user's form now`; the conversation holds the user entry with `context.codebases` = [path].
  - "fill_brief fills the form, writes a line and tells the clients": with the run's token `fill_brief { goal, formats: ['instagram-post-1x1'] }` → 200 `{ ok: true, written: ['goal','formats'], kept: [] }`; GET view `form.goal` set and `agentFields` ⊇ goal; a system entry `origin: 'agent'` starting "Filled in the brief" (en test locale); a `brief-session` message with `fill.written` reached the hub (subscribe a fake socket or spy `broadcast`).
  - "fill after PUT form keeps the field": PUT form with `userEdited: ['goal']`, then fill goal → `kept: [{ field: 'goal', reason: 'user-edited' }]`, view goal = the user's text.
  - "the agent gets clear errors": unknown preset → 400 and the error text names it; asset outside context → 400; the 31st call → 429.
  - "only a brief job has these tools": `fill_brief` with a creative turn's token → 403; `generate_image` with the brief token → 403.
  - "a live message goes into the run with the form": with live input on (`claudeVersion: '2.1.301'`), a second message `mode: 'live'` → `delivered-pending`, `run.sent[0].text` contains the request and `## The user's form now`.
  - "a message that adds context is queued, never live": same but with a new codebase in `context` → `queued`; after `run.finish()` a second run starts, resuming the first run's session (`resumeSessionId` = its `sessionId`, `forkSession` false), its prompt holds the queued text and the new folder is in its `addDirs`.
  - "Stop keeps the session": stop the job → state `cancelled`, GET view still there, the next message resumes the same Claude session.
  - "a lost session restarts once from the digest": `runner.missingSessions.add(sessionId)` → the turn's second run has no `resumeSessionId` and its prompt contains `## The session so far` with the earlier user text; a third failure is a failed job, not a loop.
  - "a missing codebase is said, not fatal": remove the folder after it was linked → the next prompt has `- <path>: not available in this turn`.
  - "discard": DELETE while running → job cancelled, GET null; a message with the old id → 409 `brief-session-gone`.
  - "nothing is created": after a whole session with fills, `GET /api/projects/acme/creatives` is `[]` and no job of kind `creative` exists.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/brief-session.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** service, routes and wiring.
- [ ] **Step 4: Run** the file plus `bridge-routes.test.ts`, `console-live.test.ts` (shared live code untouched), `pnpm -r typecheck`, `pnpm -s check:i18n` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): the brief session, its routes and its events` (two commits are fine: service, then routes).

### Task 7: MCP tool definitions

**Files:**
- Modify: `packages/mcp-studio/src/server.mjs` (after `submit_variant_directions`); Test: `packages/mcp-studio/test/server.test.ts`

**Interfaces:**
- `list_formats`: description "Brief sessions only: lists the formats of the catalog the user can pick (id, label, channel, kind, size, max video length). Use only these ids in fill_brief."; input `{}` with `additionalProperties: false`.
- `fill_brief`: description "Brief sessions only: writes fields of the user's New creative form (give only what changes; call it again to change more). Fields the user edited are kept and listed in `kept`: tell the user. Nothing is created: the user reviews and presses Genera."; properties `goal` (minLength 1, maxLength 100000), `message`, `notes` (maxLength 100000), `durationSec` (integer|null, 1..600), `assets` (array of strings, "Project library paths from the attached assets"), `linkedCodebases` (array of `{ path, note }`, `path` required), `formats` (array of strings, minItems 1, "Preset ids from list_formats"), `variants` (integer 1..5, "Only when the user asks for variants"); `additionalProperties: false`, `minProperties: 1`.

- [ ] **Step 1: Write the failing test** "lists list_formats and fill_brief alone for a brief session and forwards fill_brief": `MOTION_STUDIO_TOOLS: 'report_progress,read_brand_kit,list_formats,fill_brief'` → tools/list names `['approve','report_progress','read_brand_kit','list_formats','fill_brief']`, `fill_brief.inputSchema.additionalProperties === false`; a call forwards `{ goal }` to `/api/bridge/fill_brief`; add both to the "describes every tool in English" list.
- [ ] **Step 2: Run** `pnpm vitest run packages/mcp-studio/test/server.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the two definitions.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): list_formats and fill_brief`.

### Task 8: Handoff on create (Genera, Salva bozza, variants, fork with fallback)

**Files:**
- Modify: `packages/core/src/brief/brief-session.ts`, `packages/core/src/server/creative-routes.ts:90,415-464`, `packages/core/src/creatives/creative-side-state.ts` (record + accessors), `packages/core/src/creatives/creative-turns.ts:1076-1090,1134,1386-1404,1522` (first-turn fork), `packages/core/src/creatives/group-turn.ts:378-425,458-462` (coordinator fork), `packages/core/src/creatives/prompt.ts` (`PromptInput.briefChat`), `packages/core/src/creatives/creative-store.ts:427` (`appendConversationEntries`)
- Test: `packages/core/test/brief-handoff.test.ts`, `packages/core/test/prompt.test.ts`

**Interfaces:**
- Consumes: Task 6 service; `CreativeSideStateStore`; `groupDigest`; `singleAgentOn`.
- Produces:
  - `createBody.briefSession?: { id: string; group?: boolean }` (shared `createCreativeBody` type on the web side gets the same field).
  - `BriefSessionService.claim(ref, id): Promise<BriefClaim>` — 409 `brief-session-gone` (not the open one), 409 `brief-session-busy` (its job queued or running); sets `handingOff` so `send` refuses with `brief-session-busy`. `release(claim)` clears it. `handOff(claim, creative: CreativeRef, o: { group: boolean; title: string; formats: string }): Promise<void>` — copies every entry into the creative's conversation in order with its own `at` (stamped `group: true` when `o.group`), appends `{ type: 'system', at: now, level: 'info', origin: 'brief', text: briefSession.creativeStarts({ title, formats }), …(group) }`, writes the side record `briefSession`, removes the session, broadcasts `brief-session` `ended` and `creative`.
  - Side record (decision 1423): `briefSession?: { sessionId: string; at: string; summary: string }` (`summary` = `groupDigest(entries, { full: true }).text`), only when `isSessionId(claudeSessionId)`; accessors `briefResume(projectDir, slug)` and clearing through `update(…, () => ({ briefSession: undefined }))`. Not `creative.resumeFrom`: its `version` must be ≥ 1 and it lives in agent-readable `creative.json`.
  - Create route order: parse → `claim` (before `store.create`, so a refused claim creates nothing) → create (+ core group) → `handOff` with `group = (o.group === true && singleAgentOn(settings)) || groupSize > 1` → start turn / variant run; any throw before `handOff` → `release`. `formats` text = `t().briefSession.parts.formats({ count })`.
  - First creative turn (`CreativeTurnService.run`): when `versions.length === 0`, the job is not a helper (`!this.helpers.has(jobId)`) and the creative is not a sister (`!creative.variantOf`), a `briefSession` resumes as a fork: `resumeSessionId = stopped ?? base ?? brief.sessionId`, `forkSession = true`, `remembered = 'brief'`. On a resume error with `remembered === 'brief'`: clear the side `briefSession`, run again without resume with `briefChat: brief.summary` in the prompt and the chat line `briefSession.memoryUnavailable` (counts as the one fallback, like `stopped`). Cleared when the turn saves a version (with `stoppedSession`).
  - Coordinator (`coordinate`): with no `group.session` and a host `briefSession`, the first run resumes `brief.sessionId` with `forkSession: true`; its first session event writes `group.session` (existing) and clears `briefSession`; a lost session falls back to the existing fresh run with the full digest (which now holds the copied brief chat).
  - `buildCreativePrompt`: `briefChat` → section `## The brief session (summary)` with the text and "The user wrote this brief with an agent in Motion Studio; this is that conversation."

- [ ] **Step 1: Write the failing tests** (`brief-handoff.test.ts`, same server setup as Task 6; groups through `variantApp` with `settings: { singleAgent: true }`):
  - "Genera hands the session to the creative": a brief session with a user message, an agent text and a fill (run finished) → POST create `{ …, generate: true, briefSession: { id } }` → 201; the creative's conversation starts with the copied entries (same `at`, same order), then the `origin: 'brief'` line containing the title; GET brief-session → null; the first creative run has `resumeSessionId` = the brief run's session and `forkSession: true`.
  - "missing brief session: one fresh attempt with the digest and a chat line": `runner.missingSessions` holds the brief session → the creative's second run has no `resumeSessionId`, its prompt has `## The brief session (summary)` with the user's brief text, the chat has `memoryUnavailable`, the side record has no `briefSession`.
  - "Salva bozza moves the session without a turn": `generate: false` → conversation copied, session gone, no job; a later `POST …/turns` with no message starts a run forking the brief session.
  - "variants: one copy in the group chat, only the coordinator forks": create with `briefSession: { id, group: true }`, then `…/variants` (count 3) and `…/variants/run` → the copied entries carry `group: true` and no `variant`; the coordinator's first run resumes the brief session with `forkSession: true`; no helper run resumes it.
  - "a core-made identity group is a group whatever the flag": an identity brief with `concepts: 3` and `briefSession: { id }` (no flag) → copied entries carry `group: true`.
  - "busy or gone: nothing is created": brief job running → 409 `brief-session-busy`; stale id → 409 `brief-session-gone`; in both cases `GET …/creatives` stays `[]` and the session is unchanged.
  - `prompt.test.ts` "a first turn without the brief's memory gets its summary": `briefChat: 'Tu: video di lancio'` → the section and the text are in the prompt.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/brief-handoff.test.ts packages/core/test/prompt.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** both, plus `creative-turns.test.ts`, `group-turn.test.ts`, `creative-routes.test.ts`, `stop-redirect.test.ts` (resume paths), `pnpm -r typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): Genera and Salva bozza carry the brief session into the creative`.

### Task 9: Docs and decisions 1410–1423

**Files:**
- Modify: `docs/agent-backends.md` (the job list at line 47 gains `brief`; a paragraph on its policy, tools and `MCP_TOOLS.brief`), `docs/decisions-log.md`

- [ ] **Step 1: Append decisions 1410–1423** at the end of `docs/decisions-log.md`:
  - 1410–1420: one entry per row of the spec's §2 table, in order, "decisione: utente (prototipo 2026-10-20)", the row's text in Italian, *Costo cambio* per the builder's judgement.
  - 1421 "Un tipo di lavoro `brief`, in sola lettura, una sessione per progetto" (orchestratore (2026-10-20), spec §10.1, §10.2, §10.6): own kind; secrets scan as brand analysis; Read/Glob on the codebases, **Grep denied too** (a content search crosses secret files; the spec said Read/Grep/Glob); project codebases readable and named in the prompt; identity presets left out of `list_formats`; store packs out of scope; sessions in `<config>/brief-sessions/<hash>/`, not `<project>/.studio` (`git add -A` would commit absolute paths, and the folder is out of the agent's reach); usage metered as `creative`.
  - 1422 "Il modulo e la chat del brief" (§10.3, §10.4): per-field ownership; list fields whole; the CTA *moves* the goal text into the composer (goal emptied, not owned); form snapshot with every message and saved (debounced) on change; a message adding context is queued; queued messages start by themselves after the turn (no "Run next", no edit/reorder: brief turns spend nothing paid); no redirect (Stop only); an open idle session at the page's opening asks Riprendi / Inizia da capo, a running one reopens directly; the session is created at the first message.
  - 1423 "Dalla sessione alla creatività" (§10.5, §10.7, §10.8): side record `briefSession` instead of `resumeFrom` (its version must be ≥ 1); fork on the first turn or the coordinator's first run; digest fallback once; group copy stamped `group: true` (with single agent on, or a core group); Salva bozza = same handoff without a turn; Genera / Salva bozza refused while the brief agent works.
- [ ] **Step 2: Update** `docs/agent-backends.md`.
- [ ] **Step 3: Verify** the personal-data scan of the diff (patterns in the builder rules file) prints nothing; `pnpm -s check:i18n` passes.
- [ ] **Step 4: Commit** `docs: brief session backend and decisions 1410-1423`.

---

# Phase 2 — web (`feat/brief-agent-web`)

## File Structure (Phase 2)

- Modify `packages/web/src/api.ts` (brief calls), `eventsReducer.ts` (`briefTicks`, `briefFills`), `App.tsx` (pass `live`, shared element), `shell/TopBars.tsx` (`new-creative` gets the slots), `shell/intents.ts` (`peekFrameOrigin`), `shell/ActivityCenter.tsx` (`brief:` keys), `motion/motion.ts` (`glow`, `tileIn`), `components/Conversation.tsx`, `components/QueuedRequests.tsx`, `components/conversation.css` (`.ms-chat-card`), `screens/NewCreative.tsx`, `screens/newcreative.css`, `screens/CreativeCanvas.tsx`, i18n `en.ts`/`it.ts` (`web.briefSession`), `README.md`, `README.it.md`.
- Create `packages/web/src/shell/sharedElement.ts` (route-pair rule, moved out of `App.tsx`), `packages/web/src/screens/new-creative/briefSessionModel.ts` (pure form logic), `useBriefSession.ts` (session state and calls), `BriefSessionPanel.tsx` (glass panel), `BriefContext.tsx` ("+" menu, pins, context row), `ResumeBriefDialog.tsx`, `briefsession.css`.

### Task 10: API, events and the session hook

**Files:**
- Modify: `packages/web/src/api.ts`, `packages/web/src/eventsReducer.ts`, `packages/web/src/shell/ActivityCenter.tsx:49-76`
- Create: `packages/web/src/screens/new-creative/useBriefSession.ts`
- Test: `packages/web/test/eventsReducer.test.ts`, `packages/web/test/use-brief-session.test.tsx`, `packages/web/test/activity-center.test.tsx`

**Interfaces:**
- `api.getBriefSession(slug): Promise<BriefSessionView | null>`, `startBriefSession(slug, body: { form; userEdited })`, `getBriefConversation(slug, id)`, `sendBriefMessage(slug, id, body: BriefMessageInput): Promise<BriefSendResult>`, `saveBriefForm(slug, id, body)`, `setBriefContext(slug, id, c: BriefContext)`, `removeBriefQueued(slug, id, clientId)`, `discardBriefSession(slug, id)`; `createCreative` body gains `briefSession?: { id: string; group?: boolean }`; `uploadFiles` typed `Promise<{ assets: AssetEntry[] }>` for `'assets'` (the route returns the new entries).
- `EventsState.briefTicks: Record<string, number>` (by project, +1 per `brief-session` message) and `briefFills: Record<string, { sessionId: string; seq: number; written: BriefField[] }>`.
- `useBriefSession(slug, live: EventsState): { session: BriefSessionView | null; entries: ConversationEntry[]; job: JobSummary | undefined; loading: boolean; error: string | null; ensure(init): Promise<BriefSessionView>; send(m): Promise<BriefSendResult>; saveForm(f): void /* debounced 400 ms */; setContext(c): Promise<void>; removeQueued(id): Promise<void>; discard(): Promise<void>; lastFill: { seq: number; written: BriefField[] } | null }` — refetches view + conversation on `briefTicks[slug]` and on the brief job's `job` updates; `job` = the latest `live.jobs` entry with `key === briefJobKey(root, slug)` (root from the project detail's `jobKey`, as other screens derive keys).
- ActivityCenter: `jobPlace` maps `brief:<root>:<project>` to `{ project, creative: null }`; `jobHref` of a `brief` job → `href.newCreative(project)`.

- [ ] **Step 1: Write the failing tests**: reducer — two `brief-session` messages for `acme` → `briefTicks.acme === 2`, a fill message → `briefFills.acme` holds its `written` and an increasing `seq`; hook — a tick refetches (api mock called twice), `saveForm` called three times within 400 ms sends one PUT with the last value, `discard` calls the API and clears `session`; ActivityCenter — a `brief` job row links to `#/projects/acme/new` (whatever `href.newCreative` returns).
- [ ] **Step 2: Run** the three files — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS; `pnpm -r typecheck`.
- [ ] **Step 5: Commit** `feat(web): brief session API, events and hook`.

### Task 11: `<Conversation>` for a brief session

**Files:**
- Modify: `packages/web/src/components/Conversation.tsx`, `packages/web/src/components/QueuedRequests.tsx`, `packages/web/src/components/conversation.css`, i18n
- Test: `packages/web/test/conversation-brief.test.tsx`

**Interfaces:**
- New optional props of `ConversationProps` (absent: the component is exactly as before):
  - `transport?: { start(b: { clientId: string; text: string }): Promise<JobSummary | null>; post(b: { clientId: string; text: string; mode: 'live' | 'queued' }): Promise<{ outcome: LiveMessageOutcome }> }` — replaces `api.sendCreativeTurn` / `api.postLiveMessage` in `Composer`.
  - `composerTop?: ReactNode` (inside `.ms-composer-box`, above the text: the context pins), `composerTools?: ReactNode` (first item of `.ms-composer-foot`: the "+"), `composerBelow?: ReactNode` (after the form: the context row), `composerLabel?: string`, `placeholder?: string`, `draft?: { text: string; nonce: number }` (sets the textarea once per nonce, never sends), `intro?: ReactNode` (a first agent bubble, not an entry), `queueOps?: { remove(clientId: string): Promise<void> }` (QueuedRequests then shows only "remove", no edit / reorder / run next).
  - Rendering: a user entry's `context` as `.ms-msg-pins` chips (folders in `var(--mono)`, assets with their name); a system entry with `origin: 'brief'` as an `ms-convo-version` row: sparkle icon, `<b>{web.briefSession.created}</b>` ("Creatività creata"), the entry text as `ms-convo-version-summary` (no version badge: no version exists yet).
  - `.ms-chat-card` in `conversation.css` (the prototype's `.panel`): `background: var(--glass)`, `backdrop-filter: blur(22px) saturate(1.8)` inside the same `@supports` as `.ms-composer`, shadow `inset 0 0 0 1px var(--glassLine), inset 0 1px 0 var(--glassEdge), 0 24px 60px var(--glassShadow), 0 1px 3px var(--shadow)`, `border-radius: 20px`, `overflow: hidden`; inside it: agent bubbles on `var(--glassField)`, `.ms-composer` without its own frame (transparent, no shadow, no padding, no backdrop), `.ms-composer-box` on `var(--glassField)` with `inset 0 0 0 1px var(--glassLine)`, padding `12px 10px 10px 14px`, gap 10, radius 16.

- [ ] **Step 1: Write the failing tests** (`conversation-brief.test.tsx`, api mocked as in `group-chat-layout.test.tsx`):
  - idle send with `transport` → `transport.start` called with the text, `api.sendCreativeTurn` never; while `job` runs with live input → `transport.post` with `mode: 'live'`; the split menu's "queue" → `mode: 'queued'`.
  - a `brief` job shows Stop without "redirect" (`StopMenu` with `isRedirectable` false).
  - `draft` with nonce 1 fills the textarea; nothing is sent.
  - `intro` renders before the entries; `composerTop` / `composerTools` / `composerBelow` render in their places.
  - a user entry with `context: { codebases: ['/c/app'], assets: ['assets/logo.svg'] }` shows two chips; a system entry `origin: 'brief'` shows "Creatività creata" (it) and its text.
  - `queueOps` → QueuedRequests offers remove only; remove calls `queueOps.remove(clientId)`.
- [ ] **Step 2: Run** `pnpm vitest run packages/web/test/conversation-brief.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement**; i18n `web.briefSession.created`.
- [ ] **Step 4: Run** it plus `conversation.test.tsx`, `composer-live.test.tsx`, `QueuedRequests.test.tsx`, `StopMenu.test.tsx` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the chat takes a brief session (transport, slots, context chips)`.

### Task 12: Form model, agent marks and per-field ownership

**Files:**
- Create: `packages/web/src/screens/new-creative/briefSessionModel.ts`
- Modify: `packages/web/src/screens/NewCreative.tsx`, `packages/web/src/motion/motion.ts`, `packages/web/src/screens/newcreative.css`, i18n
- Test: `packages/web/test/brief-form-model.test.ts`, `packages/web/test/new-creative-agent.test.tsx`, `packages/web/test/motion.test.tsx`

**Interfaces:**
- `briefSessionModel.ts`:
  - `formSnapshot(s: { goal; message; length: LengthChoice; customSec; videos: number; picked: string[]; codebases: LinkedCodebase[]; notes; selected: string[]; variantCount: number }): BriefForm` (`durationSec` null when no video format and no valid length).
  - `lengthOf(durationSec: number | null): { length: LengthChoice; customSec: string }` (6/15/30/60 → preset, else `custom`; same rule as `applyStated`; `LENGTHS` / `LengthChoice` move here from `NewCreative.tsx`).
  - `fieldsToApply(written: BriefField[], userEdited: ReadonlySet<BriefField>): BriefField[]` — `written` minus the locally owned ones.
- `motion.ts`: `glow(el: Element | null): Promise<boolean>` — keyframes from `inset 0 0 0 1px var(--accent), 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent)` to `inset 0 0 0 1px var(--line), 0 0 0 0 transparent`, 1600 ms, `E.std`; `tileIn(el, delay = 0)` — `scale(.94)` → `scale(1.02)` at offset .6 → `none`, `D.l`, `E.spring`.
- NewCreative: `userEdited: Set<BriefField>` and `agentFields: Set<BriefField>` states. Every hand change of a field adds it to `userEdited` and removes it from `agentFields` (goal, message, length / custom seconds, picked assets add/remove, notes, codebases add / remove / note, a format tile, the variants count). On a new `lastFill` (seq): for `fieldsToApply(written, userEdited)` set the state from `session.form`, add to `agentFields`, play `glow` once on the field's box (goal box, message input, length control, notes input) and `tileIn` on newly added asset and format tiles (90 ms apart, prototype). A field in `agentFields` shows `<Pill tone="accent" className="ms-nc-agent">` "Agente" next to its label (18 px high, padding 0 7, 10 px text: prototype `.ag`); the board head shows it when `formats` is the agent's. Every change calls `saveForm(snapshot)` when a session exists.

- [ ] **Step 1: Write the failing tests**:
  - model: `lengthOf(30)` → `{ length: '30', customSec: '' }`, `lengthOf(45)` → `custom`/`'45'`; `formSnapshot` of a state without video formats has `durationSec: null`; `fieldsToApply(['goal','formats'], new Set(['goal']))` → `['formats']`.
  - `new-creative-agent.test.tsx` "an agent fill fills the fields and marks them": a fill tick with `written: ['goal','formats']` and the view's form → goal textarea has the agent's text, the `instagram-post-1x1` tile is pressed, an "Agente" pill sits by "Cosa vuoi realizzare?" and by "Dove verrà pubblicata?", `glow` called once with the goal box (motion module mocked).
  - "a fill never replaces a field edited locally since the last save": type in goal, then a fill writing goal before the debounced PUT → the typed text stays, no pill.
  - "an edit removes the mark and makes the field the user's": edit message after a fill → pill gone; the next `saveBriefForm` and `sendBriefMessage` bodies have `userEdited` ⊇ `['message']`.
  - "one hand change makes a list the user's": remove one picked asset → `userEdited` ⊇ `['assets']`.
  - motion: `glow` / `tileIn` resolve true at once under reduced motion and without an element.
- [ ] **Step 2: Run** the three files — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** them plus `NewCreative.test.tsx`, `variants-new-creative.test.tsx`, `new-creative-duration.test.tsx` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the agent fills the form; the user's edits are theirs`.

### Task 13: The glass panel, the "+" menu, pins and the context row

**Files:**
- Create: `packages/web/src/screens/new-creative/BriefSessionPanel.tsx`, `BriefContext.tsx`, `briefsession.css`
- Test: `packages/web/test/brief-panel.test.tsx`

**Interfaces:**
- `BriefSessionPanel({ slug, live, session: ReturnType<typeof useBriefSession>, snapshot(): { form: BriefForm; userEdited: BriefField[] }, draft?: { text: string; nonce: number }, library: AssetEntry[] | null, onLibraryChanged(): void, projectName: string, panelRef: Ref<HTMLElement> })` — `<aside className="ms-brief-panel ms-chat-card" aria-label="Sessione con l'agente">`: header (24 px avatar on `var(--ink)` with the accent sparkle, `<b>` 14 px "Brief con l'agente", neutral `Pill` with the state: "Nuova sessione" with no user entry, "Al lavoro…" while the brief job is queued or running, "Brief compilato" when `agentFields` is not empty), padding `12px 12px 10px 16px`, bottom line `inset 0 -1px 0 var(--glassLine)`; then `<Conversation>` with `transport` (start = `ensure(snapshot())` then `send({ clientId, text, context: context ∪ pins, ...snapshot(), mode })`), `intro` (it: "Con il + qui sotto collega le cartelle del codice e gli asset che servono, poi raccontami cosa vuoi ottenere. Il brief lo compilo io."), `composerLabel` "Messaggio all'agente", `placeholder` "Chiedi una modifica al brief…" once the session has a message, `queueOps`, approvals filtered by the brief job id.
- `BriefContext.tsx`:
  - `AddContextMenu({ onFolder(path: string): void; onAssets(paths: string[]): void; onUpload(files: File[]): Promise<void> })` — the "+" (`aria-label` "Aggiungi cartelle o asset", `aria-haspopup="menu"`, rotates 45° when open via CSS transition `--d-s` `--e-spring`), a `role="menu"` (`aria-label` "Aggiungi contesto", 300 px, 4 px above the composer) with three `menuitem`s: "Collega una cartella" / "Codice sul tuo Mac, letto in sola lettura"; "Asset dalla libreria" / "Immagini, video e loghi del progetto"; "Carica dal Mac" / "Finisce anche nella libreria del progetto". Folder: `desktop()?.pickFolder(title)`, else an inline path field + "Scegli cartella" as `CodebaseList` does (glob characters refused client-side with the same message; the core checks again at send). Library: the existing picker popover (move NewCreative's picker into a `LibraryPicker` component reused by both, 4-column grid, multi-select). Upload: hidden `<input type="file" multiple>` → `api.uploadFiles(slug, 'assets', files)` → pin `assets/<file>` of each returned entry, `onLibraryChanged()`.
  - `ContextPins({ pins, onRemove })` — `.ms-composer-pins` chips, folders in `var(--mono)` 11.5 px, assets with a 10 px swatch/thumbnail, remove button `aria-label` "Togli {name}".
  - `ContextRow({ context, onRemove })` — 10 px under the composer: two ghost `sm` buttons with a dropdown: "{n} cartella/cartelle" or "Nessuna cartella", "{n} asset" or "Nessun asset"; each lists its items with a remove button → `setContext`.
- Pins live in the panel's state until a send; a send moves them into the session context (cleared on success, kept on failure).

- [ ] **Step 1: Write the failing tests** (`brief-panel.test.tsx`):
  - the menu: "+" → `aria-expanded="true"`, three menu items with the copy above; Escape closes it.
  - folder on desktop: `pickFolder` mock returns `/Users/x/app` → a mono pin "/Users/x/app"; on web: typing a path with `*` shows the glob error and adds nothing.
  - library: choosing two tiles in the picker → two pins.
  - upload: a file → `api.uploadFiles(slug, 'assets', [file])`, its returned entry pinned as `assets/<file>`, `onLibraryChanged` called.
  - send: `sendBriefMessage` body `context.codebases` ⊇ the pinned folder and `context.assets` ⊇ the pinned assets, `form`/`userEdited` from `snapshot()`; pins cleared; on a refused send the pins stay.
  - context row: with 2 folders and 3 assets → "2 cartelle" and "3 asset"; removing one item calls `setBriefContext` without it.
  - state pill: "Nuova sessione" → "Al lavoro…" when the brief job runs → "Brief compilato" after a fill.
- [ ] **Step 2: Run** `pnpm vitest run packages/web/test/brief-panel.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement**; i18n `web.briefSession.*` (it from the prototype; en: "Brief with the agent", "New session", "Working…", "Brief filled in", "Add folders or assets", "Add context", "Link a folder" / "Code on your Mac, read-only", "Asset from the library" / "Images, videos and logos of the project", "Upload from your Mac" / "Also goes into the project library", "Remove {name}", "No folders", "No assets", "Message to the agent", "Ask for a change to the brief…").
- [ ] **Step 4: Run** — Expected: PASS; `pnpm -s check:i18n`.
- [ ] **Step 5: Commit** `feat(web): the brief session panel with the context menu`.

### Task 14: Mode switch, CTA, resume prompt, open/close motion, Genera / Salva bozza

**Files:**
- Create: `packages/web/src/screens/new-creative/ResumeBriefDialog.tsx`, `packages/web/src/shell/sharedElement.ts`
- Modify: `packages/web/src/screens/NewCreative.tsx`, `packages/web/src/screens/newcreative.css`, `packages/web/src/shell/TopBars.tsx:270-272`, `packages/web/src/App.tsx:263,281,289-293`, `packages/web/src/shell/intents.ts:66-75`, `packages/web/src/screens/CreativeCanvas.tsx:362-379`, i18n, `README.md`, `README.it.md`
- Test: `packages/web/test/new-creative-agent.test.tsx`, `packages/web/test/shared-element.test.ts`, `packages/web/test/CreativeCanvas.test.tsx`

**Interfaces:**
- TopBars: `new-creative` renders `CreativeTop` with `slots`; NewCreative claims them (`useBarClaim(routeKey, active)`) and portals into `end` a `Segmented` (`label` "Come compilare il brief", options "Compila tu" / "Con l'agente" with the `sparkle` icon), default "Compila tu".
- CTA in `.ms-nc-goalbar` while in "Compila tu": chip button "Fallo compilare all'agente" (sparkle, `var(--accentText)` on `var(--sel)`, `inset 0 0 0 1px var(--warnLine)`, 26 px high, weight 600). It opens the panel; with goal text, the text becomes the composer `draft`, the goal field is emptied and `goal` leaves `userEdited` (decision 1422).
- Layout (both modes, prototype A): `.ms-nc-body` a card `margin: 12px 12px 0; border-radius: 16px; overflow: hidden; box-shadow: 0 0 0 1px var(--line)`; the footer a card `margin: 12px; border-radius: 16px; border: 0; box-shadow: 0 0 0 1px var(--line), 0 8px 24px var(--shadow)` (row height 64 + 24 margin); brief column `480px` closed, `380px` open. Agent mode (`.ms-nc.ms-nc-agent`): the form area's `left` 472 px (12 + 448 + 12); the panel `position: absolute; left: 12px; top: 12px; bottom: 12px; width: 448px; z-index: 5`, its bottom aligned with the footer card's. Below 1280 px viewport: panel 360 px, form `left` 384 px, brief column 320 px.
- Motion (CSS transitions with tokens): opening — form `left` and `grid-template-columns` `var(--d-l) var(--e-out)` with no delay; panel `opacity var(--d-m) var(--e-std)` and `transform var(--d-l) var(--e-out)` from `translateX(-32px) scale(.98)` to none, both delayed `calc(var(--d-s) * .6)`, `transform-origin: 0 50%`. Closing — panel `var(--e-in)` with no delay, the space after `calc(var(--d-s) * .6)`. The panel stays mounted while closed (`aria-hidden`, `inert`, `pointer-events: none`) so the chat keeps its state.
- Resume prompt: at mount, an open session with at least one user entry and no running brief job → `ResumeBriefDialog` (`Modal`): title "Hai una sessione del brief in corso", body "Puoi riprenderla da dove eri rimasto o ricominciare: la sessione di prima verrà eliminata.", buttons "Riprendi la sessione del brief" (primary) and "Inizia da capo". Riprendi → agent mode, form from `session.form`, `userEdited` / `agentFields` from the view. Inizia da capo → `discard()`, empty form, "Compila tu". A running brief job → agent mode at once, no prompt.
- Genera / Salva bozza: disabled (title "L'agente sta compilando il brief") while the brief job is queued or running; with a session, `createCreative` gets `briefSession: { id, group: variantCount > 1 }`. Genera with the panel open: before `go`, `setFrameOrigin(\`brief-panel:${slug}/${created.slug}\`, panel.getBoundingClientRect())` and `recede(formArea, D.m)` (scale .98, fade, `E.in`); from "Compila tu" today's transition. Salva bozza: today's toast and transition.
- `sharedElement(a: Route, b: Route): PageMode` (moved from `App.tsx`): today's creative↔format pair, plus `new-creative` → `creative` of the same project when `peekFrameOrigin(\`brief-panel:${b.slug}/${b.creative}\`)` is set; `peekFrameOrigin(key): DOMRect | null` reads without taking.
- CreativeCanvas first appearance: `takeFrameOrigin(\`brief-panel:${slug}/${creative}\`)` fresh (≤ `FLIP_WINDOW_MS`) → `flip(panel, rect, D.l)` on `.ms-cv-panel`, its tabs `enter` with `delay: D.m`, the other columns `enter` after `0.6 * D.s`, boards `stagger(els, { y: 16, scale: 0.97, delay: 0.6 * D.s }, 70)`.
- README (en + it): a "Brief with the agent" paragraph under New creative.

- [ ] **Step 1: Write the failing tests**:
  - `new-creative-agent.test.tsx`: the segmented control sits in the bar's end slot with "Compila tu" pressed; "Con l'agente" adds `ms-nc-agent` and un-hides the panel; the CTA with goal "Video di lancio" opens the panel, the composer holds "Video di lancio", the goal field is empty, `sendBriefMessage` not called; resume prompt for an idle open session (Riprendi restores `form.goal` and agent mode; Inizia da capo calls `discardBriefSession` and leaves "Compila tu"); no prompt and agent mode when the brief job runs; "Genera is disabled while the brief job runs"; Genera with a session sends `briefSession: { id: 's1', group: false }`, with Varianti 3 `group: true`; with the panel open `setFrameOrigin` is called with key `brief-panel:acme/<slug>` before navigation, from "Compila tu" it is not; Salva bozza sends `generate: false` with `briefSession`.
  - `shared-element.test.ts`: `new-creative`→`creative` is `'shared'` only while the origin is set; creative↔format unchanged.
  - `CreativeCanvas.test.tsx` "arrives from the brief panel": with a fresh `brief-panel:` origin, `flip` is called with `.ms-cv-panel` and `D.l`, `stagger` with `{ y: 16, scale: 0.97 }` and step 70 (motion mocked); without it, today's `stagger(els, { y: 12 }, 40)`.
- [ ] **Step 2: Run** the three files — Expected: FAIL.
- [ ] **Step 3: Implement**; i18n (en: "How to fill in the brief", "Fill it in yourself", "With the agent", "Let the agent fill it in", "You have a brief session in progress", "You can pick it up where you left off or start over: the previous session will be deleted.", "Resume the brief session", "Start over", "The agent is filling in the brief").
- [ ] **Step 4: Run** them plus `NewCreative.test.tsx`, `top-bars.test.tsx`, `CreativeCanvas.app.test.tsx`, `motion.test.tsx` — Expected: PASS; `pnpm -s check:i18n`.
- [ ] **Step 5: Commit** `feat(web): Con l'agente on Nuova creatività and the handoff to the canvas` (split by concern if large).

### Task 15: Real-Chrome layout checks of the brief screen

**Files:**
- Create: `packages/web/test/brief-agent-layout.test.tsx` (pattern of `group-chat-layout.test.tsx`: markup rendered in jsdom, real stylesheets `theme.css`, `ui/ui.css`, `components/conversation.css`, `screens/newcreative.css`, `screens/new-creative/briefsession.css`, `shell/shell.css`, measured in Chrome; skipped without Chrome unless `MS_REQUIRE_CHROME=1`)

- [ ] **Step 1: Write the tests** (light and dark; times read from computed style, not waited):
  - 1440 × 900, agent mode, filled: panel rect `left 12, top 12 (of the main area), width 448`, `border-radius 20px`; form card `left 472`, radius 16, brief column 380 px; footer card radius 16, `|panel.bottom − footer.bottom| ≤ 1`, footer `left` = form card `left`; composer box padding `12px 10px 10px 14px`, `row-gap 10px`; context row top − composer bottom = 10 ± 1; `document.documentElement.scrollWidth ≤ innerWidth`; no "Agente" pill overflows its label row.
  - 1440 × 900, "Compila tu": panel `opacity 0`, `transform` matrix with tx −32 and scale .98; form card `left 12`; brief column 480 px.
  - transitions: agent mode panel `transition-delay` for `opacity`/`transform` = 120 ms (0.6 × 200) and form `left` delay 0; "Compila tu" the reverse; with `emulateMedia prefers-reduced-motion: reduce` every `transition-duration` ≤ 0.001 ms.
  - 1024 × 700, agent mode: panel width 360, no horizontal scroll, board width ≥ 280, footer buttons fully visible.
- [ ] **Step 2: Run** `MS_REQUIRE_CHROME=1 MOTION_STUDIO_CONFIG_DIR=<scratch>/cfg pnpm vitest run packages/web/test/brief-agent-layout.test.tsx` — Expected: FAIL where the CSS is missing or off, then fix the CSS (Tasks 13–14 files).
- [ ] **Step 3: Run** it again plus `composer-layout.test.tsx`, `top-bars-layout.test.tsx` — Expected: PASS.
- [ ] **Step 4: Commit** `test(web): real-Chrome layout of the brief with the agent`.
- [ ] **Step 5: Phase wrap-up:** `pnpm -r typecheck`, `pnpm -s check:i18n`; the personal-data scan of the diff (patterns in the builder rules file) prints nothing; tree clean. Report under "da verificare a mano dall'utente": the folder picker in the desktop app, upload from the Mac, the backdrop blur over a busy form, the Genera transition at full speed and with the OS reduced-motion switch.


---

# Phase 3 — the glass chat everywhere (`feat/chat-glass`)

## File Structure (Phase 3)

- Modify `packages/web/src/screens/CreativeCanvas.tsx:1082-1090` (the panel aside, also the variant group chat), `screens/canvas.css`, `screens/FormatView.tsx:774-780`, `screens/format.css`, `screens/editor/EditorScreen.tsx:1028-1040`, `screens/editor/editor.css`; reuse `.ms-chat-card` from Task 11.
- Test: `packages/web/test/chat-glass-layout.test.tsx`; existing layout tests must keep passing unchanged.

### Task 16: Glass card in the canvas, format view, editor and group chat

**Interfaces:**
- Each chat aside keeps its grid column (canvas 368 px; format view 320 / 300 below 1180 px; editor 288 or 280 / 320 from 1200 px) and gets `padding: 12px; background: var(--bg)` with one child `div.ms-chat-card` (flex column, `min-height: 0`) holding the tabs (`.ms-tabs` inside the card, its line `var(--glassLine)`) and the panels; the conversation and composer inside follow `.ms-chat-card` rules. The aside's own left border goes (the 12 px of page background separates it). Narrow layouts that stack the panel (`canvas.css:438`, `format.css:158`) keep the card with the same inset.
- No content runs under the card: the column still reserves its width, so fit, zoom and the timeline keep their geometry (decision 1424).

- [ ] **Step 1: Write the failing tests** (`chat-glass-layout.test.tsx`, real Chrome, light and dark):
  - canvas at 1440 × 900: the panel column is 368 px wide; the card is inset 12 px on every side (card width 344), `border-radius 20px`, background `var(--glass)` resolved; the composer has no own shadow (`box-shadow: none`); an agent bubble's background equals `--glassField`; tabs are inside the card.
  - format view at 1440 × 900 (320 column → card 296) and 1100 × 800 (300 → 276); editor video at 1440 × 900 (320 → 296) and 1100 × 800 (288 → 264): same checks, the composer's Send button fully inside the card, no horizontal scroll.
  - the variant group chat (canvas with `single`): same card and the group composer's note fits.
- [ ] **Step 2: Run** `MS_REQUIRE_CHROME=1 MOTION_STUDIO_CONFIG_DIR=<scratch>/cfg pnpm vitest run packages/web/test/chat-glass-layout.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** the wrappers and CSS.
- [ ] **Step 4: Run** it plus `composer-layout.test.tsx`, `group-chat-layout.test.tsx`, `editor-screen-layout.test.tsx`, `canvas-rows-layout.test.tsx`, `variants-layout.test.tsx`, `CreativeCanvas.test.tsx`, `FormatView.test.tsx`, `EditorScreen.test.tsx` — Expected: PASS (the board, stage and timeline rectangles unchanged against `main`).
- [ ] **Step 5: Commit** `feat(web): every chat is a floating glass card`.

### Task 17: Decision 1424 and wrap-up

- [ ] **Step 1: Append decision 1424** "La chat di vetro ovunque, colonne invariate (decisione: orchestratore (2026-10-20), spec §6.4, §10.9)": the card sits inside the existing column with 12 px of page around it; nothing runs under it; its own branch after the brief feature; measured widths of the card per screen; narrow layouts.
- [ ] **Step 2:** `pnpm -r typecheck`, `pnpm -s check:i18n`; the personal-data scan of the diff (patterns in the builder rules file) prints nothing.
- [ ] **Step 3: Commit** `docs: decision 1424`; report "da verificare a mano": the blur over images in the canvas, both themes, the editor at 1024 px.
