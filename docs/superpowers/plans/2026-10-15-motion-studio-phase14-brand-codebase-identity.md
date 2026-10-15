# Motion Studio — Phase 14: Brand from a codebase, store pack in the formats list, identity formats — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Brand analysis can read a codebase, read-only and without secrets, alongside or instead of a website.
- The App Store / Google Play pack is an entry of the formats list. It can be added to, edited in or removed from any creative.
- New identity formats are available: logo (SVG + PNG), favicon set (ICO, SVG, PNGs, manifest, head snippet), app icon set (iOS + Android adaptive), and Open Graph image. Each can start from the brand logo or from scratch.

**Architecture:**
- **Brand:** brand analysis gains a `codebase` source kind. The launcher passes those folders like creative codebases (`--add-dir`, read-only rules, `denyWrite`) plus secret read-deny rules. A new MCP tool `import_codebase_file` copies files in, and snapshot checks run before and after the turn.
- **Store pack:** it becomes brief data editable through `updateBrief` (`storePack` set, changed or cleared), with instances recomputed by `storePackFormats`. The web shows it as a pseudo-entry in the format pickers and as one group in the creative's format column.
- **Identity:** identity formats are still compositions in "vector mode" (exactly one full-frame `svg` clip). After the agent's turn the core validates the SVG strictly, rasterises it in isolated Chrome at every target size, and writes a set: PNGs, ICO, flattened opaque variants, manifest, snippet, `Contents.json`, adaptive XML.

**Tech Stack:** TypeScript, zod, Fastify, React 19, the existing Chrome/CDP render harness, ffmpeg (existing `flattenPng`). No new runtime dependencies: the ICO writer and SVG checker are hand-written.

**Spec:** `docs/superpowers/specs/2026-10-15-motion-studio-phase14-brand-codebase-identity-design.md`. Read it first, then `docs/decisions-log.md` entries 720–735.

## Global Constraints

**Codebase access.**
- Brand-analysis codebases are always read-only:
  - `--add-dir` for each;
  - `Edit(//path/**)` and `Write(//path/**)` denied;
  - in `denyWrite` when sandboxed.
- Secret patterns (spec §2.2) are denied for `Read`/`Grep`/`Glob` results and for `import_codebase_file`.
- Paths are validated with `normalizeCodebasePath` and `codebaseOverlaps` and resolved with `realpath` before any containment check.

**SVG outputs.**
- Nothing reaches an output or the brand kit without passing `checkVectorSvg` (Task 4).
- Rasterisation uses the render isolation and `BASE_FLAGS` (mock keychain, basic password store).

**Compatibility.**
- `brand-kit.json`, `brand sources`, `creative.json` and the format catalog change additively.
- Old creatives created through `POST …/creatives/store-pack` keep working.

**Providers.** No real calls to paid providers, not even with fake keys. Use the injected fake fetch and `MemoryVault`, plus a temp `MOTION_STUDIO_CONFIG_DIR`.

**Real folders.**
- Check mtimes before and after any live check. Baselines:
  - `~/Library/Application Support/Motion Studio`: 1792005599;
  - `~/MotionStudio`: 1792004787;
  - `~/Library/Application Support/Motion Studio Electron`: 1792006312;
  - `~/Library/Application Support/Electron`: absent.
- Use `MOTION_STUDIO_USER_DATA_DIR` for every Electron launch. No packaged app launches.

**Chrome.** Every launch passes `--use-mock-keychain` and `--password-store=basic`, through the existing harness or `BASE_FLAGS`. The guard test from 102b381 must stay green.

**Tests (decision 702).**
- Per task: only the changed and related test files, plus `pnpm typecheck` and `pnpm check:i18n`. Run the Chrome tests only when a task touches rendering, preview or layout.
- Run the full suite once at the end of the batch.

