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
interface AgentRunResult { status: 'succeeded' | 'failed' | 'cancelled'; sessionId?: string; error?: string }
```

`AgentTurnRequest` describes a turn: `cwd`, `prompt`, `resumeSessionId` (and `forkSession` to restart from a past session), `addDirs` (read-only folders), `model`, `settings` (sandbox), `mcpConfigPath` (private file with the `studio` MCP server), `permissionPromptTool`, `env` and `unsetEnv` (variables removed), `allowedTools` and `disallowedTools` (permission rules), and `capabilities` (Phase 13, see below). A runner must: start the turn, emit normalized events as they come, resolve `done` exactly once, and really stop the process and its descendants on `cancel()`.

## Language of the prompts
The instructions sent to the agent are always in English. The prompts of creatives, brand analysis and asset description end with an explicit request to reply, and to write every text meant for the user (conversation messages, brand guidelines, asset descriptions, problem reports), in the language chosen in Settings (`English` or `Italian`, from `languageName`). A new backend gets this for free as long as it forwards `prompt` unchanged; the language can change between turns, and a turn already running keeps the language it started with.

## Normalized events (`AgentEvent`, `packages/shared/src/events.ts`)
`session` (session id, model), `text`, `tool_use`, `tool_result`, `rate_limit`, `progress` (from `report_progress`), `stderr`, `parse_error`, `result` (`ok`, `sessionId`, `text`, `costUsd`, `error`), and since Phase 13 `user_message_delivered` (`clientId`: a message written into the running session, meaning "sent") and `interrupted` (the CLI acknowledged an interrupt). The interface and the conversation log only know these events. `ClaudeCodeRunner` derives them from Claude Code's `stream-json` flow with `claude-stream-parser.ts` (invalid lines become `parse_error`, never exceptions).

## ClaudeCodeRunner (`claude-code-runner.ts`)
Starts `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode acceptEdits` in the project folder, with the prompt on stdin and the arguments built by `buildClaudeArgs` (`--resume`/`--fork-session`, `--add-dir`, `--model`, `--settings`, `--strict-mcp-config --mcp-config`, `--permission-prompt-tool`, `--disallowedTools`, `--allowedTools`). On POSIX the process has its own group, and `cancel()` sends SIGTERM then SIGKILL to the whole group. The command is `claude` or the one in `MOTION_STUDIO_CLAUDE_COMMAND` (JSON array, used by tests for the fake `claude`).

## Live messages and interrupt (Phase 13, fallback-first)
The live paths are **off for every Claude Code version**: the stream-input spike was suspended (decisions log 610, `docs/superpowers/notes/2026-10-14-phase13-stream-input-spike.md`), so no version is verified. `capabilitiesFor(version, optIn)` (`agent-capabilities.ts`) returns the effective `{ cliVersion, liveInput, interrupt, checkedAt }`; its table of verified versions is empty.
- **Opt-in.** The opt-ins live in the workspace's `.studio/settings.json`, which the launcher protects from agent writes (Edit/Write deny and sandbox denyWrite, both spellings). Two workspace settings, both default `false`, turn the paths on: `agentLiveInput` and `agentInterrupt` (interrupt also needs `agentLiveInput`: the control request travels on the open stdin). There is no switch in the interface yet: set them in the workspace's `settings.json` or with `PUT /api/settings`. An unknown version (`claude --version` does not answer) keeps both off whatever the settings say. Only creative and console turns get them.
- **Report.** `GET /api/agent/capabilities` returns the effective values; the Doctor shows "Live messages: queued only (not verified for this Claude Code version)" and "Interrupt: stop and resume" (or "on from Settings (not verified live)" after the opt-in).
- **Off (default).** The runner writes the prompt and closes stdin at once, exactly as before Phase 13. `send` resolves `'closed'` and `interrupt` resolves `'unsupported'`, and neither writes anything; `endInput()` does nothing.
- **On.** stdin stays open until the final `result` (or cancel, or exit). `send` writes `{ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }` and emits `user_message_delivered` once the write is flushed. `interrupt` writes `{ type: 'control_request', request_id, request: { subtype: 'interrupt' } }` and waits up to 5 s for the `control_response` with the same `request_id`. An acknowledgement emits `interrupted`, and stdin then stays open until the core decides. The interrupted turn's own result never closes it. If a `send` comes (a redirect), stdin stays open through the redirect turn, so live messages there are still written, and that turn's result closes it. `endInput()` closes it at once, and cancel ends the run. With no decision, a 45 s backstop (`REDIRECT_BACKSTOP_MS`) closes it. After an acknowledged interrupt with no redirect, a non-ok final result means `cancelled`. A redirect turn that fails is `failed`. An error response resolves `'unsupported'`. If no acknowledgement comes, or the process goes away first, it resolves `'timeout'`. These shapes come from the public docs and are **unverified live**. The tests drive them only with `packages/core/test/fixtures/fake-claude-stream.mjs`.

### Capability table and unverified shapes (Task 4)
| Path | Default | Opt-in | State |
|---|---|---|---|
| Live message to the running agent | off, every Claude Code version | `agentLiveInput` | **unverified live**; fallback "Queue for after" |
| Interrupt the current step in the same process | off | `agentInterrupt` (needs `agentLiveInput`) | **unverified live**; fallback Stop, then resume the session |
| Stop and redirect (fallback) | on | none | verified live, haiku: cancel, then `--resume` with the redirect text, same job, no leftover process |
| Queue, remembered stopped session | on | none | verified live (`--resume --fork-session`) |

The live check (`docs/superpowers/notes/2026-10-14-phase13-live-checks.md`) covered only the fallback paths. Still **UNVERIFIED LIVE**: the user-message and `control_request` shapes, the `control_response` shape, the CLI's "session not found" wording (used to detect a failed resume), and whether an interrupted turn emits a `result`. Do not turn the opt-ins on in a release before a live check of these.

## AgentLauncher (`launcher.ts`) and policy (`policy.ts`)
The `AgentLauncher` is the only place where an agent starts. For each job (`creative`, `console`, `brand-analysis`, `describe`):
1. reads the settings and decides whether to use the sandbox (`sandboxMode === 'auto'` and `detectSandbox()` available: macOS `sandbox-exec`, Linux `bubblewrap` + `socat`);
2. loads the "Always for this project" rules from `.studio/permissions.json`, accepting only the formats the interface can produce (`isAllowedRule`);
3. computes with `buildAgentPolicy` the sandbox settings (sensitive folders not readable, linked codebases and configuration files not writable, network domains allowed only for creatives and the console), and the allowed and denied rules;
4. registers the job in the bridge, writes into `<configDir>/run/` (0700) a token file and the MCP configuration (0600; the token never goes through argv or the environment);
5. starts the runner with `unsetEnv` = provider keys and bridge token, and at the end or on cancellation revokes the token, cancels pending approvals and deletes the files.

Without the sandbox the launcher also guards the workspace settings (`WorkspaceStore.guardSettings`, `settings-hold.ts`). During the run the settings are those it started with, and afterwards the file is put back. If that fails, the security-relevant fields are held tighten-only (the stricter of the hold and the file) in `<configDir>/settings-hold/`, across restarts, until the revert succeeds or the user saves. If the hold itself cannot be kept, unsandboxed runs are refused (409 `settings-hold-broken`) until the user saves. This is best-effort detection: without the sandbox the agent has the user's file access, the config folder included. Console runs keep their process group alive, so a leftover child could still write after the release.

The MCP tools available per job type are in `MCP_TOOLS`. Permissions that go beyond the perimeter reach the interface through the `approve` tool (`--permission-prompt-tool`).

## What a CodexRunner would need
The principle is that nothing outside `agent/` knows which agent is behind it. A `CodexRunner` would have to:
- implement `AgentRunner`, translating the other agent's events into the `AgentEvent`s above (including `result` with the session to resume) and returning `AgentRunResult` with the same rules (an ok `result` wins over a later cancellation);
- translate `AgentTurnRequest` into the other agent's tools: resumable sessions and forks, additional folders, hooking up the `studio` MCP server (same configuration and same tools), allow/deny permission rules and a way to delegate approval requests to `approve`;
- offer equivalent isolation: the policy today produces Claude Code–specific settings (`settings.sandbox`, `Edit(...)`/`Read(...)` rules); another backend either reuses an operating-system sandbox layer or must be declared as running without a sandbox (the Doctor and Settings report it);
- go through the launcher (token, private files, `unsetEnv`) and never start the process directly;
- add a test with a fake executable, like `packages/core/test/fixtures/fake-claude.mjs`, and a check in the Doctor (`doctor.ts`).

There is no backend choice in Settings yet: `startServer` creates `ClaudeCodeRunner` directly, so a second backend also requires that wiring.
