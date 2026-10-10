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

- **Moving a record folder out and back (corrected after review).** The sandbox denies writes by path, so a folder that is not pinned can be moved out, edited and moved back. No `denyWrite` entry can pin a folder alone: a glob deny always covers the folder and everything below it.
  - **Plain roots.** Concrete entries are pinned: Claude Code also denies unlink/create on their ancestors. A creative created during the job has only the glob, which pins `creatives/` but not `creatives/<new>`. This predates this branch (Phase 9 Task 0c).
  - **Roots with `[ ] * ?`.** After `sandboxPath` every concrete entry is a glob, and Claude Code pins ancestors only up to the first glob character. Every creative, `creatives/` itself and `outputs/` can be moved out and back, existing creatives included. Confirmed live after the review (section 5).
  - What the core does about it is in "Fixes after review" below: a warning for such roots, and an after-run check of the record folders and of the logs' history.
- **The earlier-versions warning only runs on the success path.** A failed or cancelled turn never compares the earlier-version snapshot. The detach in this branch makes the planted-link route harmless anyway.
- **Linux/WSL.** Globs are skipped there, so a root with `[ ] * ?` still has no sandbox cover on Linux, as before. Only the Edit/Write rules and the core-side checks apply. Not testable here.
- **`denyRead` (corrected after review).** It goes through the same glob conversion as `denyWrite` on macOS, so a config dir or home path with `[` was not protected either. It now goes through `sandboxPath` too.

## Fixes after review

- **`[ ] * ?` roots.**
  - Once per job, the chat (or a progress event) says the workspace path weakens the sandbox (`jobs.workspacePathGlob`).
  - The doctor has a new optional check, `workspace-path`, that fails for such a path.
  - `sandboxPath` also rewrites `denyRead`.
- **After-run tripwire** (`packages/core/src/agent/run-tripwire.ts`, every job). It is armed before the run and checked after the leftover processes are killed.
  - It records the inode, mtime and ctime of `creatives/`, `brand/proposals/` and each `creatives/<slug>/`. A move out and back changes the moved folder's ctime and its parent's mtime (measured on APFS).
  - The core records its own changes to those folders (`noteCoreChange`):
    - atomic JSON writes;
    - creating a creative or a proposal;
    - making `outputs/`, which a creative turn now makes before the agent runs;
    - detaching a link.

    A folder whose new times are not later than the core's last change (5 ms slack) counts as explained.
  - Any other change is reported: `jobs.recordFoldersMoved`.
  - Known limits:
    - a move followed by a later core change to the same folder is not seen;
    - a file the agent writes at the top of a creative folder (outside `work/` and `outputs/`) is reported too.
- **Log history** (only for roots with `[ ] * ?`, where the move works on every creative). The size and sha256 of each `conversation.jsonl` and proposal `log.jsonl` are taken at the start, and the same byte range is compared at the end.
  - A rewrite or a cut is reported: `jobs.logHistoryRewritten`.
  - New forged lines after that range are not detected.
  - **Not restored.** A restore needs a byte copy of every log at every run start, plus a record of the core's own appends. That was left out as too heavy for this fix.
- **Order.** The launcher calls `killGroup` at the end of every run, for every job kind, before the after-run detach and the tripwire. Before, brand and console jobs never called it, and creative turns called it only after the launcher's checks.
- **More files detached:**
  - `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`;
  - `.claude/**`;
  - `.git/config` and `.git/hooks/**`.

  `.git/objects` is skipped: `git clone --local` hard-links it on purpose.
- **Detach hardening:**
  - the source is opened with `O_NOFOLLOW` and must be the inode that was `lstat`-ed;
  - before the rename, the name is `lstat`-ed again (inode, size, mtime), and the copy is redone (up to 3 tries) if anything changed;
  - files of 1 MiB and more are cloned with `COPYFILE_FICLONE`, then checked against the open handle (Node cannot clone from a handle);
  - smaller files are copied from the handle;
  - parent folders must be real folders: `creatives/`, `brand/`, `brand/proposals/`, and each folder from the creative down to `outputs/vN`;
  - temp files (`.<name>.detach-<12 hex>`) left by a crash are removed on the next pass.
- **Not changed (M8).** A console job's warning is a progress event: it is broadcast live but not kept.

## 5. Live check after the review (one creative turn, `[x]` workspace)

- **Doctor:** the `workspace-path` check failed, as intended, with "The path contains [ ] * or ?: …".
- **Turn:** creatives `probe-a` and `probe-b` existed before the job. `probe-b` had one line of earlier history, written from outside.

| Command | Output | Outside check |
|---|---|---|
| `sh -c 'mv creatives/probe-a moved-a && echo HLM1 >> moved-a/conversation.jsonl && mv moved-a creatives/probe-a'` | exit 0 | `HLM1` is in `probe-a`'s log: the attack works, as the review predicted |
| `sh -c 'mv creatives/probe-b moved-b && : > moved-b/conversation.jsonl && mv moved-b creatives/probe-b'` | exit 0 | `probe-b`'s earlier history is gone |
| `sh -c 'echo HLM3 >> creatives/probe-a/conversation.jsonl'` (direct) | `Operation not permitted`, exit 1 | — |

The chat of `probe-a` then showed three warnings:
1. the workspace path warning;
2. "folders that hold Motion Studio's records changed in a way Motion Studio did not make (creatives, creatives/…-probe-a, creatives/…-probe-b)";
3. "earlier lines of creatives/…-probe-b/conversation.jsonl were changed or removed".