**Process.**
- No push, PR, release or publish.
- Never kill processes by pattern: kill only PIDs you started and verified.
- No `git stash`, `git reset`, `git checkout -- <path>`, `git clean`, amend, rebase or history rewrites.
- Run every script with cwd = the phase worktree, never the main checkout.
- Commit trailers exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01KxKL6zuy8dbnJieqN1eCNg`
- Decisions-log entries from 740 on. 720–735 are the orchestrator's for this phase.
- On a safety-classifier stop: stop, report, never rephrase around it.

## Review Focus

1. **A codebase that tries to escape.**
   - Inputs: a symlink inside the codebase pointing to `~/.ssh` or to the project; `import_codebase_file` with `../`, an absolute path elsewhere, a path whose realpath leaves the codebase; a secret named `config/.env.production`; a 60 MB file; the 41st call.
   - Expected: every one refused with a clear reason, nothing copied, the analysis continues.
   - Tests in Task 2.
2. **The agent writes into the codebase anyway**, for example through a Bash tool that slipped through.
   - Expected: the snapshot catches it; the proposal is discarded; the UI names the folder; the log lists the changed files.
   - Non-git folders get the "not checkable" note but analysis still runs.
   - Tests in Task 2 with a fake runner that touches the folder.
3. **A hostile or broken SVG from the agent.**
   - Inputs: `<script>`, `onload=`, `<foreignObject>`, `xlink:href="https://…"`, `<image href="data:…">`, `style="background:url(…)"`, `@import` in `<style>`, 600 KB, an unclosed tag, a `<text>` element.
   - Expected: refused, with the reason in the repair turn. `<text>` is accepted with a warning. Nothing is rasterised from a refused SVG.
   - Tests in Task 4.
4. **Editing the store pack in a mixed creative.**
   - Cases: pack + `youtube-16x9` + a hand-picked `appstore-iphone-69@3`; then reduce screenshots from 5 to 3; then remove the pack.
   - Expected: only pack instances change; the hand-picked instance and the YouTube format stay with their labels; versions of removed instances stay in history; export of the pack lists only pack formats.
   - Tests in Task 6.
5. **Tiny sizes and opacity.**
   - Expected:
     - the 16 px favicon comes from the `small` composition when present, otherwise from the master;
     - the ICO has exactly 16/32/48 PNG entries that decode;
     - `apple-touch-icon`, iOS 1024 and Play 512 have no alpha channel (ffprobe `pix_fmt` without `a`);
     - a master with transparent background and no brand primary flattens onto white with the warning.
   - Tests in Task 4 (Chrome for rasterisation).

---

### Task 0: UX 1 follow-ups (spec §5)

**Files:**
- Modify: `packages/composition-runtime/src/layer-agent.ts`, `packages/composition-runtime/src/page.ts` (if the frame pump lives there), `packages/shared/src/i18n/{en,it}.ts`, `packages/web/src/**` (the layer-timeout message mapping), `docs/decisions-log.md` (709 half sentence).
- Test: `packages/composition-runtime/test/chrome.integration.test.ts` (offscreen case), `packages/composition-runtime/test/layer-pump.test.ts`.

**Interfaces:** produces the error code `layerStalled` (new) next to `layerTimeout`; the UI maps it to its own translated string.

- [ ] **Step 1. Failing tests:**
  - Chrome: a composition whose html layer sits fully outside the frame (`x: -5000`) renders without timing out;
  - unit: a stall produces `layerStalled`, not `layerTimeout`;
  - i18n: `web.render.storyboardNone` is gone and no code references it.
- [ ] **Step 2.** Run, expect FAIL.
- [ ] **Step 3. Implement.** Offscreen layers keep receiving frames in render mode: drive their rAF from the virtual clock, or keep them in the viewport but clipped. Pick the smaller safe change and log it from 740.
- [ ] **Step 4.** Run, expect PASS, Chrome tests included with the harness.
- [ ] **Step 5. Commit:** `fix(runtime): offscreen html layers render; distinct stalled-layer error (UX1 follow-ups)`.

---

### Task 1: Shared models — codebase brand source, origins, identity formats

**Files:**
- Modify: `packages/shared/src/brand.ts`, `packages/shared/src/library.ts`, `packages/shared/src/formats.ts`, `packages/shared/src/creative.ts`, `packages/shared/src/i18n/{en,it}.ts`
- Create: `packages/shared/src/identity.ts`
- Test: `packages/shared/test/{brand-codebase-source,identity-formats}.test.ts`

**Interfaces:**
```ts
// brand.ts
sourceRefSchema.kind: 'manual' | 'website' | 'image' | 'codebase'      // ref = path relative to the codebase
brandSourceSchema: kind 'codebase' with { path: string /* absolute after normalisation */, note?: string } ; max 5 codebase sources (BRAND_KIT_LIMITS.codebaseSources = 5)
// library.ts
AssetOrigin adds 'codebase'
// formats.ts
FormatPreset gains optional `identity?: 'logo' | 'favicon' | 'app-icon'`
new presets, channel 'Identità' / 'Identity' via i18n:
  identity-logo 1024x1024 (kind 'image', identity 'logo')
  identity-favicon 1024x1024 (identity 'favicon')
  identity-app-icon 1024x1024 (identity 'app-icon')
  og-image-1200x630 1200x630 image, extensions ['png','jpg','jpeg'], maxFileMB 5 (channel 'Web')
