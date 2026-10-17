# Agent backends

Motion Studio does not talk to an agent directly: it goes through a neutral contract (`AgentRunner`), so the first backend (Claude Code) is not the only possible one. This guide describes the contract as it is today.

## AgentRunner (`packages/core/src/agent/runner.ts`)

```ts
interface AgentRunner { start(req: AgentTurnRequest, onEvent: (e: AgentEvent) => void): AgentRun }
interface AgentRun {
  done: Promise<AgentRunResult>; cancel(): void; killGroup?(): void;
  send?(msg: { text: string; clientId: string }): Promise<'written' | 'closed'>;      // Phase 13
  interrupt?(): Promise<'interrupted' | 'unsupported' | 'timeout'>;                   // Phase 13
  endInput?(): void;                                                                   // Phase 13
}
interface AgentRunResult { status: 'succeeded' | 'failed' | 'cancelled'; sessionId?: string; error?: string; startFailed?: boolean }
```

`startFailed` (Phase 13) marks a run the CLI could not even start (missing binary or folder, a spawn error): a normal failure, never taken for a failed resume. `AgentTurnRequest` describes a turn: `cwd`, `prompt`, `resumeSessionId` (and `forkSession` to restart from a past session), `addDirs` (read-only folders), `model`, `settings` (sandbox), `mcpConfigPath` (private file with the `studio` MCP server), `permissionPromptTool`, `env` and `unsetEnv` (variables removed), `allowedTools` and `disallowedTools` (permission rules), and `capabilities` (Phase 13, see below). A runner must: start the turn, emit normalized events as they come, resolve `done` exactly once, and really stop the process and its descendants on `cancel()`.

## Language of the prompts
The instructions sent to the agent are always in English. The prompts of creatives, brand analysis and asset description end with an explicit request to reply, and to write every text meant for the user (conversation messages, brand guidelines, asset descriptions, problem reports), in the language chosen in Settings (`English` or `Italian`, from `languageName`). A new backend gets this for free as long as it forwards `prompt` unchanged; the language can change between turns, and a turn already running keeps the language it started with.

