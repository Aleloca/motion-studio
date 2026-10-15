# Phase 14 - live checks: brand from a codebase, identity formats (Task 7)

Date: 2026-10-15. macOS (APFS, case-insensitive volume: a file `CaseTest` is found as `casetest`), Claude Code **2.1.300**, model `haiku` (workspace setting), branch `feat/phase14-identity` at `435ff22`. Every path below under the throwaway folder is written `<tmp>`.

**Verdict:** the brand analysis from a codebase and the three identity flows work in the dev Electron app. One real gap was found: with this CLI version the `Read` deny rules for secret files stop matching when the codebase folder name combines parentheses with brackets or braces (A1 and A2 FAIL for that name; PASS for plain names). Decision 780 records it; the decision 754 fallback applies and the README says so.

| Check | Result |
|---|---|
| A1. `Read` of the fixture's `.env` refused, case variants too | **FAIL** for the folder `cb (x) [y] {z}` (every secret read succeeds); **PASS** for a plain folder name (all refused, sandbox on and off) |
| A2. CLI rule escaping (`\(`, `\)`, `[aA]`) | **FAIL (unreliable)**: `[aA]` classes work; `\(` `\[` `\{` each work alone; parentheses together with brackets or braces break every `Read` rule of that folder. Fallback of decision 754 applied, gap in the README |
| A3. Sandbox accepts `**` globs in `denyRead` | **PASS**: sandbox mode `auto`, available (Doctor `sandbox: ok`), `failIfUnavailable: true`; the analysis ran, and the globs are enforced for commands (also for the special folder name). They do not cover the `Read` tool |
| A4. Grep and Bash not offered, no approval card | **PASS** |
| A5. Brand analysis from the temp codebase (colours, font, logo; snapshot; marker) | **PASS** |
| B1. Favicon from the brand logo (set, ICO, opaque variants, Electron transparency) | **PASS** |
| B2. Logo from scratch, 3 concepts (`identity-logo`, `@2`, `@3`) | **PASS** (second attempt; see deviations) |
| B3. "Usa come logo del brand" on one concept | **PASS** |

## Setup
- **Real folders recorded first** (`stat -f %m`), see the table at the end.
- **Throwaway folders:** `mktemp -d` in the session scratch folder under the system temp folder: `<tmp>/config` (`MOTION_STUDIO_CONFIG_DIR`), `<tmp>/userdata` (`MOTION_STUDIO_USER_DATA_DIR`), `<tmp>/ws` (workspace), `<tmp>/logs`.
- **Codebase:** `packages/core/test/fixtures/brand-codebase/` copied to `<tmp>/cb (x) [y] {z}` (a name chosen to exercise the rule escaping in the real flow), plus `Secrets.JSON` and `config/.Env.Local` copied from the fixture's fake files, then `git init` and one commit. 41 files hashed (sha256) before the run. The fake marker was read into a shell variable from `.env` and only ever used with `grep -c`/`grep -l` or counted in scripts; it was never printed.
- **Dev Electron app:** `apps/desktop/dist/main.cjs` built with `pnpm --filter motion-studio-desktop build` (the web UI and the composition runtime built first), started from `apps/desktop` as `Electron . --use-mock-keychain --password-store=basic` (the workspace's Electron 44.7.0 binary, `exec`'d so the recorded PID is the main process). Before launch the script printed and checked `USER_DATA=<tmp>/userdata` and `CONFIG=<tmp>/config`; the app logged "MOTION_STUDIO_USER_DATA_DIR set, Electron data in <tmp>/userdata".
- **Keychain:** `NODE_OPTIONS=--require <tmp>/bin/bootstrap.cjs` registered a Node module hook that resolves `@napi-rs/keyring` to an in-memory stand-in (logged "keyring stub active"), so the core's `KeyringVault` never reached the real keychain; Chromium had the mock keychain. No keychain window appeared. No provider key was set, not even a fake one.
- **Claude command:** `MOTION_STUDIO_CLAUDE_COMMAND` pointed at a wrapper that removed the calling session's Claude Code variables and `NODE_OPTIONS`, recorded cwd and argv, and tee'd the stream-json to `<tmp>/logs`, then ran the real `claude` with the product's own arguments. The user's Claude login (`CLAUDE_CONFIG_DIR`) passed through.
- **Driving:** the app window was open but not clicked. Every flow went through the core HTTP API of the running dev app (port from `<tmp>/config/run/server.json`, header `x-motion-studio-ui` from `<tmp>/config/ui-token`), the same calls the web UI makes: `PUT /api/workspace`, `PUT /api/settings {model: haiku, sandboxMode: auto}`, `POST /api/projects`, `POST …/brand/sources`, `POST …/brand/analyze`, `POST …/brand/proposals/:id/apply`, `POST …/creatives`, `POST …/versions/1/render`, `POST …/formats/:f/use-as-brand-logo`. `GET /api/render-engine` answered `{"kind":"electron"}`, so every render and rasterisation ran in the Electron provider. `/api/approvals` was polled every 5 s during every job.
- **Direct CLI probes (A1-A3):** `claude -p` in `<tmp>/probe/proj`, `--no-session-persistence`, `--output-format stream-json`, `--model haiku`, `--strict-mcp-config` (no MCP server, so no approval tool: anything not allowed is refused), with the `--add-dir`, `--settings`, `--disallowedTools` and `--allowedTools` **taken byte for byte from the argv the app passed to the brand analysis**. A variant keeps only some of the codebase `Read` deny rules (`full`: all 70; `exact`: the 32 exact-case `/**/` rules; `folded`: the 32 case-folded ones; `none`), and `PROBE_SANDBOX=off` replaces the settings with `{}`. Copies of the codebase with other names got the same rules with the folder name substituted (the escaping `escapeGlob` applies). A judge script printed each tool call's target and whether it succeeded, with only the length of a successful result, and the marker count.