// identity.ts
export const SECRET_PATTERNS: readonly string[];            // spec §2.2 list, glob form
export function isSecretPath(rel: string): boolean;          // matches any segment/basename
export interface IdentityBrief { start: 'brand' | 'scratch'; name?: string; keywords?: string; colors?: 'brand' | 'free'; concepts?: number /* 1–5, logo from scratch only, default 3 */ }
export const identityBriefSchema: z.ZodType<IdentityBrief>;
export interface IdentityOutputFile { path: string; width?: number; height?: number; alpha?: boolean; role: string }
export const IDENTITY_SETS: Record<'logo'|'favicon'|'app-icon', { files: Array<{ path: string; size?: number; opaque?: boolean; from?: 'master'|'small'|'auto' }> }>;
// creative.ts: brief.identity?: IdentityBrief (applies to every identity format of the brief)
```
- [ ] **Step 1. Failing tests:**
  - schema accepts or refuses codebase sources (relative path, root, more than 5);
  - `isSecretPath` table: `.env`, `a/.env.local`, `x.pem`, `ios/GoogleService-Info.plist` match; `env.ts`, `keys.md` and `src/secretsauce.ts` do not, unless they match `secrets*` (decide and pin it);
  - the new presets have the right size, kind and extensions;
  - `IDENTITY_SETS` lists exactly the spec §4.1 files;
  - `identityBriefSchema` defaults and limits.
- [ ] **Steps 2–4.** FAIL → implement → PASS. Add i18n keys for the channel, the presets, "Partenza", "Dal logo del brand", "Da zero" and the source label "da codebase".
- [ ] **Step 5. Commit:** `feat(shared): codebase brand sources and identity format models`.

---

### Task 2: Core — brand analysis reads a codebase

**Files:**
- Modify:
  - `packages/core/src/brand/brand-analysis.ts`, `packages/core/src/brand/brand-prompt.ts`;
  - `packages/core/src/server/brand-routes.ts`;
  - `packages/core/src/agent/{launcher.ts,policy.ts,runner.ts,codebases.ts}`;
  - `packages/core/src/bridge/{bridge.ts,provider-tools.ts}`;
  - `packages/mcp-studio/src/server.mjs`.
- Create: `packages/core/src/bridge/import-codebase-tool.ts`
- Test:
  - `packages/core/test/{brand-codebase-source,brand-analysis-codebase,import-codebase-file}.test.ts`;
  - a fixture codebase under `packages/core/test/fixtures/brand-codebase/`: Tailwind config, `public/logo.svg`, `public/manifest.json`, `src/theme.css`, and a fake `.env` with an obviously fake value.

**Interfaces:**
```ts
// codebases.ts
export function secretReadRules(path: string): string[]; // 'Read(//<path>/**/.env*)', … one per SECRET_PATTERNS entry (also Grep/Glob forms if the CLI needs them)
// launcher.ts start({ kind: 'brand-analysis', codebases?: string[] , … }) -> addDirs = codebases; disallowedTools += readOnlyRules + secretReadRules; allowedTools += ['Read','Glob','Grep'] only when codebases.length > 0
// policy.ts: sandbox settings for brand-analysis with codebases: denyWrite += codebases; denyRead += codebase secret globs
// import-codebase-tool.ts
export async function importCodebaseFile(ctx: { projectDir: string; codebases: string[]; callsSoFar: number; library: LibraryStore }, args: { source: string; dest: string }): Promise<{ file: string } | { error: 'outside' | 'secret' | 'not-file' | 'too-big' | 'extension' | 'dest' | 'limit' | 'missing' }>;
export const CODEBASE_IMPORT_CALLS_PER_JOB = 40;
// MCP_TOOLS['brand-analysis'] adds 'import_codebase_file'
```
- **Routes:**
  - `POST …/brand/sources` accepts `{kind:'codebase', path, note?}`: validate, normalise, check overlap and existence; duplicates are refused.
  - `analyze` passes the source codebases to the run.
- **Snapshots:**
  - Take `codebaseSnapshot` of each codebase before and after the run.
  - On change: discard the proposal, emit an error event naming the folder, and append the changed files to the job log.
  - Non-git folders get the "not checkable" note.
- **Prompt:** add the spec §2.3 checklist, the secret patterns (by name, "never open"), the skip list, and `import_codebase_file` usage. Sources go into kit items as `{kind:'codebase', ref}`.
- **No sandbox:** the UI note "secret exclusion is enforced by tool rules only" is carried as a job note.
- [ ] **Step 1. Failing tests** (fake runner, no real `claude`):
  - the runner args contain `--add-dir`, the read-only rules and the secret rules, and allowed tools gain Read/Glob/Grep only with codebases;
  - sandbox settings contain denyWrite and denyRead entries;
  - every Review Focus 1 input is refused;
  - Review Focus 2: a fake runner that writes a file in the git fixture leads to a discarded proposal and an error event;
  - a good import lands in `assets/brand/` with origin `codebase`;
  - a site plus codebase analysis keeps both source kinds in the prompt.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): brand analysis from a read-only codebase, import_codebase_file`.

