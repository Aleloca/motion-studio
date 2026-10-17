# Agent app actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the agent of a creative turn can edit its brief, add/discard/restore variants and set the ★, add and duplicate formats, add a language, render and prepare an export, with no confirmation card; duration mismatches end without fix loops.

**Spec:** `docs/superpowers/specs/2026-10-17-agent-app-actions-design.md`

**Architecture:** a new `AgentActionService` (`packages/core/src/creatives/agent-actions.ts`) provides the bridge handlers. Each handler reads its scope from `BridgeContext.appScope` (set by the creative turn) and calls the same functions the UI routes call. Brief changes during the turn become the creative's pending brief; actions that need the turn to be over are kept per job and run from a settle hook of `CreativeTurnService`.

## Global Constraints

- Same internal functions as the routes; no second implementation of a rule.
- No tool takes a path or a scope argument; inputs parsed with strict zod in the core.
- UI copy through `packages/shared/src/i18n` (it + en); `pnpm -s check:i18n`.
- Targeted tests only; `pnpm -r typecheck`.
- Decisions 955-974 in `docs/decisions-log.md`, "decisione: orchestratore (2026-10-17)".
- Commit trailers exactly as in the rules.

## Tasks

### Task 1: `statedDurationSec` (shared)
- [ ] Tests (en + it, minutes, mixed, conflicting, none, out of range) in `packages/shared/test/brief-duration.test.ts`.
- [ ] `packages/shared/src/brief-duration.ts`, exported from the index.

### Task 2: New creative duration warning (web)
- [ ] Test in `packages/web/test/new-creative-duration.test.tsx`: the note appears, "Usa 60 s" sets the length, no note when equal or no video.
- [ ] i18n `web.newCreative.durationMismatch`, `useStated`; NewCreative note.

### Task 3: chat line origin + i18n of the actions
- [ ] `ConversationEntry` system `origin?: 'agent'`; Conversation renders it with an agent mark (web test).
- [ ] `agentActions` catalog (it/en): chat lines, errors, incomplete explanation, recheck lines.

### Task 4: the turn side (core)
- [ ] `BridgeContext.appScope`, `LaunchInput.appScope`, `MCP_TOOLS.creative` gets the ten tools.
- [ ] `CreativeTurnService`: per-job check duration; settle hook; `noteFromTurn`; `deferBrief`; `recheckLatest` on duration change (updateBrief, applySharedBrief); incomplete explanation line; `durationOff` and `appActions` to the prompt.
- [ ] Tests: duration override makes the version complete; recheck flips incomplete → complete after a brief edit; incomplete line.

### Task 5: `AgentActionService` + bridge wiring
- [ ] Handlers for the ten tools with scope checks, limits and chat lines; deferred actions at settle.
- [ ] `prepareExportRenders` extracted from the route (route unchanged in behaviour).
- [ ] Tests in `packages/core/test/agent-actions.test.ts` (controlled runner, bridge calls with the run's token): brief edit during the turn (single and group), add_format + follow-up turn (depth 1), duplicate after the turn, render current, set_pick, add_variant (+ cap), discard own variant refused, other kinds refused, limit.

### Task 6: prompt
- [ ] App actions section, brief text duration note, fix prompt duration guidance (prompt tests).

### Task 7: MCP server
- [ ] Tool definitions in `packages/mcp-studio/src/server.mjs`; test with the fake bridge.

### Task 8: docs
- [ ] README.md / README.it.md (agent actions), docs/agent-backends.md (MCP_TOOLS), decisions log.
