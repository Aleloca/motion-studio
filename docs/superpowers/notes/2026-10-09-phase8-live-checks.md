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

There is no explicit `allowWrite`: the effective write allowlist is Claude Code's default, which is the cwd (the project), the `/dev/*` streams, `/tmp/claude` / `/private/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug` (from the binary), **and Claude Code's per-user temp area `/private/tmp/claude-<uid>`**. That last one was shown live: a sandboxed write to `<scratchpad>/outside-probe/a.txt` succeeded, and the session scratchpad lives under `/private/tmp/claude-<uid>/…`.

**Choice of the outside-probe directory.** Because the scratchpad is covered by the allowlist, the probe directory for 4(a)/4(c) was `/private/tmp/ms-p8-outside-<rand>`. It's outside every allowlisted path, it's a throwaway directory created for the test, and it isn't one of the user's folders. It was deleted afterwards, along with `<scratchpad>/outside-probe`.

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
  - Command: `time PROBE=1 sh -c 'echo probe-4a > /private/tmp/ms-p8-outside-<rand>/a.txt' ; ls -la /private/tmp/ms-p8-outside-<rand>`.
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

---

# Phase 8 — end-to-end verification (Task 10)

Date: 2026-10-09. Claude Code 2.1.295, model `haiku` (→ `claude-haiku-5-5`), git 2.50.1, macOS. Branch `feat/phase8-approvals-usage` at `34210c0`, built with `pnpm build` in the phase 8 worktree.

## Setup

- Throwaway core: `startServer({ port: 4497, configDir, vault: new MemoryVault(), claudeCommand: [wrapper], webDir: <worktree>/packages/web/dist })`, run with `node --experimental-transform-types`. Config, workspace and project (`demo`) were under the session scratchpad; the script refused any config dir outside it.
- The wrapper tee'd the stream-json of agent runs. A watcher logged every hub message (`/api/events`) and every request in `GET /api/approvals`. In the "on" runs it answered `once` after logging, so a stray request couldn't block the job.
- Screenshots: headless Chrome 154 over CDP, with a throwaway profile, at 1440×900, light and dark (`prefers-color-scheme`), with reduced motion.
- Afterwards the core, the watcher and Chrome were stopped and the scratchpad folder was deleted.
- User folders, mtime before → after:
  - `~/Library/Application Support/Motion Studio`: 1791461297 → 1791461297 (unchanged);
  - `~/MotionStudio`: 1791538433 → 1791538433 (unchanged).

## 1. Creative with `autoApproveSandboxed` on

The creative was "Autumn sale": 6 s, Instagram Story/Reel 9:16 and Post 1:1, generated from the brief, then the change request "make the 20% off text larger, deep burgundy background".

| Run | Result | Bash approvals to the user | `auto_approved` | Other approvals |
|---|---|---|---|---|
| 1. Generation | **failed at the commit** (see "Defect found" below) | 0 | 2 | 4 × Read in `$TMPDIR` |
| 2. Generation again (after the workaround) | v1 | 0 | 1 | 2 × Read in `$TMPDIR` |
| 3. Change request | v2 | 0 | 1 | 2 × Read in `$TMPDIR` |

- **Approvals for sandboxed Bash: 0** (target 0).
  - 4 commands went through `approve` and were auto-approved. All 4 were `cd <work> && time python3 render.py && ls …`, rated "Runs a complex shell command", medium.
  - The agent's other Bash calls were allowed by Claude Code itself in the sandbox (`autoAllowBashIfSandboxed`).
- **Read approvals: 8.** These are not Bash commands, so they ask by design. The agent extracts check frames with `ffmpeg … $TMPDIR/…png`, which is writable, then opens them with `Read`. A Read outside the project asks the user. The card offers "Always" (`Read(//tmp/claude-501/**)`).
  - This is the remaining source of prompts in a normal creative: 2 to 4 per turn.
  - Options for the fix wave: tell the agent to put check frames in `work/`, or allow `Read` of the job's own temp area.
- **Ledger:** `<project>/.studio/usage.jsonl` has 5 lines: 4 creative runs and 1 brand analysis.
  - The failed run is recorded with `outcome: "ok"` and `version: 1`, because Claude's run itself succeeded; the failure came afterwards, in the commit.
  - Version cards carry `usage` for their own run only. v1 shows 33.8k tokens and leaves out the failed run's 76.2k; the brief's "Tokens" row (76.0k) sums only the versions. The failed run's tokens are in the ledger and in Usage.
- **Parity:** `/api/usage` total = input 80 + output 33,467 + cache write 141,897 = **175,444**. The top bar shows "175.4k tokens", and Settings → Usage shows 175.4k for the 7 days, for Today and for project Demo.
  - By kind: Creatives 152.2k ($0.057), Brand analyses 23.2k ($0.007).
  - Billing: "subscription" ("This counts toward your Claude plan. At API prices it would be about $0.064").
