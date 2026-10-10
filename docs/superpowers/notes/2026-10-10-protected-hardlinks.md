# Protected files: hard links and `[ ]` workspace roots — live check

Date: 2026-10-10. Claude Code 2.1.295 (`claude-haiku-5-5` via the workspace model `haiku`), macOS (Darwin 25.6), Node 24.9. Branch `fix/protected-hardlinks` from `main` at `7eb8c78`. Decisions log 141.

**Verdict:**
- The sandbox already refuses to *create* a hard link to any write-denied file, and a write through a symlink is checked on its target.
- A hard link made **before** the file became protected stays a writable second name. The case that matters is a file in `outputs/vN/` linked from `work/` during its own turn: the write went through and changed an earlier version. Fixed in the core.
- In a workspace whose path has `[ ]`, the sandbox protected **nothing**: concrete paths, `.studio/` and the log globs alike. Fixed by escaping the paths for the sandbox.

| Check | Before the fix | After the fix |
|---|---|---|
| `ln conversation.jsonl work/x && echo >> work/x` | **PASS**: `ln` refused | **PASS**: `ln` refused (`[x]` root) |
| `ln .studio/usage.jsonl work/u && echo >> work/u` | **PASS**: `ln` refused | not re-run (same rule) |
| `ln versions.json work/v && echo >> work/v` | **PASS**: `ln` refused | not re-run (same rule) |
| `ln outputs/v1/old.txt work/o && echo >> work/o` (v1 earlier) | **PASS**: `ln` refused | not re-run (same rule) |
| `echo >> work/pre-v1`, a hard link to `outputs/v1/old.txt` planted before the turn | **FAIL**: exit 0, `outputs/v1/old.txt` became `v1\nHL5` | **PASS**: the core detached the link before the agent started (chat warning); the write landed in the detached copy, v1 unchanged |
| `ln -s ../conversation.jsonl work/s && echo >> work/s` | **PASS**: the symlink is created, the write through it is refused | not re-run |
| `[x]` root: `sh -c 'echo >> creatives/<created after start>/conversation.jsonl'` | **FAIL**: exit 0, file changed | **PASS**: `Operation not permitted` |
| `[x]` root: `sh -c 'echo >> creatives/<existing>/conversation.jsonl'` (concrete entry) | **FAIL**: exit 0, file changed | **PASS**: refused |
| `[x]` root: `sh -c 'echo >> .studio/probe.txt'` | **FAIL**: exit 0, file created | **PASS**: refused |
| `[x]` root: `sh -c 'echo >> outputs/v1/old.txt'` (earlier version) | not run | **PASS**: refused |
| Controls (`work/` writes, a link between two `work/` files) | writable | writable |

## Setup

- Driver under the session scratchpad (`hl/driver.ts`), run with `node --experimental-transform-types`. It uses `startServer({ port: 0, configDir, vault: new MemoryVault(), claudeCommand: [wrapper], systemLocales: ['en'] })`.
  - The config dir and the workspace were fresh temp folders inside the scratchpad. The driver refused any other path and required `MOTION_STUDIO_CONFIG_DIR` to point at the temp config.
  - The calling session's Claude Code variables were removed from the environment; the `CLAUDE_CONFIG_DIR` login stayed, as in phases 8 and 9.
- Settings: `model: haiku`, `sandboxMode: auto`, `autoApproveSandboxed: true`. The doctor reported the sandbox available.
- The wrapper around the real `claude` recorded argv (including `--settings`) and tee'd the stream-json. It allowed **one** agent run per check; a second run (the creative turn's fix loop) exited 1 without starting `claude`, so those jobs end "failed" by design.
- An approval watcher would have answered `deny`. It received 0 requests.
- Each command was given to Haiku literally, one Bash call each. Results are quoted from the tool results in the stream, then checked from outside the sandbox: content, size, `nlink`, inode.
- The earlier version was set up from outside, to avoid a full generation turn:
  - `versions.json` got a v1 entry with no outputs, and `outputs/v1/old.txt` was created. The turn therefore makes v2 and protects `outputs/v1`.
  - `work/pre-v1` was hard-linked to `outputs/v1/old.txt` from outside. It stands in for a link the agent can make during the v1 turn, when `outputs/v1` is still writable: that `ln` is between two writable files, like the `work/ctl` control.

## 1. Hard links (plain workspace, before the fix)

The `denyWrite` passed to the sandbox held:
- the project files;
- the creative's three core files;
- `outputs/v1`;
- the four log globs.