---

### Task 3: Web — codebase as a brand source

**Files:**
- Modify: `packages/web/src/screens/Brand.tsx`, `packages/web/src/screens/brand/BrandSide.tsx` (or the actual path), `packages/web/src/screens/brand/brandModel.ts`, `packages/web/src/api.ts`, i18n.
- Reuse: `packages/web/src/components/CodebaseList.tsx` pieces (folder picker, path input).
- Test: `packages/web/test/brand-codebase-source.test.tsx`

**Behaviour:**
- The empty brand screen gets two choices, "Da un sito" and "Da una codebase".
- "Aggiungi fonte" offers the same two.
- The codebase choice shows:
  - the desktop folder picker, or a path input;
  - project codebases as one-click suggestions;
  - a one-line note: "L'agente legge la cartella in sola lettura e non apre file segreti (.env, chiavi…)".
- Source rows show the folder name and full path.
- Kit items from a codebase show "da codebase · `<ref>`".
- Server errors (overlap, root, missing) are shown in the field.
- The no-sandbox note is shown when present.
- [ ] **Step 1. Failing tests:**
  - choose a codebase, then add the source and analyse it;
  - a suggestion click;
  - server error shown;
  - source label rendering;
  - jsdom only.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): brand from a codebase`.

---

### Task 4: Core — identity formats (vector mode, SVG check, rasterised sets, ICO)

**Files:**
- Create:
  - `packages/core/src/identity/svg-check.ts`, `packages/core/src/identity/ico.ts`;
  - `packages/core/src/identity/rasterize.ts` (Chrome, via the render harness and `BASE_FLAGS`);
  - `packages/core/src/identity/identity-set.ts`, `packages/core/src/identity/safe-zone.ts`.
- Modify:
  - `packages/core/src/render/render-jobs.ts` (identity formats produce sets);
  - `packages/core/src/creatives/creative-turns.ts` (vector-mode check, then repair turn);
  - `packages/core/src/creatives/prompt.ts` (identity section: vector mode, `small` variant, start brand or scratch, concepts);
  - `packages/core/src/creatives/export.ts`;
  - `packages/core/src/store-pack/flatten.ts` (export `flattenPng` for reuse if not already).
- Test:
  - `packages/core/test/identity-svg-check.test.ts`, `identity-ico.test.ts`;
  - `identity-set.test.ts`, `identity-safe-zone.test.ts`;
  - `identity-rasterize.chrome.test.ts`, `identity-prompt.test.ts`.

**Interfaces:**
```ts
export function checkVectorComposition(c: Composition): { ok: true; svgFile: string; small?: string } | { ok: false; reason: string };
export function checkVectorSvg(svg: string): { ok: true; warnings: string[] } | { ok: false; reasons: string[] }; // spec §4.2 rules, 512 KB
export function writeIco(pngs: Array<{ size: number; png: Buffer }>): Buffer; // ICONDIR + ICONDIRENTRY, PNG payloads
export function readIco(buf: Buffer): Array<{ width: number; height: number; png: Buffer }>; // used by tests and the set check
export async function rasterizeSvg(svgPath: string, sizes: number[], opts: { background?: string }): Promise<Map<number, Buffer>>;
export function opaqueBackground(compBackground: string | undefined, brandPrimary: string | undefined): { color: string; warning?: string };
export function safeZoneCheck(png: Buffer, size: number, kind: 'maskable' | 'adaptive'): { ok: boolean; overflowPct: number };
export async function buildIdentitySet(kind: 'logo'|'favicon'|'app-icon', input: { master: string; small?: string; outDir: string; brand?: BrandKit; name: string }): Promise<{ files: IdentityOutputFile[]; warnings: string[] }>;
```
- Writes `site.webmanifest`, `head-snippet.html`, the iOS `Contents.json` (single-size 1024 universal) and the Android `ic_launcher.xml` (adaptive icon pointing at foreground and background) from templates. Check them with tests.
- [ ] **Step 1. Failing tests:**
  - every Review Focus 3 case;
  - ICO round trip (3 entries, PNG signature, sizes);
  - Review Focus 5 opacity cases (ffprobe on the flattened files);
  - safe zone: a centred dot passes, a full-bleed square warns;
  - set file lists equal `IDENTITY_SETS`;
  - manifest `theme_color` comes from the brand primary;
  - Chrome rasterisation: the 16 px output differs between the master and a `small` variant, and 512 px is exact;
  - prompt contains the vector rules and the start mode.
- [ ] **Steps 2–4.** FAIL → implement → PASS. Run the Chrome tests through the harness, alone first.
- [ ] **Step 5. Commit:** `feat(core): identity formats — vector check, rasterised sets, ICO, opaque and safe-zone checks`.

---

### Task 5: Web — identity formats in the pickers, size grid, "Usa come logo del brand", image status pill

**Files:**
- Modify:
  - `packages/web/src/screens/NewCreative.tsx`, `packages/web/src/screens/creative/BriefEditor.tsx`;
  - `packages/web/src/screens/FormatView.tsx`, `packages/web/src/screens/RenderStatus.tsx`;
  - `packages/web/src/api.ts`, i18n;
  - `packages/core/src/server/creative-routes.ts` (route for "use as brand logo").
- Create: `packages/web/src/screens/identity/{IdentityStart.tsx,IdentitySizes.tsx}`
- Test: `packages/web/test/{identity-picker,identity-sizes,use-as-brand-logo}.test.tsx`, `packages/core/test/use-as-brand-logo.test.ts`

**Behaviour:**
- Picking any identity format shows "Partenza":
  - "Dal logo del brand" is the default when the brand has a logo;
  - "Da zero" offers name/initials, keywords, brand or free colours, and the number of concepts (1–5, default 3, logo only).
- Concepts create instances `identity-logo`, `@2`, `@3`.
- `IdentitySizes` shows every output at 1:1 and zoomed, with masks for the browser tab, iOS rounded corners and the Android circle with its safe zone, plus warnings from the set.
- The logo view shows the logo on light and on dark side by side.
- The status pill covers image formats ("Immagine pronta", "Set pronto · N file").
- The "Usa come logo del brand" action:
  - asks for confirmation;
  - `POST …/creatives/:c/versions/:n/formats/:f/use-as-brand-logo {variant: 'primary'|'icon'}`;
  - the core copies the checked SVG to `assets/brand/` and adds the logo with `source {kind:'manual', ref:'creative:<slug>/v<n>'}`.
- [ ] **Step 1. Failing tests:**
  - picker defaults with and without a brand logo;
  - concepts become instances;
  - the size grid lists the set files;
  - pill states for image formats;
  - the use-as-brand-logo route copies the file and refuses an unchecked or missing SVG;
  - the confirmation step.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): identity formats — start mode, size grid, use as brand logo, image status`.

