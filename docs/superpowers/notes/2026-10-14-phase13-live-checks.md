# Phase 13 - live verification of the interactive agent (Task 4)

Date: 2026-10-14. Model `haiku`, macOS, branch `feat/phase13-interactive-agent` at `28dbb8f`. Phase 13 is fallback-first (the stream-input spike was suspended, decisions log 610): both capabilities stayed **off** (`GET /api/agent/capabilities`: `liveInput: false`, `interrupt: false`). Every turn went through the product's own turn path on a throwaway core (`MOTION_STUDIO_CONFIG_DIR` in the scratchpad, `MemoryVault`, no keys except one fake key in check 5).

**Verdict:** the fallback paths work in checks 1-5. The browser half of check 6 was not done (classifier stop), and the live paths stay unverified.

| Check | Result |
|---|---|
| 1. Live message mid-turn (capability off) | **PASS** |
| 2. Stop, then "continue" | **PASS** |
| 3. Stop and redirect during `preview_frames` | **PASS** |
| 4. Message after the agent finished | **PASS** |
| 5. Paid approval open, then Stop | **PASS** (see deviations) |
| 6. Capability off is the default, UI fallbacks | API part **PASS**; browser part **not done (classifier stop)** |
| 7. Live-input and interrupt checks | **skipped: capability off (spike suspended)** |

## Checks
1. A message sent mid-turn ("make the title red") came back `queued-unsupported` and was stored in the creative's queue. When v1 saved, the queue started by itself (Ruling U, a turn that saved a version). v2 resumed the same session, the user entry is `mode: queued` with `deliveredAt`, and the title colour became `#e5383b`. The "Queue for after" wording in the UI was not looked at.
2. Stop answered `stopping`, the process was gone, and the stopped session was remembered. The new request "continue" ran with `--resume --fork-session`. The agent wrote that the v3 `assets/` folder was missing because "the previous turn was stopped before the copy finished": it knew the stopped work.
3. A redirect sent while `preview_frames` was open answered `restarted`. The old process was gone; a new `claude --resume` (no fork) ran in the same job; the chat has a "Redirect" entry with `interrupted` and `user_message_delivered`. The job succeeded: v4 has the title in uppercase and the brown background. No process was left (`ps -p` and `ps -g` on our own recorded PIDs were empty).
4. A message sent when idle after a finished turn answered `queued-after-finish`, with the notice "Arrived after the agent finished: queued as the next request.", and ran at once; v5 made the subtitle larger (56 to 62).
5. With a fake OpenAI key and a turn asking for `generate_image`, one approval (`provider:openai-images`) opened. Stop cleared it within 3 s ("Generation cancelled"); the network log has no paid-host request, only Google Fonts.
6. API: capabilities off by default. Not done: the browser check that the UI shows only "Queue for after" and a working Stop and redirect (headless Chrome was never started).

## Safety classifier stop
After check 5, a read-only command (printing the last tool result and summing the per-job costs from the workspace's usage log) was refused by the auto-mode classifier. It was not retried or rephrased. The only action taken was stopping our own core by its verified PID. The orchestrator then decided to finish Task 4 from the results already collected: no new core, no new turn, no further reads of the throwaway workspace. So the usage log was never summed and check 6 has no browser half.

## Deviations
- **Paid-approval check.** Instead of an injected fake `fetch`, the throwaway core ran with a process-wide guard that refuses `fetch`, `http` and `https` to the paid providers, plus a fake OpenAI key in `MemoryVault` (saved with `check: false`, deleted afterwards). Nothing left the machine: the guard log has no paid-host entry. Future live checks use an injected fake fetch only.
- **Wrapper.** The core's `claude` command was a small script that recorded each spawn (PID, process group, phase) and then `exec`'d the real `claude` with the product's own arguments, environment and stdin. It changed no flag.

## Cost
Estimated <= $0.08 (v1 $0.0144, v2 $0.0055 read before the stop). The other runs were not summed.

## Real folders (mtimes)
| Folder | Before | After |
|---|---|---|
| `~/Library/Application Support/Motion Studio` | 1791621882 | 1791621882 |
| `~/MotionStudio` | 1791538433 | 1791538433 |
| `~/Library/Application Support/Motion Studio Electron` | 1791822737 | 1791822737 |
| `~/Library/Application Support/Electron` | absent | absent |

Processes: the core (one PID, SIGTERM after verifying its command) was the only long-lived process; no Chrome, no Electron.

## Findings
- **The agent reads the queue.** In v1 the agent read `creative.json` and commented on the queued request ("that isn't in your brief"), then ignored it. A queued request is visible to the agent through the file. Product issue, fixed in the final wave.
- **`stoppedSession` equals the base version's session.** The stopped turn had resumed the base session, so the fork continues that session; the files the stopped turn left half written stay in the version folder (the agent had to repair a missing `assets/` folder).

## UNVERIFIED LIVE
- The user-message shape and the `control_request` shape.
- The `control_response` shape.
- The "session not found" wording of the CLI (used to detect a resume that failed).
- Whether an interrupted turn emits a `result`.
Live input and interrupt stay off by default; these are the reasons.
