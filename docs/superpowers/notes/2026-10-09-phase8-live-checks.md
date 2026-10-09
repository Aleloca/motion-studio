# Phase 8 — live sandbox and usage checks (Task 1, gate)

Date: 2026-10-09. Claude Code 2.1.295, model `haiku` (resolved to `claude-haiku-5-5`), macOS (Darwin 25.6).

**Verdict: the gate passes.** An approved Bash command, with or without `dangerouslyDisableSandbox: true`, still runs inside the sandbox: it can't write outside the write allowlist and can't reach a domain outside the network allowlist.

## Setup

- Throwaway core started with `startServer({ port: 0, configDir, vault: new MemoryVault(), claudeCommand: [wrapper] })` from a driver script under the session scratchpad. The driver refused to run unless the config dir and the workspace were inside the scratchpad.
- Workspace setting `model: 'haiku'`, `sandboxMode: 'auto'` (default). One project, `probe`. Jobs were console turns (`POST /api/projects/:slug/turns`, kind `console`, so `autoAllowBashIfSandboxed: true`).
- The wrapper around the real `claude` recorded the cwd and argv, added `--debug-file`, and tee'd the raw stream-json.
- A temporary log in `bridge-routes.ts approve` (reverted, never committed) wrote the raw request body.
- The driver polled `GET /api/approvals` and answered `POST /api/approvals/:id {decision: 'once'}` for every request of its job.

## Sandbox settings passed by the launcher (`--settings`)

```
sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
  filesystem: { denyRead: [~/.ssh, ~/.aws, …, ~/Library/Application Support/Motion Studio, ~/.config/motion-studio, <configDir>],
                denyWrite: [<project>/CLAUDE.md, CLAUDE.local.md, .mcp.json, .git, .claude, .studio] },
  network: { allowedDomains: [registry.npmjs.org, *.npmjs.org, …, remotion.dev, *.remotion.dev] } }
```

There is no explicit `allowWrite`: the effective write allowlist is Claude Code's default, which is the cwd (the project), the `/dev/*` streams, `/tmp/claude` / `/private/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug` (from the binary), **and Claude Code's per-user temp area `/private/tmp/claude-<uid>`**. That last one was shown live: a sandboxed write to `<scratchpad>/outside-probe/a.txt` succeeded, and the session scratchpad lives under `/private/tmp/claude-501/…`.

**Choice of the outside-probe directory.** Because the scratchpad is covered by the allowlist, the probe directory for 4(a)/4(c) was `/private/tmp/ms-p8-outside-4690b1f2`. It's outside every allowlisted path, it's a throwaway directory created for the test, and it isn't one of the user's folders. It was deleted afterwards, along with `<scratchpad>/outside-probe`.

## Step 3 — point-24 commands

Prompt: run these literally, one Bash call each.

| Command | Reached `approve`? | Result |
|---|---|---|
| `time PYTHONPATH=x python3 -c "print(1)" 2>&1 \| tail -1` | **yes** | approved, printed `1` |
| `pkill -f nonexistent-process-xyz; echo done` | no (auto-allowed in sandbox) | `pkill: Cannot get process list` (sysmond unreachable in the sandbox), `done` |
| `rm -rf work/tmp-probe && mkdir -p work/tmp-probe` | no (auto-allowed in sandbox) | ok |

More evidence from the gate runs:
- `time sh -c '…' ; ls …` and `time curl … | head -c 200` were auto-allowed (no `approve`).
- `time PROBE=1 sh -c '…' ; ls …` and `time PROBE=1 curl … | head …` reached `approve`.

So with `autoAllowBashIfSandboxed: true`, `;`, `&&`, pipes and a plain `time` prefix are auto-allowed. Only **`time` followed by an env assignment (`time VAR=x cmd`)** still reached `approve` here. Claude Code's suggestion for that one was the rule `Bash(time PYTHONPATH=x python3 -c "print(1)")`.

**cwd of the `claude` process:** the project directory (`<workspace>/<slug>`), the same as `system/init.cwd`.

## `approve` input shape (raw body from the MCP server)

```json
{ "tool_name": "Bash",
  "input": { "command": "time PYTHONPATH=x python3 -c \"print(1)\" 2>&1 | tail -1", "description": "Run timed Python print command" },
  "tool_use_id": "toolu_…" }
```

- `description` was present on every Bash request. It's written by the model, short and free-form.
- When the model sets it, `input.dangerouslyDisableSandbox: true` arrives as an extra field. It is absent otherwise, never `false`.
- No other fields were seen (no `timeout`, no `run_in_background`).
- `approve` returns `updatedInput: input` unchanged, so the flag goes back to Claude Code, and the sandbox still applies (see 4c).

## Step 4 — can an approved command escape?

All three ran through `approve` and were approved with `once`.

- **4(a) write outside the allowlist.**
  - Command: `time PROBE=1 sh -c 'echo probe-4a > /private/tmp/ms-p8-outside-4690b1f2/a.txt' ; ls -la /private/tmp/ms-p8-outside-4690b1f2`.
  - Result: `sh: …/a.txt: Operation not permitted`, and the directory stayed empty (checked from outside too). **FAILED as required.**
  - Before that, the same write without the `PROBE=1` prefix was auto-allowed in the sandbox, with the same EPERM.
