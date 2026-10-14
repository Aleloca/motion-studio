# Phase 13 — stream-input and interrupt spike (Task 0): suspended

Date: 2026-10-14. Installed CLI: Claude Code **2.1.299**. Branch `feat/phase13-interactive-agent` from `ea77c21`.

**Status: suspended, not worked around.** No experiment ran. No experiment data exists, and Phase 13 does not rely on any.

## What happened

- The probe `scripts/spike/stream-input-probe.mjs` was written to mirror the product's `claude -p --input-format stream-json …` flags, keep stdin open and log every line sent and received.
- The auto-mode safety classifier refused the **first live call** of the probe (experiment 3, the cheapest) with "[Security Weaken]". No `claude` process started, and the cost was $0.
- The implementer stopped there. **Nobody ran a variant** of the probe: no rephrased command, no other flags, no other entry point. The controller did not run it either.
- The probe script **stays untracked** in the worktree (`scripts/spike/`). It is not committed. The user can run it later themselves with `!` in the session; the usage line is in the script header.

## What the experiments were meant to answer

1. **Live input.** With stdin kept open after the first user message, is a second user message written mid-turn (during a tool call) consumed after the current tool, only after the turn's `result`, or never? Does a second `result` follow?
2. **Interrupt.** A `control_request` with `subtype: 'interrupt'` written mid-turn: what `control_response` comes back, which `result` follows (subtype, `is_error`), does the process stay alive for a further user message, and can the session be resumed?
3. **Closing.** Closing stdin after the first `result`: does the process exit cleanly, and with which exit code?
4. **Late message.** A user message written after the `result` but before stdin closes: is it processed?

The conclusion would have named the primary path (live input yes or no, interrupt yes or no), the timings, and the exact message shapes for Task 1.

## Consequence (orchestrator decision, decisions log 610)

- Phase 13 goes **fallback-first**. `capabilitiesFor(version)` reports live input and interrupt **off for every version**. An explicit opt-in setting (default off) can turn each one on.
- With the capabilities off, a message sent while the agent works is queued as the next request, and Stop and redirect stops the process and resumes the session.
- The runner keeps its current environment and flags. The suggestion to strip env and add `--setting-sources ""` is withdrawn.
- `send` and `interrupt` are implemented and tested **against the fake CLI only** (`packages/core/test/fixtures/fake-claude-stream.mjs`). Their message shapes come from public documentation and are **unverified live** for 2.1.299 (see below once Task 1 lands).
