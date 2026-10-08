# Agent backends

Motion Studio does not talk to an agent directly: it goes through a neutral contract (`AgentRunner`), so the first backend (Claude Code) is not the only possible one. This guide describes the contract as it is today.

## AgentRunner (`packages/core/src/agent/runner.ts`)

```ts
interface AgentRunner { start(req: AgentTurnRequest, onEvent: (e: AgentEvent) => void): AgentRun }
interface AgentRun { done: Promise<AgentRunResult>; cancel(): void }
interface AgentRunResult { status: 'succeeded' | 'failed' | 'cancelled'; sessionId?: string; error?: string }
```

`AgentTurnRequest` describes a turn: `cwd`, `prompt`, `resumeSessionId` (and `forkSession` to restart from a past session), `addDirs` (read-only folders), `model`, `settings` (sandbox), `mcpConfigPath` (private file with the `studio` MCP server), `permissionPromptTool`, `env` and `unsetEnv` (variables removed), `allowedTools` and `disallowedTools` (permission rules). A runner must: start the turn, emit normalized events as they come, resolve `done` exactly once, and really stop the process and its descendants on `cancel()`.

## Language of the prompts
The instructions sent to the agent are always in English. The prompts of creatives, brand analysis and asset description end with an explicit request to reply, and to write every text meant for the user (conversation messages, brand guidelines, asset descriptions, problem reports), in the language chosen in Settings (`English` or `Italian`, from `languageName`). A new backend gets this for free as long as it forwards `prompt` unchanged; the language can change between turns, and a turn already running keeps the language it started with.

## Normalized events (`AgentEvent`, `packages/shared/src/events.ts`)
`session` (session id, model), `text`, `tool_use`, `tool_result`, `rate_limit`, `progress` (from `report_progress`), `stderr`, `parse_error`, `result` (`ok`, `sessionId`, `text`, `costUsd`, `error`). The interface and the conversation log only know these events. `ClaudeCodeRunner` derives them from Claude Code's `stream-json` flow with `claude-stream-parser.ts` (invalid lines become `parse_error`, never exceptions).

## ClaudeCodeRunner (`claude-code-runner.ts`)
Starts `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode acceptEdits` in the project folder, with the prompt on stdin and the arguments built by `buildClaudeArgs` (`--resume`/`--fork-session`, `--add-dir`, `--model`, `--settings`, `--strict-mcp-config --mcp-config`, `--permission-prompt-tool`, `--disallowedTools`, `--allowedTools`). On POSIX the process has its own group, and `cancel()` sends SIGTERM then SIGKILL to the whole group. The command is `claude` or the one in `MOTION_STUDIO_CLAUDE_COMMAND` (JSON array, used by tests for the fake `claude`).

## AgentLauncher (`launcher.ts`) and policy (`policy.ts`)
The `AgentLauncher` is the only place where an agent starts. For each job (`creative`, `console`, `brand-analysis`, `describe`):
1. reads the settings and decides whether to use the sandbox (`sandboxMode === 'auto'` and `detectSandbox()` available: macOS `sandbox-exec`, Linux `bubblewrap` + `socat`);
2. loads the "Always for this project" rules from `.studio/permissions.json`, accepting only the formats the interface can produce (`isAllowedRule`);
3. computes with `buildAgentPolicy` the sandbox settings (sensitive folders not readable, linked codebases and configuration files not writable, network domains allowed only for creatives and the console), and the allowed and denied rules;
4. registers the job in the bridge, writes into `<configDir>/run/` (0700) a token file and the MCP configuration (0600; the token never goes through argv or the environment);
5. starts the runner with `unsetEnv` = provider keys and bridge token, and at the end or on cancellation revokes the token, cancels pending approvals and deletes the files.

The MCP tools available per job type are in `MCP_TOOLS`. Permissions that go beyond the perimeter reach the interface through the `approve` tool (`--permission-prompt-tool`).

## What a CodexRunner would need
The principle is that nothing outside `agent/` knows which agent is behind it. A `CodexRunner` would have to:
- implement `AgentRunner`, translating the other agent's events into the `AgentEvent`s above (including `result` with the session to resume) and returning `AgentRunResult` with the same rules (an ok `result` wins over a later cancellation);
- translate `AgentTurnRequest` into the other agent's tools: resumable sessions and forks, additional folders, hooking up the `studio` MCP server (same configuration and same tools), allow/deny permission rules and a way to delegate approval requests to `approve`;
- offer equivalent isolation: the policy today produces Claude Code–specific settings (`settings.sandbox`, `Edit(...)`/`Read(...)` rules); another backend either reuses an operating-system sandbox layer or must be declared as running without a sandbox (the Doctor and Settings report it);
- go through the launcher (token, private files, `unsetEnv`) and never start the process directly;
- add a test with a fake executable, like `packages/core/test/fixtures/fake-claude.mjs`, and a check in the Doctor (`doctor.ts`).

There is no backend choice in Settings yet: `startServer` creates `ClaudeCodeRunner` directly, so a second backend also requires that wiring.