- **Output weights:** all H.264, yuv420p, 30 fps, 6.0 s. All are far below the targets, so there were no large-file warnings.

  | Version | Reel 9:16 (target 4 Mbps) | Post 1:1 (target 3.5 Mbps) |
  |---|---|---|
  | v1 | 154,080 B (0.21 Mbps) | 144,147 B (0.19 Mbps) |
  | v2 | 148,603 B (0.20 Mbps) | 136,570 B (0.18 Mbps) |
  | v3 (setting off) | 155,879 B | 141,863 B |

- **Large-file chip:** a synthetic 6 s 1080×1920 file of 85.8 MB (114 Mbps) was checked with the core's own `validateOutputs`. Result: `outputs.largeFile {sizeMB: 85.8, mbps: 114, targetMbps: 4, channel: Instagram}`. The canvas shows the chip "86 MB · large", and its popover says "Large file: 85.8 MB at 114 Mbps (about 4 Mbps is plenty for Instagram)".
- **Task 6b messages:** neither "npm cache isn't writable…" nor "Headless Chromium can't start…" appears in any conversation or stream (0 matches).
  - The agent ran no `npm install` (it used Pillow + ffmpeg).
  - Claude Code itself runs `npm root --global` at start, and its log went to `<project>/.cache/npm/_logs/`. That log has `warn Unknown env config "store-dir"`, which comes from our `npm_config_store_dir` variable (npm 11 doesn't know it; pnpm reads `PNPM_STORE_DIR`). It is harmless, but every npm command in a job prints it. The other warning in that log came from the user's own npmrc.

### Defect found: commits fail when `.cache/` exists

The first generation failed with:

```
git add failed: The following paths are ignored by one of your .gitignore files:
.cache
hint: Use -f if you really want to add them.
```

Cause:
- `GitService.commitAll` runs `git add -A -- . ':(exclude).cache'`. The project's `.gitignore` lists `.cache/` (template, plus `completeGitignore`).
- With git 2.50.1, an exclude pathspec that names an ignored path that exists makes `git add` exit 1. Reproduced in an empty repo: exit 1 with `.cache/` present, exit 0 without it. `-c advice.addIgnoredFile=false`, `':(exclude).cache/'` and `':(exclude,glob).cache/**'` fail the same way.
- `.cache/` is created at the start of every job (by Claude Code's `npm root --global`, through `npm_config_cache`). So in a real project, once any job has run, **every `commitAll` fails**. That includes creative versions, brand analysis, and the brand and library routes (`brand-analysis.ts`, `creative-turns.ts`, `brand-routes.ts`, `library-routes.ts`).

Workaround used only for this verification (no code change): `.cache/` was removed from the throwaway project's `.gitignore`. `completeGitignore` only runs at workspace recovery, so it didn't come back. With that, `:(exclude).cache` alone keeps the folder out of git, and runs 2–5 committed normally. **To fix in the final fix wave.**

## 2. Brand analysis (`https://example.com`)

- Approvals: **0** (target 0). The job took 26 s.
- `auto_approved` events in the proposal's `log.jsonl`: **0**. The agent ran no Bash: `ToolSearch`, 4 × `Read` in the project, 1 × `WebFetch`, 1 × `Write`.
  - So this run doesn't exercise auto-approval in brand jobs. The rule itself is covered by tests.
- Usage on the proposal: input 8, output 2,488, cache write 20,717 (23.2k shown), cache read 116,271, $0.0069.
  - The ledger's `models` entry reports input 381 / output 3,129, more than `usage`. `modelUsage` also counts the model call made inside `WebFetch`. Tokens come from `usage` by design.

## 3. Setting off (`autoApproveSandboxed: false`), one short turn

The turn was "make the 20% off text pure white".
- Approvals: **1 Bash and 1 Read**. `auto_approved` for this job: 0.
- The Bash card:
  - title "Runs a complex shell command";
  - "The agent wants to run a command on this computer.";
  - indicator chip "Complex command" (medium, with the icon and the "Medium risk:" prefix for screen readers);
  - "Show command · 1 line";
  - "The agent says: “Render v3 outputs and probe them”";
  - Allow / Deny, and a 10-minute countdown.
- The command had a `for` loop, so `parsed: false` and the generic medium phrase, as specified.
- Project settings → Agent and approvals shows "Approve sandboxed commands automatically" with "Applies to new jobs" under it.
  - The switch showed the old value until the page was reloaded, because the setting was changed through the API and not from the UI.

## 4. Screenshots

There are 16 screenshots, 8 views × light/dark at 1440 px, in `.superpowers/sdd/…/screens/` (not committed):
- approval card;
- Activity details with an automatic approval;
- version card with tokens;
- Settings → Usage;
- tokens button + activity center;
- auto-approve setting;
- large-file chip, and its popover.

The comparison with the prototype is in `visual-diff.md` in the same folder.

## Cost of this verification

5 `claude` runs with Haiku (4 creative, 1 brand), plus `claude auth status` for billing:
- input 80;
- output 33,467;
- cache write 141,897;
- cache read 1,889,061.

That is 175.4k tokens shown, about **$0.064** at API list prices (counted against the plan).