| # | Command | Output | Outside check |
|---|---|---|---|
| 1 | `ln …/conversation.jsonl …/work/x && echo HL1 >> …/work/x` | `ln: …/work/x: Operation not permitted`, exit 1 | `nlink` 1, no `HL1` line |
| 2 | `ln .studio/usage.jsonl …/work/u && …` | `Operation not permitted`, exit 1 | `nlink` 1, no `HL2` |
| 3 | `ln …/versions.json …/work/v && …` | `Operation not permitted`, exit 1 | `nlink` 1, unchanged (sha `121d1a92…`) |
| 4 | `ln …/outputs/v1/old.txt …/work/o && …` | `Operation not permitted`, exit 1 | — |
| 5 | `echo HL5 >> …/work/pre-v1` (planted link) | exit 0 | **`outputs/v1/old.txt` = `v1\nHL5`**, `nlink` 2 |
| 6 | `ln -s ../conversation.jsonl …/work/s && echo HL6 >> …/work/s` | `operation not permitted: …/work/s`, exit 1 (the symlink exists; the write through it is refused) | no `HL6` |
| 7 | control: `echo c > work/ctl && ln work/ctl work/ctl2 && echo HL7 >> work/ctl2` | `c\nHL7`, exit 0 | — |

So seatbelt checks `link(2)` against the source's write rules, not only the new name. The same was confirmed with a minimal `sandbox-exec` profile outside Claude Code: `ln` onto a file under `(deny file-write* (literal …))` or a denied subpath fails, and `ln` between two allowed files works.

No "earlier versions changed" warning appeared in this run. The job failed at the second attempt (wrapper limit), and that check only runs on the success path. See Concerns.

## 2. `[x]` workspace (before the fix)

Workspace `…/hl/ws[x]/`, console turn. Creative `probe-b` was created through the API right after the wrapper saw `claude` start, so the glob is its only cover.

- **Run A**, plain `echo … >> file`: all three were refused by **Claude Code's permission layer**, not the sandbox: "Permission to use Bash with command … has been denied". That layer checks redirect targets against the Edit/Write deny rules, which use `escapeGlob` and work under `[x]`.
- **Run B**, the same through `sh -c '…'`, so only the sandbox decides:

| Command | Output | Outside check |
|---|---|---|
| `sh -c 'echo HLX1 >> creatives/probe-b/conversation.jsonl'` | exit 0 | **`HLX1` written** |
| `sh -c 'echo HLX2 >> creatives/probe-a/conversation.jsonl'` (concrete entry) | exit 0 | **`HLX2` written** |
| `sh -c 'echo HLX3 >> .studio/probe.txt'` | exit 0 | **file created** |
| control in `work/` | exit 0 | written |

The `denyWrite` held the concrete paths with `ws[x]` in them, and no globs, since the launcher skipped globs for such roots.

### What the sandbox does with `[ ]` (read from the 2.1.295 binary with `strings`, read-only)

- An entry is a glob when it contains any of `*`, `?`, `[` or `]`: `e.includes("*")||e.includes("?")||e.includes("[")||e.includes("]")`. Otherwise it is a literal `(subpath …)`.
- A glob becomes `(regex …)` through:
  ```
  "^" + e.replace(/[.^$+{}()|\\]/g, "\\$&").replace(/\[([^\]]*?)$/g, "\\[$1")
         .replace(/\*\*\//g, …).replace(/\*\*/g, …).replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") … + "$"
  ```
  plus `(/.*)?$` for the subtree.