## A. Brand from a codebase

### A5. The analysis (real flow)
- Job `brand-analysis` succeeded in 48 s, cost $0.0166, 24 turns. Approvals seen: **0**.
- CLI argv (decoded from the wrapper): `--add-dir <tmp>/cb (x) [y] {z}`, `--allowedTools Read(//<tmp>/cb \(x\) \[y\] \{z\}/**) Glob(//…/**)` plus the `studio` MCP tools, `--disallowedTools … Bash Grep WebFetch`, the 70 exact, case-folded and concrete `Read` rules of the codebase, and `--settings` with `sandbox.enabled: true`, `failIfUnavailable: true`, `denyWrite` = the codebase, `denyRead` = the concrete secrets plus 68 `<tmp>/cb (x) [[]y] {z}/**/<pattern>` globs.
- The CLI's `init` event listed the tools: `Read`, `Glob`, `Write`, `Edit`… and the MCP tools; **no `Bash`, no `Grep`, no `WebFetch`**.
- Tool calls: `Glob` (3, names only), `Read` of `tailwind.config.js`, `src/theme.css`, `public/manifest.json`, `public/logo.svg` and of the proposal files, `import_codebase_file {source: public/logo.svg, dest: assets/brand/logo.svg}`, `fonts_fetch Inter 400/700` (Google Fonts), four `Write` into the proposal folder. No secret file was opened. `permission_denials: []`.
- Proposal: colours `#1E3A5F` primary and `#F28C28` accent (`src/theme.css`), `#FFFFFF` background (`public/manifest.json`); font Inter heading (`tailwind.config.js`) and body (`src/theme.css`); logo `assets/brand/logo.svg` (`public/logo.svg`), every entry with `source.kind: codebase`. The copied logo has the same sha256 as the fixture's.
- Snapshot: content hashes of all 41 files identical before, after the analysis and at the end; `git status --porcelain --ignored` empty. Only mtimes in `.git` moved: `.git/index` at 13:55:29, by our own `git status` while taking the "before" hashes, before the job started at 13:56:59; the `.git` folder itself at 13:57:46, the end of the job, by the core's own after-snapshot `git status` (git's optional index lock). See findings.
- Marker (`grep -rlF`, counts only): `<tmp>/ws` (project, proposal, `log.jsonl`, conversations, assets, git objects as text) **0** files; `<tmp>/config` **0**; `<tmp>/userdata` **0**; the 11 app-run stream logs **0**; the Electron stdout **0**; the CLI transcripts of the temp project in the Claude config folder **0** (2 folders). Checked again after all the B flows: still 0 everywhere.