- **4(b) non-allowlisted domain.**
  - Command: `time PROBE=1 curl -sS -m 15 https://example.org | head -c 200`.
  - Result: `curl: (56) CONNECT tunnel failed, response 403`, plus `<sandbox_violations> deny network-outbound example.org:443`. **FAILED as required.**
  - Control (auto-allowed): `curl … https://registry.npmjs.org/` → HTTP `200`, so the network itself works for allowlisted domains.
- **4(c) `dangerouslyDisableSandbox: true`.**
  - On the first turn the model refused to set the flag. A resumed turn with explicit user authorisation made it set the flag. `approve` received `"dangerouslyDisableSandbox": true` for both commands and approved them.
  - The write to `c.txt` failed with `Operation not permitted` (directory still empty). The curl to example.org failed with `CONNECT tunnel failed, response 403` and the network-outbound violation. **FAILED as required** (`allowUnsandboxedCommands: false` holds).

## Step 5 — usage shapes (fixture `packages/core/test/fixtures/claude-stream-usage-sample.jsonl`)

The fixture is the 4(a)/4(b) run, anonymised:
- ids replaced with `…ANON…` placeholders, paths with `/workspace/project` and `/outside-probe`;
- hook events removed; `init` and `rate_limit_info` reduced to a few keys;
- numbers and field names kept.

**`result` event** (keys): `type, subtype, is_error, api_error_status, duration_ms, duration_api_ms, num_turns, result, session_id, total_cost_usd, usage, modelUsage, permission_denials, stop_reason, terminal_reason, …`

```
usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
         output_tokens_details: { thinking_tokens }, server_tool_use: { web_search_requests, web_fetch_requests },
         service_tier, cache_creation: { ephemeral_1h_input_tokens, ephemeral_5m_input_tokens }, inference_geo,
         iterations: [ { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_creation, type } ],
         speed, fallback_credit }
modelUsage: { "claude-haiku-5-5": { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests,
              costUSD, contextWindow, maxOutputTokens, thinkingTokens, canonicalModel, provider, costBasis } }
```

- `usage.output_tokens` already includes the thinking tokens (`output_tokens_details.thinking_tokens` is a subset).
- `usage.iterations` holds only the last API call, so don't sum it.

**`assistant` events:** `message.usage = { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, cache_creation: {…}, output_tokens, service_tier, inference_geo }`. The same `message.id` is repeated on consecutive events (one per content block) with identical usage, so keep the last value per id. `message.usage` is per API call, not cumulative.

**`system/thinking_tokens` events:** `{ estimated_tokens, estimated_tokens_delta }`, a live estimate of thinking only.

**Important: resumed sessions.** On a resumed run (`--resume`), `result.usage` covers **only this run**, but `result.modelUsage` and `result.total_cost_usd` are **cumulative over the whole session** (they include earlier runs). Measured:
- previous run: usage in 4 / out 1664 / cr 45349 / cw 16601, cost 0.00460609;
- resumed run: usage in 4 / out 721 / cr 64200 / cw 1405;
- the resumed run's `modelUsage`: in 8 / out 2385 / cr 109549 / cw 18006, `costUSD = total_cost_usd = 0.00588999`, which is the sum of the two runs.

Consequences for the ledger:
- Take tokens from `usage`, never from `modelUsage`.
- Cost per run must be the difference from the previous run of the same session, or be computed from `usage`. Summing `total_cost_usd` across turns would double-count.

The prices implied by the runs are consistent with `cost = 1e-7 × (input + 2×cacheWrite(1h) + 0.1×cacheRead + 5×output)` for this model, with all cache writes 1h.

`system/init` has `apiKeySource` (`"none"` with a subscription login).

## `claude auth status --json` (field names only)

`loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory, configDirectory, email, orgId, orgName, subscriptionType`

- `authMethod` tells a subscription from an API key: `"claude.ai"` means a Claude subscription login. Any other value, e.g. an API key, is to be treated as API / unknown.
- `subscriptionType` is only present/meaningful for subscriptions.
- `email`, `orgId`, `orgName` are personal and must never be read into the app's output.

## Side observations

- Claude Code logs warnings for the launcher's deny rules:
  - `MultiEdit(...)` "matches no known tool";
  - `Write(...)`/`NotebookEdit(...)` path deny rules "are not matched by file permission checks — only Edit(path) rules".
  
  The `Edit(...)` rules and the sandbox `denyWrite` still cover these paths, so there's no hole, but the extra rules are noise.
- Network denials of non-allowlisted domains never reach `approve`: the sandbox proxy refuses them directly.
- The `claude` child inherits `CLAUDE_CONFIG_DIR` from the parent environment (in the app, the user's own Claude config).

## Cost of the live checks

5 `claude` runs with Haiku: input 32, output 4 971, cache write 81 061, cache read 415 975 tokens; about $0.023 at API list prices (counted against the plan).