- **`[` and `]` are not escaped.** `[x]` stays a character class matching `x`. So `…/ws[x]/…` matches `…/wsx/…` and never the real folder.
- **A backslash escape does not survive.** `\` is itself escaped, so `\[x\]` becomes a literal backslash followed by a class.
- The concrete paths are affected too: any path with `[` is a glob, which is why run B could write `.studio/`.
- A local `sandbox-exec` check of the regexes confirmed it. For `^…/w[x]/log$`, `w[x]/log` stays writable and `wx/log` is denied. The backslash form leaves both writable. `[[]x]` and `[^/]x[^/]` deny `w[x]/log` and leave `wx/log` writable.

## 3. The fix

- **`[ ]` roots.** `sandboxPath()` in `policy.ts` is applied to every concrete `denyWrite` entry (codebases, protected files and folders) and to the literal roots of the log globs. It rewrites:
  - `[` → `[[]`, a class holding only `[`, exact in seatbelt and JS regex;
  - `*` and `?` → `?`, one non-slash character: one character wider, never narrower;
  - a lone `]` stays as is: it is already literal.

  The globs are now added for every root, so the old "plain roots only" filter is gone. Paths without these characters are unchanged, so plain workspaces get exactly the same `denyWrite` as before. The replacement regex is a single character class: linear time.
- **Hard links.**
  - Before the agent starts each creative turn, the core detaches every file with `nlink > 1` in the earlier `outputs/v*` folders. Detaching means copying to a new inode, then renaming over the original. A chat warning (`level: 'warning'`, en/it, `jobs.earlierLinksDetached`) lists the files. The detach runs before the earlier-versions snapshot, so it is not reported as a change made by the turn.
  - Before and after every agent run (every job kind), the launcher detaches any core-owned file with `nlink > 1`:
    - each creative's `conversation.jsonl`, `versions.json` and `creative.json`;
    - each proposal's `log.jsonl`;
    - every file under `.studio/`.

    It warns through `onWarning`: the creative's chat, or a progress event for other jobs (`jobs.protectedLinksDetached`).
  - Defence in depth: the sandbox already refuses those links, as the table above shows.
  - Trusted copy: the bytes on disk at detach time.
    - For an earlier output, that is the file as its own turn left it. No agent ran on it since, and a version's recorded `sha256` is unchanged in any case.
    - For the logs, there is no better copy without keeping a second one. The sandbox makes such a link impossible during a job, so the check only has to stop further writes, and the warning says the content may already have changed.
  - Jobs are not refused when a link is found: detaching is the remedy, and a refusal would leave the user stuck.
  - No read-time checks were added: plan option (B) for the logs. The existing confined readers already refuse `nlink > 1` files.

## 4. After the fix (one creative turn, `[x]` workspace)

Workspace `…/hl/ws[x]-proof/`. The `denyWrite` now reads `…/ws[[]x]-proof/demo/…` for the concrete entries, and the four globs are present.

| Command | Output | Outside check |
|---|---|---|
| `sh -c 'echo HLX1 >> creatives/probe-b/conversation.jsonl'` (created after start) | `Operation not permitted`, exit 1 | empty |
| `sh -c 'echo HLX2 >> creatives/probe-a/conversation.jsonl'` | `Operation not permitted`, exit 1 | no `HLX2` |
| `sh -c 'echo HLX3 >> .studio/probe.txt'` | `Operation not permitted`, exit 1 | not created |
| `sh -c 'echo HLX4 >> …/outputs/v1/old.txt'` | `Operation not permitted`, exit 1 | — |
| `echo HL5 >> …/work/pre-v1` (planted link) | exit 0 | `outputs/v1/old.txt` still `v1\n` (sha `2d27fbdf…`), `nlink` 1; `HL5` is only in the detached `work/pre-v1` |
| `ln …/conversation.jsonl …/work/x && …` | `Operation not permitted`, exit 1 | — |
| `sh -c 'mv creatives/probe-b creatives/probe-b-moved && echo HLX7 >> …-moved/conversation.jsonl; mv … back'` | the `mv` worked; the write was refused (the glob covers any slug); moved back | — |
| control in `work/` | exit 0 | written |

Chat: "Warning: files of earlier versions had a second name on disk (a hard link) that this turn could have written through (outputs/v1/old.txt). Motion Studio detached them before the agent started, so earlier versions stay read-only."

## Tokens (Haiku, against the plan)

| Run | input | output | cache write | cache read | in + out + cw | cost at API prices |
|---|---|---|---|---|---|---|
| 1 hard links, plain | 16 | 2,563 | 33,789 | 229,899 | 36,368 | $0.0103 |
| 2A `[x]`, plain redirects | 10 | 1,134 | 18,626 | 135,570 | 19,770 | $0.0056 |
| 2B `[x]`, `sh -c` | 10 | 754 | 18,596 | 135,662 | 19,360 | $0.0055 |
| 3 proof after the fix | 18 | 2,684 | 21,410 | 276,996 | 24,112 | $0.0084 |
| **Total** | 54 | 7,135 | 92,421 | 778,127 | **99,610** | **$0.0298** |

## Cleanup

- The core and the `claude` processes were stopped after each run.
- The scratch folder `hl/` (configs, workspaces, wrapper, driver) was deleted at the end.
- User folders, mtime before → after:
  - `~/Library/Application Support/Motion Studio`: 1791461297 → 1791461297;
  - `~/MotionStudio`: 1791538433 → 1791538433.

## Concerns

- **Renaming a creative folder.** In the proof turn, `mv creatives/<b> creatives/<b>-moved` succeeded for a creative created during the job. The write was still refused, because `creatives/*/` matches any name. A move **out** of `creatives/` (e.g. `mv creatives/b tmp-b`) would leave the glob behind. That was not tried, but nothing in `denyWrite` covers it.
  - Concrete entries are safe from this: Claude Code also denies unlink/create on their ancestors.
  - This applies to plain roots too: it predates this branch (Phase 9 Task 0c).
- **The earlier-versions warning only runs on the success path.** A failed or cancelled turn never compares the earlier-version snapshot. The detach in this branch makes the planted-link route harmless anyway.
- **Linux/WSL.** Globs are skipped there, so a root with `[ ] * ?` still has no sandbox cover on Linux, as before. Only the Edit/Write rules and the core-side checks apply. Not testable here.
- **`denyRead`** (config dir, sensitive home paths) is not rewritten. It goes through a different expansion in Claude Code, and none of those paths normally contains `[`.