### A1/A2. Secret reads with the emitted rules (direct probes)
Prompt (each probe): call `Read` once per listed absolute path, never repeat file content.

| Probe | Folder | Rules kept | Sandbox | `.env` | `.ENV` / `.Env` | other secrets | `public/logo.svg` |
|---|---|---|---|---|---|---|---|
| A1-full | `cb (x) [y] {z}` | all 70 | on | **read** | **read** | `config/.Env.Production`, `Secrets.JSON`, `secrets.json` **read** | read |
| A1-plain-full | `cbplain` | all 70 | on | refused | refused | all refused | read |
| A1-plain-exact | `cbplain` | exact 32 | on | refused | refused | `config/.ENV.production`, `SECRETS.json` refused | - |
| A1-plain-folded | `cbplain` | folded 32 | on | refused | refused | refused | - |
| A1-plain-nosb-full / exact / folded | `cbplain` | 70 / 32 / 32 | off | refused | refused | refused | read |
| A2-paren / bracket / brace / space | `cb (x)`, `cb [y]`, `cb {z}`, `cb x` | exact 32 | off | refused | refused | - | read |
| A2-bb | `cb [y] {z}` | exact 32 | off | refused | - | - | read |
| A2-pb / A2-pc | `cb (x) [y]`, `cb (x) {z}` | exact 32 | off | **read** | - | - | read |
| A2-combo-exact / folded | `cb (x) [y] {z}` | 32 / 32 | off | **read** | **read** | - | read |
| A2-noparen | `cb (x) [y] {z}`, rules with `(x)` unescaped | exact 32 | off | **read** | - | - | read |
| A3-plain-sbonly | `cbplain` | none | on | **read** | **read** | - | read |

- Refusals all read "File is in a directory that is denied by your permission settings." Every probe exited 0; costs $0.0009-0.0074 each.
- What this shows: the CLI matches `Read` rules **without regard to letter case** on its own (the exact rules refuse `.ENV`, `SECRETS.json`); the `[aA]` classes work (the folded rules alone refuse everything); the escapes work one kind at a time; **a folder name with parentheses plus brackets or braces makes no `Read` rule of that folder match**, escaped or not; the sandbox `denyRead` does **not** apply to the `Read` tool (A3-plain-sbonly). So for such a folder only the prompt keeps the agent away from secrets; in the real analysis it complied (A5).
- The probe outputs that held the fake marker (7 files: the probes marked **read** above) were deleted from the scratch folder after counting.

### A3. Sandbox `**` globs
- Sandbox mode `auto`; Doctor `sandbox` ok (macOS seatbelt). The analysis started with `failIfUnavailable: true` and the 68 glob entries and finished: the CLI accepted them.
- Enforcement, with `Bash` allowed only in the probe (the app never allows it): `wc -c` on `.env`, `.ENV`, `Secrets.JSON`, `config/.env.production` → "open: Operation not permitted"; `public/manifest.json` → read. The first four are also concrete entries, so two files were created **after** the launch scan, `nested/deep/.ENV.late` and `nested/Credentials.txt`: both refused by the sandbox ("Operation not permitted", 0 "No such file"), in `cbplain` and in a copy named `cb (x) [y] {z}` (sandbox paths use the `[[]` escaping, which works).

### A4. Grep and Bash
- Not offered: absent from the `init` tool list of the app's run and of every probe without `Bash` added; listed in `--disallowedTools`.
- No approval card: `/api/approvals` was empty at every poll of every job (0 requests in the whole run). The `approve` auto-deny path was therefore never reached: the CLI does not offer the tools at all.