## Normalized events (`AgentEvent`, `packages/shared/src/events.ts`)
`session` (session id, model), `text`, `tool_use`, `tool_result`, `rate_limit`, `progress` (from `report_progress`), `stderr`, `parse_error`, `result` (`ok`, `sessionId`, `text`, `costUsd`, `error`), and since Phase 13 `user_message_delivered` (`clientId`: a message written into the running session, meaning "sent"), `user_message_read` (`clientId`: the CLI's evidence that it took it, decision 804) and `interrupted` (the CLI acknowledged an interrupt); a `result` can carry `interrupted: true` (the turn the user stopped). The interface and the conversation log only know these events. `ClaudeCodeRunner` derives them from Claude Code's `stream-json` flow with `claude-stream-parser.ts` (invalid lines become `parse_error`, never exceptions).

## ClaudeCodeRunner (`claude-code-runner.ts`)
Starts `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode acceptEdits` in the project folder, with the prompt on stdin and the arguments built by `buildClaudeArgs` (`--resume`/`--fork-session`, `--add-dir`, `--model`, `--settings`, `--strict-mcp-config --mcp-config`, `--permission-prompt-tool`, `--disallowedTools`, `--allowedTools`). On POSIX the process has its own group, and `cancel()` sends SIGTERM then SIGKILL to the whole group. The command is `claude` or the one in `MOTION_STUDIO_CLAUDE_COMMAND` (JSON array, used by tests for the fake `claude`).

## Live messages and interrupt (Phase 13; on from Claude Code 2.1.301, decision 804)
The live paths are **on for Claude Code 2.1.301 and newer**, the version the user's own probe measured on 2026-10-16 (`scripts/spike/stream-input-probe.mjs`, `docs/superpowers/notes/2026-10-16-stream-input-probe.md`), and **off for older or unknown versions**, which keep the Phase 13 fallbacks (queue, stop and resume). `capabilitiesFor(version, settings)` (`agent-capabilities.ts`) returns the effective `{ cliVersion, liveInput, interrupt, checkedAt }`: on when the version is in the verified table (`VERIFIED_CAPABILITIES`, one row: `2.1.301`) AND the workspace setting is on.
- **Settings.** Two workspace settings in `.studio/settings.json`, which the launcher protects from agent writes (Edit/Write deny and sandbox denyWrite, both spellings): `agentLiveInput` and `agentInterrupt`, both **default `true`** since decision 804 (interrupt also needs `agentLiveInput`: the control request travels on the open stdin). They can only switch a verified capability off, never turn an unverified version on. There is no switch in the interface: set them in `settings.json` or with `PUT /api/settings`. A settings file written before decision 804 (no `agentLiveDefaults: 804` marker) is read with both on, since its `false` was the old default; a `false` saved afterwards sticks. An unknown version (`claude --version` does not answer) keeps both off. Only creative and console turns get them.
- **Report.** `GET /api/agent/capabilities` returns the effective values. The Doctor shows "Live messages: on (verified for this Claude Code version)" and "Interrupt: on (verified for this Claude Code version)"; "queued only (turned off in the workspace settings)" / "stop and resume (turned off in the workspace settings)" when a setting is off; "queued only (not verified for this Claude Code version)" / "stop and resume" on an older or unknown version.
- **Off.** The runner writes the prompt and closes stdin at once, exactly as before Phase 13. `send` resolves `'closed'` and `interrupt` resolves `'unsupported'`, and neither writes anything; `endInput()` does nothing.
- **On.** stdin stays open until the final `result` (or cancel, or exit). `send` writes `{ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }` and emits `user_message_delivered` ("sent") once the write is flushed. `user_message_read` ("delivered") comes only on the CLI's evidence: Claude Code answers each input with its own `result` (2.1.301: two messages, two results), so the k-th message written after the prompt is read once the k-th `result` came and the agent then produced new output (its turn started). A message the CLI folds into the running turn stays "sent". `interrupt` writes `{ type: 'control_request', request_id, request: { subtype: 'interrupt' } }` and waits up to 5 s for the `control_response` with the same `request_id`; 2.1.301 answers `{ type: 'control_response', response: { subtype: 'success', request_id, response: { still_queued: [] } } }`, ends the turn with a `result` of subtype `error_during_execution` and exits with code 1. An acknowledgement emits `interrupted`, and stdin then stays open until the core decides. The interrupted turn's own result never closes it and is marked `interrupted: true` (not ok, no `error`), also when it comes before the acknowledgement (it is held until the interrupt is answered). If a `send` comes (a redirect), stdin stays open through the redirect turn, so live messages there are still written, and that turn's result closes it. `endInput()` closes it at once (reserved: the core does not call it today, since after an acknowledged interrupt it always writes the redirect), and cancel ends the run. With no decision, a 45 s backstop (`REDIRECT_BACKSTOP_MS`) closes it. After an acknowledged interrupt with no redirect, an `error_during_execution` result means `cancelled` (a stop, not a failure), whatever the exit code; without the acknowledgement, or with another error, the run is `failed`. A redirect turn that fails is `failed`. An error response resolves `'unsupported'`. If no acknowledgement comes, or the process goes away first, it resolves `'timeout'`. The tests drive these shapes only with `packages/core/test/fixtures/fake-claude-stream.mjs` (never a real `claude`).

### Capability table (decision 804)
| Path | Default | Setting | State |
|---|---|---|---|
| Live message to the running agent | on for 2.1.301+, off otherwise | `agentLiveInput` | measured on 2.1.301 by the user's probe (accepted mid-turn, answered in the same session); delivery timing (between steps or after the current reply) not measured; fallback "Queue for after" |
| Interrupt the current step in the same process | on for 2.1.301+, off otherwise | `agentInterrupt` (needs `agentLiveInput`) | measured on 2.1.301 (ack, `error_during_execution`, exit 1); fallback Stop, then resume the session |
| Stop and redirect (fallback) | on | none | verified live, haiku: cancel, then `--resume` with the redirect text, same job, no leftover process |
| Queue, remembered stopped session | on | none | verified live (`--resume --fork-session`) |

Still not measured: when exactly a live message is read (the probe's model used no tools), the CLI's "session not found" wording (used to detect a failed resume), and whether the session id reported by the init event under `--resume X --fork-session` is the fork's or the parent X. The console has no request queue.

## AgentLauncher (`launcher.ts`) and policy (`policy.ts`)
The `AgentLauncher` is the only place where an agent starts. For each job (`creative`, `console`, `brand-analysis`, `describe`):
1. reads the settings and decides whether to use the sandbox (`sandboxMode === 'auto'` and `detectSandbox()` available: macOS `sandbox-exec`, Linux `bubblewrap` + `socat`);
2. loads the "Always for this project" rules from `.studio/permissions.json`, accepting only the formats the interface can produce (`isAllowedRule`);
3. computes with `buildAgentPolicy` the sandbox settings (sensitive folders not readable, linked codebases and configuration files not writable, network domains allowed only for creatives and the console), and the allowed and denied rules;
4. registers the job in the bridge, writes into `<configDir>/run/` (0700) a token file and the MCP configuration (0600; the token never goes through argv or the environment);
5. starts the runner with `unsetEnv` = provider keys and bridge token, and at the end or on cancellation revokes the token, cancels pending approvals and deletes the files.

Without the sandbox the launcher also guards the workspace settings (`WorkspaceStore.guardSettings`, `settings-hold.ts`). During the run the settings are those it started with, and afterwards the file is put back. If that fails, the security-relevant fields are held tighten-only (the stricter of the hold and the file) in `<configDir>/settings-hold/`, across restarts, until the revert succeeds or the user saves. If the hold itself cannot be kept, unsandboxed runs are refused (409 `settings-hold-broken`) until the user saves. This is best-effort detection: without the sandbox the agent has the user's file access, the config folder included. Console runs keep their process group alive, so a leftover child could still write after the release.

The MCP tools available per job type are in `MCP_TOOLS`. Permissions that go beyond the perimeter reach the interface through the `approve` tool (`--permission-prompt-tool`).

Creative turns also get the app actions (`APP_ACTION_TOOLS`, decision 917: `update_brief`, `add_format`, `duplicate_format`, `add_language`, `add_variant`, `discard_variant`, `restore_variant`, `set_pick`, `render_version`, `prepare_export`; `creatives/agent-actions.ts`). Their scope is the bridge context's `appScope` (`LaunchInput.appScope`, set by the creative turn: its creative and the version it makes), never a tool argument; each handler calls the function the UI's route calls. A backend only has to expose these tools like the others: nothing in them depends on Claude Code. Brief edits made during the turn become the creative's pending brief; actions that need the turn to be over run from `CreativeTurnService.onTurnSettled`.

## What a CodexRunner would need
The principle is that nothing outside `agent/` knows which agent is behind it. A `CodexRunner` would have to:
- implement `AgentRunner`, translating the other agent's events into the `AgentEvent`s above (including `result` with the session to resume) and returning `AgentRunResult` with the same rules (an ok `result` wins over a later cancellation);
- translate `AgentTurnRequest` into the other agent's tools: resumable sessions and forks, additional folders, hooking up the `studio` MCP server (same configuration and same tools), allow/deny permission rules and a way to delegate approval requests to `approve`;
- offer equivalent isolation: the policy today produces Claude Code–specific settings (`settings.sandbox`, `Edit(...)`/`Read(...)` rules); another backend either reuses an operating-system sandbox layer or must be declared as running without a sandbox (the Doctor and Settings report it);
- go through the launcher (token, private files, `unsetEnv`) and never start the process directly;
- add a test with a fake executable, like `packages/core/test/fixtures/fake-claude.mjs`, and a check in the Doctor (`doctor.ts`).

There is no backend choice in Settings yet: `startServer` creates `ClaudeCodeRunner` directly, so a second backend also requires that wiring.