---

### Task 6: Store pack as a formats-list entry

**Files:**
- Modify:
  - `packages/core/src/creatives/creative-turns.ts` (`updateBrief` with `storePack` set, changed or null);
  - `packages/core/src/store-pack/brief.ts` (`mergeStorePack(brief, pack | null)`);
  - `packages/web/src/screens/NewCreative.tsx` (remove the separate card; the pseudo-entry in the "Store" group);
  - `packages/web/src/screens/creative/BriefEditor.tsx`;
  - `packages/web/src/screens/new-creative/StorePackWizard.tsx` (works inside a dialog and accepts initial values);
  - `packages/web/src/screens/CreativeCanvas.tsx` (one "Pacchetto store" group, with "Esporta pacchetto" in its header; the top-bar button goes away);
  - `packages/web/src/api.ts`, i18n.
- Test: `packages/core/test/store-pack-merge.test.ts`, `packages/web/test/{store-pack-entry,store-pack-group}.test.tsx`

**Interfaces:**
```ts
export function mergeStorePack(brief: CreativeBrief, next: StorePack | null): { brief: CreativeBrief; added: string[]; removed: string[] };
// pack instance ownership: an instance belongs to the pack iff storePackFormats(prev).formats includes it; hand-picked store presets never do
```
- Creating a new creative with a pack goes through the normal create route with `storePack` in the body. `verifyScreens` runs there and in `updateBrief`.
- [ ] **Step 1. Failing tests:**
  - every Review Focus 4 case;
  - a second pack is refused;
  - the NewCreative board has no separate card and the entry opens the wizard;
  - the BriefEditor entry shows "Pacchetto store · N screenshot" with Modifica/Rimuovi;
  - the creative column groups pack instances, with export in the group header;
  - the old store-pack route still works.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat: store pack is a formats-list entry, editable in any creative`.

---

### Task 7: Live check, docs, final

**Files:** `docs/superpowers/notes/2026-10-15-phase14-live-checks.md`, `README.md` / `docs/` user docs for brand sources and identity formats, `docs/decisions-log.md`.

- [ ] **Step 1.** Record the real-folder mtimes. Create a temp workspace and copy the fixture codebase into a temp folder: Tailwind tokens, an SVG logo, `manifest.json`, and a fake `.env` whose value is a marker string.
- [ ] **Step 2.** Start the dev Electron app with `MOTION_STUDIO_USER_DATA_DIR` (verify it before acting) and the temp workspace. With the real Claude Code:
  1. run a brand analysis from the temp codebase. Check:
     - colours, font and logo come from the fixture;
     - the marker string appears nowhere (grep the project, the job log and the conversation);
     - the snapshot is unchanged;
  2. make a favicon from the brand logo;
  3. make a logo from scratch with 3 concepts;
  4. run "Usa come logo del brand" on one concept.
  - No paid providers. If the safety classifier stops a step: stop, write it down, and do not work around it.
- [ ] **Step 3.** Write the notes with the measured results and screenshots in the temp folder, not committed. Update the docs.
- [ ] **Step 4.** Run the full suite once with `MS_REQUIRE_CHROME=1` and a temp config, plus typecheck, i18n and build. Recheck the mtimes.
- [ ] **Step 5. Commit:** `docs: phase 14 live checks and user docs`.