## B. Identity formats (dev Electron app, Electron render provider)

### B1. Favicon from the brand logo
- `POST …/creatives` with `formats: ["identity-favicon"]`, `identity: {start: "brand"}`: job succeeded in 36 s, $0.0117, 0 approvals. The agent copied the brand logo into the composition (`fit: contain`, background `#FFFFFF`, duration 0, one `svg` clip); `favicon.svg` is the brand logo with width and height set to 1024 (adapted, not redrawn).
- `POST …/versions/1/render`: succeeded in 3 s. Render engine `electron`. Note: "icon-512-maskable.png: 7.7% of the drawing is outside the safe zone…" (a square mark at 72%, as decision 762 expects).
- The transparency probe runs before every transparent rasterisation and fails the job if alpha is lost; the job succeeded, and the outputs confirm it.
- Set (`outputs/v1/identity-favicon/`): `apple-touch-icon.png`, `favicon.ico`, `favicon.svg`, `head-snippet.html`, `icon-192.png`, `icon-512-maskable.png`, `icon-512.png`, `site.webmanifest`: the 8 files of the spec.

| File | ffprobe | corner RGBA | centre RGBA |
|---|---|---|---|
| `identity-favicon.png` (main) | 1024×1024 rgb24 | 255,255,255,255 | 242,140,40,255 |
| `apple-touch-icon.png` | 180×180 **rgb24** | 255,255,255,255 | 242,140,40,255 |
| `icon-192.png` | 192×192 **rgba** | **0,0,0,0** | 242,140,40,255 |
| `icon-512.png` | 512×512 **rgba** | **0,0,0,0** | 242,140,40,255 |
| `icon-512-maskable.png` | 512×512 **rgb24** | 255,255,255,255 | 242,140,40,255 |

- ICO: header reserved 0, type 1, 3 entries, 16/32/48, 32 bpp, each a PNG (signature checked) that ffprobe reads as `rgba` at its size and `ffmpeg -f null` decodes with exit 0 and no error output.
- `site.webmanifest`: 3 icons, the maskable one with `purpose: maskable`, `theme_color #1e3a5f` (brand primary), `background_color #ffffff`. `head-snippet.html`: icon (ICO and SVG), apple-touch-icon, manifest, theme-color.

### B2. Logo from scratch, 3 concepts
- `formats: ["identity-logo", "identity-logo@2", "identity-logo@3"]`, `identity: {start: "scratch", name: "Acme", keywords: "calm, geometric, friendly", colors: "brand", concepts: 3}` (the body `NewCreative` sends: `conceptIds` expands the concepts in the UI). Job succeeded in 63 s, $0.0177, 0 approvals; the agent validated and previewed all three.
- Render: succeeded in 2 s. `outputs/v1/` has `identity-logo.png`, `identity-logo@2.png`, `identity-logo@3.png` and the folders `identity-logo/`, `identity-logo@2/`, `identity-logo@3/`, each with `logo.svg` and `logo.png`. The three `logo.svg` differ (three sha256); no `<text>` in any. Each `logo.png` is 1024×1024 `rgba` with transparent corners (0,0,0,0); the main images are `rgb24` on the white background. A contact sheet of the three (in the scratch folder, not committed) shows three distinct ideas: an "A" tile, a sunrise with the word "Acme" as paths, a tile with three bars.

### B3. "Usa come logo del brand"
- `POST …/versions/1/formats/identity-logo%402/use-as-brand-logo {variant: "primary"}` → 200 `{file: "assets/brand/2026-10-15-acme-logo-three-concepts-v1-identity-logo-2.svg", variant: "primary", committed: true}`.
- The file is in `assets/brand/` and byte-identical to `outputs/v1/identity-logo@2/logo.svg`. The kit gained `{file: that path, variant: primary, source: {kind: manual, ref: "creative:2026-10-15-acme-logo-three-concepts/v1"}}`; the project's git log has "Brand kit updated"; the asset is registered with origin `generated` and tags `brand`, `logo`.