The appended `HLM1` line is caught only by the folder warning, not by the history check, as documented.

Tokens: 8 input, 1,216 output, 19,976 cache write, 108,859 cache read; 21,200 shown; $0.0057. User folder mtimes were unchanged (1791461297, 1791538433), and the scratch folder was deleted.

## Fourth round (review 3 fixes)

- **Git config from git itself (M1).** `inspectGitSafety` now:
  - requires `.git` to be a real folder (a `gitdir:` file or a link blocks);
  - blocks when `.git/commondir` or `.git/config.worktree` exists;
  - treats any read error other than ENOENT as unsafe;
  - runs `git config --list --show-origin --null` with the hardened env. Every key must come from `<project>/.git/config` (or the core's own `-c`) and pass the allowlist.
  - Every inherited `GIT_*` is dropped. `GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR` are pinned on every call except `init`.
  - The review's commondir demo is now a test: the filter does not run and the commit is refused.
- **Second tier (compatibility ruling).**
  - Allowed: `remote.<n>.url/pushurl/fetch` and `branch.<n>.remote/merge/rebase`, unless the value contains `!`, `ext::`, `--upload-pack` or `--receive-pack`.
  - Allowed: built-in `diff=<name>` attributes, while no `diff.<name>.*` config exists.
  - Still blocked: `filter.*` (git-lfs included) and `diff.*.textconv/command`.
  - Each block message names the key and the fix, in en and it.
  - The core never fetches, pushes or pulls (checked: the only git callers are `git.ts`, `codebases.ts` and `doctor.ts`).
- **Every attributes file (M4).**
  - `git ls-files -z --cached --others -- ':(glob)**/.gitattributes'` lists tracked, untracked and ignored files, plus `.git/info/attributes`.
  - Only a line that starts with `#` is a comment.
  - Cost: about 0.17 s on 30k ignored files.
- **Integrity by snapshot (M2, I1).** `project-integrity.ts` re-enumerates the protected set at arm and at check, so an added path counts too. The set:
  - `CLAUDE*.md`, `.mcp.json`, `.gitattributes`;
  - the kind of `.git`, `.claude` and `.studio`;
  - `.git/config`, `HEAD`, `info/attributes`, `commondir` and `config.worktree`;
  - `.git/hooks/**`, `.claude/**`;
  - `.studio/permissions.json`.

  Core writes note their content (`noteCoreFile`, from `writeJsonFileAtomic` and the `.gitattributes` maintenance), so a `PermissionsStore` write is quiet and a foreign one trips.
- **Persistent quarantine (M3).**
  - Stored in `<configDir>/integrity/<hash>.json` with the expected (pre-run) snapshot.
  - `AgentLauncher.start` and `Git` refuse while it is set, across restarts.
  - It clears by itself once the files match again.
  - The reason goes to the chat (`errors.projectQuarantined`, `jobs.protectedFilesTampered`).
- **Fail closed (I3).** If `check()` throws, the job fails and the project is quarantined.
- **Last good state (I4).** Each clean check saves the snapshot. The next arm compares against it, and a difference quarantines the project and refuses the launch (`jobs.protectedFilesChangedBetweenRuns`). Core writes update the saved state.
- **`.gitattributes` (I2).** It is now in the sandbox `denyWrite`, the Edit/Write deny rules, the link detach and the prompt's protected list. The core's own `completeGitignore` write is noted.
- **`codebases.ts`.**
  - `diff --no-ext-diff --no-textconv`;
  - `hash-object --no-filters`;
  - no `GIT_EXTERNAL_DIFF`.
- **Residual (closed in round 5).** A deliberate user edit to a protected file between runs locks the project until it is undone or accepted.

## Fifth round (test isolation, accept action)

- **Test isolation.** Every package's vitest config loads `test-support/isolate-user-data.ts`. Per test file, it points these at a temp folder:
  - `MOTION_STUDIO_CONFIG_DIR`, `HOME` and `USERPROFILE`;
  - `XDG_CONFIG_HOME` and `APPDATA`.
- **Refusals under vitest.**
  - `defaultConfigDir()` throws instead of returning a real path.
  - `AppConfigStore`, `IntegrityStore` and `WorkspaceStore.open` refuse the real config folder and `~/MotionStudio`. The home they compare against is the account's home from the user database, not `$HOME`.
  - `test/test-isolation.test.ts` guards all of this.
- **Integrity routes.**
  - `GET /api/projects/:slug/integrity` returns `{ quarantined, files: [{ path, change }], gitProblem, token }`.
  - `POST /api/projects/:slug/integrity/accept` takes `{ token }`. It needs the UI token and passes the same origin checks as the other routes.
  - It refuses with 409 `integrity-changed` when the files changed after the list was shown.
  - It refuses with 409 `git-unsafe` while a git problem remains: a key outside the allowlist, an attributes driver, a `commondir`, a `config.worktree` or a `gitdir:` file. Those are never acceptable.
  - Otherwise the current snapshot becomes the new baseline and the quarantine is cleared.
- **UI.** `components/IntegrityNotice.tsx` (`useIntegrity`) shows on the project page, the brand page, the creative canvas and the format view.
  - It lists the changed, added and removed files, then offers "Accept these changes".
  - The confirmation dialog shows "Only accept if you made these changes yourself" (it: "Accetta solo se hai fatto tu queste modifiche").
  - A git problem is shown in its own box, with the remedy and no accept action.
  - The notice is re-checked when a job ends or the project changes.