## Deviations
- **B2, first attempt.** The first `POST …/creatives` sent `formats: ["identity-logo"]` with `concepts: 3`, expecting the core to expand it; the core does not (the UI does, decision 769). That job was stopped through `POST /api/jobs/:id/stop` after 22 s (state `cancelled`) and the creative was made again with the body the UI sends. The stopped creative stays in the throwaway workspace.
- **No UI clicks, no screenshots of the app window.** The flows were driven through the running app's API; the only image is the concept contact sheet, in the scratch folder.
- **Electron environment.** The launch script's attempt to drop the calling session's Claude Code variables from Electron's own environment failed (BSD `sed` has no `\|`); they were removed in the claude wrapper instead, before every `claude` run, which is where they matter.
- **Electron binary download.** The first `electron --version` through the npm shim printed "Downloading Electron binary…" (the shim checks its cache); the binary in `node_modules` was used for the launch.

## Findings
1. **Secret-file rules and folder names (Important, decision 780).** See A1/A2. Suggested follow-up: refuse such codebase paths at the route with a clear code until the CLI handles them. The web hint "never opens secret files" is not true for them.
2. **The core's snapshot touches `.git` (Minor).** The after-analysis `git status` changed the `.git` folder's mtime (git's optional index refresh). Content is unchanged; `git --no-optional-locks` (or `GIT_OPTIONAL_LOCKS=0`) would leave the user's repository untouched.
3. **Brand logo tags (Minor).** The codebase logo imported in A5 ended with tags `logo, primary, svg, icon` and no `brand` tag (decision 754 says every import is tagged `brand`); the proposal's `assets.json` written by the agent seems to replace the import's tags. Not investigated further.
4. **Two primary logos.** After B3 the kit has two logos with `variant: primary` (the codebase one and the new one). Expected by design (the action adds, it does not replace), worth a look in the UI.
5. **`report_progress` misuse by haiku.** In both creative turns the agent first called `report_progress` with invalid arguments ("Invalid progress message"), then corrected itself.

## Cost
App runs: analysis $0.0166, favicon $0.0117, logo concepts $0.0177, the stopped job not summed. Direct probes: 21 runs, about $0.066 in total. Doctor's `claude --version`/auth checks: no model call.

## Processes
The Electron main process (one recorded PID, its command line checked) got SIGTERM and exited within 2 s with its 3 helper children. None of the 11 wrapper PIDs (claude runs, Doctor checks) was alive at the end. Nothing was killed by pattern.

## Full suite (once, after the docs)
`MS_REQUIRE_CHROME=1 pnpm test` with a throwaway `MOTION_STUDIO_CONFIG_DIR`, stdin from `/dev/null` (701.7 s): **exit 1**, 311 files (309 passed, 2 failed), 6118 tests (6116 passed, 2 failed). Neither failure is a Chrome load timeout, so nothing was rerun:
- `packages/web/test/theme.test.ts` › "has no legacy aliases or global classes left (Task 16)": the check `not.toContain('--surface')` matches the new Phase 14 tokens `--surfaceLight`/`--surfaceDark` (added in `a87cc0a`, decision 770). Deterministic: a real conflict between the old substring check and the new token names.
- `packages/web/test/FormatView.test.tsx:575` › "the storyboard strip lists the scenes; a click seeks there" (5.3 s): the Play button was still disabled after the runtime's ready message (`expected true to be false`). Not investigated; it may be load-dependent.

`pnpm typecheck` exit 0, `pnpm check:i18n` exit 0 ("check:i18n ok"), `pnpm build` exit 0.

## Real folders (mtimes)
| Folder | Before | After the live checks | After the full suite |
|---|---|---|---|
| `~/Library/Application Support/Motion Studio` | 1792005599 | 1792005599 | 1792005599 |
| `~/MotionStudio` | 1792004787 | 1792004787 | 1792004787 |
| `~/Library/Application Support/Motion Studio Electron` | 1792006312 | 1792006312 | 1792006312 |
| `~/Library/Application Support/Electron` | absent | absent | absent |
