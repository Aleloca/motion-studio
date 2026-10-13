# Motion Studio — Phase 12: Variants — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A format can appear several times in one creative as instances (`<presetId>@<k>`), duplicated from the format view and iterated on its own.
- A creative can have extra languages. A localization is an overlay that changes only texts, voice, text scale and fallback fonts. The agent translates it through a dedicated tool, and the core generates the voices with one confirmation.
- An "App store pack" creative builds a coherent series of screenshots and a preview video for App Store and Google Play, checks the store requirements and exports a ready-to-upload folder.

**Architecture:**
- **Shared:**
  - format instance ids and helpers;
  - `brief.formatLabels`, `brief.locales`, `brief.storePack`;
  - localization overlay schema `motion-studio/localization@1` and the pure `applyLocalization`;
  - audio clip `script`;
  - `VersionEntry.localizations`;
  - export token `{locale}`;
  - batch paid approval type.
- **Core:**
  - instance ids everywhere a format id is used today;
  - duplicate route;
  - `localization/` (store, validate, carry-over, fallback fonts);
  - `localize` turn kind with the MCP tool `submit_localization`;
  - batch voice generation;
  - render and export per locale;
  - `store-pack/` (brief builder, requirement checks, flattening, pack export).
- **Web:**
  - duplicate, label, reorder and remove instances;
  - Languages panel with the review table and the preview locale switcher;
  - batch confirmation card;
  - App store pack wizard and pack export.

**Tech Stack:** TypeScript, zod, Fastify, React 19, existing composition runtime (`setComposition`), render jobs, ffmpeg via `ffmpeg-exec` and typed filter builders, Google Fonts flow from phase 11. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-13-motion-studio-phase12-variants-design.md`.

## Global Constraints

**Compatibility.**
- All schema changes are additive and optional. Old creatives, briefs, versions and manifests load unchanged; tests use fixtures from before this phase.
- A bare preset id is the first instance. Folder names, export names and picks for creatives without instances stay byte-identical to today.

**Instance ids.**
- Regex `^[a-z0-9][a-z0-9-]*(@([2-9]|1[0-9]|20))?$`.
- The helpers `presetOf(instanceId)` and `instanceIndex(instanceId)` are the only way to split an id. No ad-hoc `split('@')` elsewhere.

**Localization overlays.**
- Only `texts`, `params`, `voices`, `fit` and `fonts`, as the spec defines them.
- Validation rejects unknown keys (`.strict()`), unknown clip ids, `fit` outside 0.7–1.0, voice `src` outside `assets/` or not a file of the version or staging, and texts over the composition schema limits.
- `applyLocalization` is pure and never touches any other field. There is a test that deep-compares everything else.

**Paid actions.**
- Voice generation for localizations is run by the core with one batch confirmation per `localize` turn. A per-project "Always" rule for `tts` covers it.
- `brief.services.voice` is enforced as in phase 11.
- Tests use `MemoryVault` and fake `fetch`. The test network guard from phase 11 stays on.

**Agent.**
- Prompts stay English.
- In a `localize` turn the agent has no file-writing tools for compositions and can only call `submit_localization` (plus read-only tools).
- The agent never edits the brief.

**Store pack.**
- No Apple or Google device artwork or logos in generated frames.
- Store limits are re-checked at the start of Task 6 from the public Apple and Google documentation only (read the pages, no API calls), with the date written in the presets comment.

**Real folders.** Same rules as phases 10a–11:
- mtimes of the three real folders checked before and after every live check;
- isolation guard on;
- every Electron launch uses `MOTION_STUDIO_USER_DATA_DIR`, verified before acting;
- no packaged app launches.

**Process.**
- No push, PR, release or publish. Never kill processes by pattern.
- Commit trailers exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01KxKL6zuy8dbnJieqN1eCNg`
- `pnpm test`, `pnpm typecheck` and `pnpm check:i18n` stay green. Per-file timeouts only.
- Decisions-log entries from 430 on (420–429 are the orchestrator's for this phase).
- On a safety-classifier stop: stop, report, never rephrase around it.

## Review Focus

1. **A translation longer than its box** (German, Finnish: often 30–40% longer).
   - Expected: `fit` scales the text down to 0.7 at most. If it still overflows, it is reported as a problem and the repair attempt asks for a shorter text with the user's request attached.
   - The layout, timing and other clips never change, and an overflowing text is never exported silently.
   - Tests in Task 4 (repair) and Task 3 (`fit` bounds, overflow check on the localized composition).
2. **A new agent iteration after translations exist.**
   - Expected: the clips whose source text changed are marked `stale` in the carried overlays, and preview and export show the source text for them with a visible "outdated" flag, never the old translation.
   - "Translate" redoes only missing or stale entries.
   - A clip deleted in the new version drops its entry.
   - Tests in Task 3.
3. **Two instances of the same preset across the whole pipeline.**
   - Expected: duplicating, iterating only `@2`, following a primary, rendering, picking, exporting with the default pattern and with a custom pattern without `{format}`: file names never collide (index or numeric suffix), and the other instance is carried over byte-identical.
   - Removing an instance from the brief never deletes saved versions.
   - Tests in Task 1.
4. **A translated voice longer than its clip, or a voice clip without a known script.**
   - Expected: a long voice is a reported problem with the measured durations, never cut.
   - A clip without `script` and without an asset description is listed as "can't translate" in the UI and keeps the original voice.
   - With voice `none`, there is no paid call and no confirmation; the per-language choice "Keep original" or "Mute" applies.
   - Tests in Task 4.
5. **Store requirements at export.**
   - Expected: an App Store screenshot PNG with an alpha channel is flattened (verified by reading the PNG IHDR colour type), a wrong size is refused, a preview of 12 s or 35 s is refused with the limits named, and a preview with no audio gets a silent track.
   - A failure on one file exports the rest and lists the failure.
   - Tests in Task 6.

---

### Task 0: Shared schema

**Files:**
- Modify: `packages/shared/src/{creative.ts,formats.ts,export-name.ts,permissions.ts}`, `packages/shared/src/composition/schema.ts`, `packages/shared/src/i18n/{en,it}.ts`
- Create: `packages/shared/src/format-instance.ts`, `packages/shared/src/localization/{schema.ts,apply.ts,locales.ts}`, `packages/shared/src/store-pack.ts`
- Test: `packages/shared/test/{format-instance,localization-apply,localization-schema,store-pack,export-name-locale}.test.ts`

**Interfaces (Produces):**
```ts
// format-instance.ts
export const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]*(@([2-9]|1[0-9]|20))?$/;
export function presetOf(instanceId: string): string;            // 'appstore-iphone-69@3' -> 'appstore-iphone-69'
export function instanceIndex(instanceId: string): number;       // bare -> 1, '@3' -> 3
export function nextInstanceId(presetId: string, taken: readonly string[]): string | null; // null when 20 are taken
export function instanceLabel(instanceId: string, presetName: string, labels?: Record<string, string>): string; // label, else "Name #k" (k>1), else "Name"

// creative.ts (briefSchema additions, all optional)
formats: string[]                       // now instance ids (INSTANCE_ID_RE), unique (refine)
formatLabels?: Record<string, string>   // keys must be in formats, values 1..60 chars
locales?: { primary: LocaleTag; extra: LocaleTag[] }  // extra max 10, no duplicates, primary not in extra
storePack?: StorePack
// VersionEntry addition
localizations?: { locale: LocaleTag; instanceId: string; hash: string; origin: 'agent' | 'editor'; stale: string[]; voice: 'translated' | 'original' | 'muted'; problems?: string[] }[]
// origin stays 'agent' | 'editor'

// localization/locales.ts
export const SUPPORTED_LOCALES: readonly { tag: LocaleTag; name: string; script: 'latin'|'cyrillic'|'greek'|'han-sc'|'han-tc'|'jp'|'kr'|'devanagari'|'thai'; rtl: false }[];
export const RTL_LOCALES = ['ar', 'he', 'fa', 'ur'] as const;   // listed for the UI as disabled
export const FALLBACK_FONT_BY_SCRIPT: Record<string, string>;  // 'jp' -> 'Noto Sans JP', 'han-sc' -> 'Noto Sans SC', ...

// localization/schema.ts
export const localizationSchema = z.object({
  $schema: z.literal('motion-studio/localization@1'),
  locale: localeTag, instanceId: z.string().regex(INSTANCE_ID_RE),
  texts: z.record(clipId, z.object({ source: z.string().max(2000), text: z.string().max(2000) }).strict()),
  params: z.record(z.string().regex(/^[a-z0-9-]+\.[A-Za-z0-9_-]+$/), z.object({ source: z.string().max(2000), text: z.string().max(2000) }).strict()),
  voices: z.record(clipId, z.object({ src: assetPath, sourceScript: z.string().max(5000), script: z.string().max(5000) }).strict()),
  fit: z.record(clipId, z.number().min(0.7).max(1)),
  fonts: z.array(z.object({ family: z.string(), files: z.array(assetPath) }).strict()).max(3),
}).strict();
export type Localization = z.infer<typeof localizationSchema>;

// localization/apply.ts
export function applyLocalization(c: Composition, l: Localization, opts?: { stale?: readonly string[]; voiceMode?: 'translated'|'original'|'muted' }): Composition;
// texts -> props.text of that text clip; params -> params[key].value (type 'text' only); voices -> audio clip src (role 'voice' only);
// fit -> props.size * fit; fonts -> appended to composition.fonts and to each text clip's family fallback chain;
// stale ids keep the source text; voiceMode 'muted' sets volume 0 on voice clips, 'original' ignores voices.
// Throws LocalizationMismatch when an id is unknown or of the wrong kind.
export function localizableEntries(c: Composition): { texts: {clipId, name?, scene?, text, box: {w,h}, size}[]; params: {key, label?, text}[]; voices: {clipId, script: string | null, duration}[] };

// composition/schema.ts: audio clip gains script?: string (max 5000), allowed only with role 'voice'

// store-pack.ts
export type StoreId = 'appstore' | 'playstore';
export const storePackSchema: z.ZodType<{ app: { name: string; tagline: string }; stores: StoreId[]; devices: { appstore?: ('iphone-69'|'ipad-13')[]; playstore?: ('phone'|'tablet'|'feature')[] }; screenshots: { caption: string; screen: string | null }[]; preview: boolean }>;
// screenshots: appstore 1..10, playstore 2..8 (refine by stores); iphone-69 required when appstore; phone required when playstore
export function storePackFormats(p: StorePack): { formats: string[]; formatLabels: Record<string, string>; links: Record<string, string> };

// export-name.ts: token 'locale' added; defaultPattern(hasLocales) -> '{title}-{format}-v{v}' or '{title}-{format}-{locale}-v{v}'
// permissions.ts: approval kind 'paid-batch' { provider, calls: { label, chars }[], estimate?: string }
```
- [ ] **Step 1. Failing tests:**
  - instance helpers: bare, `@2`, `@20`, `@21` refused, `@1` refused, `nextInstanceId` gaps;
  - duplicates in `formats` refused;
  - `formatLabels` keys outside `formats` refused;
  - old briefs, versions and compositions parse;
  - `applyLocalization`: every field it is not allowed to touch deep-equals the input (Review Focus 1, 2), stale ids keep the source text, voice modes, fit multiply, unknown id throws, wrong-kind id throws;
  - overlay `.strict()` refuses extra keys;
  - `storePackFormats` builds ids, labels and links;
  - `{locale}` token.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(shared): format instances, localization overlays, store pack schema`.

---

### Task 1: Core — format instances everywhere, duplicate route

**Files:**
- Modify: `packages/core/src/creatives/{creative-turns.ts,prompt.ts,carry-over.ts,direct-edit.ts,render-jobs.ts,creative-store.ts}`, `packages/core/src/server/creative-routes.ts`, export code (`export/` or the export handlers in `creative-routes.ts`), composition checks and follower logic.
- Test: `packages/core/test/format-instances.test.ts`, `packages/core/test/duplicate-format.test.ts`, extend export-name and render tests.

**Interfaces:**
```ts
// POST /api/projects/:slug/creatives/:c/versions/:n/duplicate-format  { instanceId: string, label?: string }
//   -> { version: VersionEntry; instanceId: string }   409 when 20 instances exist or the source is not in version n
```
- Every lookup of a preset (`FormatPreset` by id) goes through `presetOf(instanceId)`. Composition folders, carry-over, follower checks (`links` keys and values are instance ids), `planTurn` targets, render outputs `outputs/vN/<instanceId>.<ext>`, `exportPicks` and export names all use instance ids.
- The prompt's "Required formats" lists each instance with its label, preset size and folder. For instances of the same preset it adds "These are separate designs of the same size; keep each one distinct unless the request says otherwise".
- Duplicate: under the creative lock, copy `compositions/<src>` of version n to a new version as `compositions/<new>`, append `<new>` to `brief.formats` right after the source, set the label, origin `editor`, request "Duplicated <label>". Other instances are carried over as in a direct edit.
- Export names: when two picked files would get the same name, append `-<index>` using `instanceIndex`. With a custom pattern lacking `{format}`, append `-<instanceId>`. Tested with the default and custom patterns (Review Focus 3).

- [ ] **Step 1. Failing tests:**
  - turn targeting only `@2` carries the bare instance byte-identical;
  - follower `@2` of primary `instagram-story`;
  - render file names;
  - export name collision cases;
  - duplicate route (lock, label, position, 409 cases, version origin);
  - removing an instance from the brief keeps saved versions;
  - creatives without instances produce byte-identical paths and names to before (snapshot from the current main).
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): format instances and duplicate format`.

---

### Task 2: Web — instances in the creative UI

**Files:**
- Modify: format view, format tabs and list, brief editor (formats picker), export dialog, `packages/web/src/api/*` types.
- Test: `packages/web/test/{format-instances,duplicate-format}.test.tsx`

- Format tabs and cards show `instanceLabel`.
- A "Duplicate format" action in the format view menu calls the route and opens the new instance.
- Labels can be edited inline: they save `formatLabels` only, merged under the lock like the phase 11 services chip.
- Drag to reorder in the brief editor; removing an instance asks for confirmation and says saved versions are kept.
- The brief formats picker allows adding the same preset again ("Add another").
- Export dialog rows show labels.

- [ ] **Step 1. Failing tests:** duplicate flow, label edit saves only `formatLabels`, reorder, remove confirmation, add another, export rows.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): duplicate, label and reorder format instances`.

---

### Task 3: Core — localization store, carry-over, fallback fonts, render and export per locale

**Files:**
- Create: `packages/core/src/localization/{store.ts,validate.ts,carry.ts,fallback-fonts.ts}`, `packages/core/src/server/localization-routes.ts`
- Modify: `render-jobs.ts` (locales), export handlers (locales, `{locale}`), turn finishing (carry-over on new versions), composition checks entry point (accepts a composition object).
- Test: `packages/core/test/{localization-store,localization-carry,localization-routes,render-locale,fallback-fonts}.test.ts`

**Interfaces:**
```ts
// GET  /api/projects/:slug/creatives/:c/versions/:n/localizations                 -> { entries: VersionEntry['localizations']; available: LocaleTag[] }
// GET  .../versions/:n/localizations/:locale/:instanceId                          -> { overlay: Localization; problems: string[]; stale: string[] }
// PUT  .../versions/:n/localizations/:locale/:instanceId   { texts?, params?, fit?, voice? ('original'|'muted') }  -> same as GET (origin 'editor')
// GET  .../versions/:n/compositions/:instanceId?locale=xx  -> localized composition for preview (applyLocalization)
// POST .../versions/:n/render   { formats?, locales? }     -> files outputs/vN/<instanceId>.<locale>.<ext>; no locale = today's file
// export bodies gain locales?: LocaleTag[]
export async function carryLocalizations(prev: VersionDir, next: VersionDir, nextCompositions: Map<string, Composition>): Promise<VersionEntry['localizations']>;
export async function ensureFallbackFont(project: ProjectRef, locale: LocaleTag, signal: AbortSignal): Promise<{ family: string; files: string[] } | null>;
```
- Store: overlays at `outputs/vN/locales/<locale>/<instanceId>.json`, written atomically under the creative lock. The `VersionEntry.localizations` row is updated in the same lock. `hash` is the hash of the overlay file.
- PUT (manual edit): validate against the version's composition, apply, run the composition checks on the localized composition, and store the problems. Only the fields the spec allows are accepted. A text whose box overflows even at `fit` 0.7 is stored with the problem, not refused: the user may want to fix it later.
- Carry-over when a turn or direct edit creates version N+1:
  - entries whose clip still exists with the same source text are kept;
  - entries whose source changed go into `stale`;
  - entries whose clip is gone are dropped;
  - voices whose source script changed go into `stale`.
- Preview and render use `applyLocalization` with `stale`, so a stale clip shows the source text and the UI flags it (Review Focus 2).
- Fallback fonts: for locales whose script is not latin, cyrillic or greek, download the Noto family once per project with the phase 11 Google Fonts add path, register it in the library with origin `google-fonts`, and add it to the overlay's `fonts`. When offline, record a problem "fallback font unavailable" and continue.
- Render with locale: the render job builds the localized composition and renders it with the existing pipeline. With open problems or stale entries, the body needs `force: true`; without it the core answers 409 with the list. The manifest records `locale`, `forced` and `stale`.

- [ ] **Step 1. Failing tests:**
  - overlay validation (each forbidden field, voice src outside `assets/`, symlink, `..`);
  - PUT under lock;
  - carry-over cases (kept, stale, dropped, voice stale);
  - preview endpoint;
  - render file names and 409 without force;
  - manifest fields;
  - export with `{locale}`;
  - fallback font once per project, offline problem;
  - locales outside the curated list and RTL tags refused with a translated reason.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): localization overlays, carry-over, render and export per locale`.

---

### Task 4: Core — `localize` turn, `submit_localization`, batch voice generation

**Files:**
- Modify: `packages/core/src/creatives/{creative-turns.ts,prompt.ts}`, `packages/core/src/bridge/provider-tools.ts` (batch tts helper reusing the phase 11 tts path), approvals service (`paid-batch`), `packages/mcp-studio/src/server.mjs` (new tool)
- Create: `packages/core/src/localization/localize-turn.ts`
- Test: `packages/core/test/{localize-turn,localize-voice-batch,submit-localization}.test.ts`

**Interfaces:**
```ts
// POST /api/projects/:slug/creatives/:c/versions/:n/localize  { locales: LocaleTag[]; formats?: string[]; voice?: Record<LocaleTag, 'translate'|'original'|'muted'>; text?: string }
//   -> { jobId }   (job kind 'localize', lane 'agent')
// MCP tool (only in localize turns):
// submit_localization({ locale, instanceId, texts: Record<clipId,string>, params: Record<key,string>, voiceScripts: Record<clipId,string>, fit: Record<clipId,number> })
//   -> { ok: true, problems: string[] } | { ok: false, errors: string[] }
```
- The turn prompt (kind `localize`, English) contains:
  - per instance, `localizableEntries` with box size, font size, scene and clip name;
  - brand tone and writing style, brief message and notes;
  - target locales;
  - the user's optional text, delimited as the user's words;
  - the rule "only call submit_localization; do not edit files";
  - entries that are missing or stale (only those are requested).
- Tools allowed in this turn: `submit_localization`, `preview_frames` (on the localized composition) and the read-only tools. The composition-writing tools and the paid provider tools are not available.
- `submit_localization` validates and merges into the overlay under the lock, runs the checks on the localized composition and returns the problems so the agent can shorten within the same attempt.
- At turn end, the open problems trigger the existing repair loop (3 attempts total). The repair prompt lists the problems per locale and instance, and carries the user's text (phase 11 F4).
- Voices, after the texts are final:
  - for each locale with voice `translate`, collect the voice clips whose script changed;
  - resolve the provider with the phase 11 `resolveService` (`brief.services.voice`, F5);
  - ask one `paid-batch` approval listing calls and characters, with "Always" honoured;
  - generate sequentially with the brand voice into `assets/audio/` (description = translated script);
  - write the `voices` entries;
  - measure durations with the probe: a voice longer than its clip is a problem with both durations (Review Focus 4), and the repair asks for a shorter script, then regenerates only that voice in a new batch approval.
- Voice `none`, no key, or a declined batch: the locale falls back to the per-locale choice (`original` default), and the UI shows why.
- Clips with no known script are listed in the turn result as "can't translate voice".

- [ ] **Step 1. Failing tests:**
  - prompt content (stale only, user text delimited, rules);
  - tool availability in the localize turn;
  - `submit_localization` validation and merge;
  - repair carries the user text;
  - one batch approval for N locales × M clips;
  - "Always" honoured;
  - declined batch keeps the original voice;
  - voice `none` gives no approval and no fetch;
  - long voice becomes a problem, then a regeneration batch;
  - a clip with no script is reported;
  - fake fetch only.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): localize turns with submit_localization and batch voice generation`.

---

### Task 5: Web — Languages panel, review table, preview switcher

**Files:**
- Create: `packages/web/src/screens/creative/LanguagesPanel.tsx`, `LocalizationTable.tsx`, `PaidBatchCard.tsx`
- Modify: brief editor (languages), format view and editor (locale switcher), render and export dialogs (locales), approvals center (batch card).
- Test: `packages/web/test/{LanguagesPanel,LocalizationTable,PaidBatchCard,locale-preview}.test.tsx`

- Brief: primary language plus extra languages, from the curated list; the RTL languages are shown disabled with the reason.
- Languages panel, per language:
  - status (not translated, translated, n stale, n problems);
  - voice choice (Translate, Keep original, Mute) with the reason when Translate is unavailable;
  - "Translate" (all or selected languages and formats).
- Review table: source, translation (editable), status, `fit` slider (70–100%). Saving calls PUT; an overflow is shown inline.
- Locale switcher in the player and the editor preview, loading the localized composition. Stale clips are outlined with the "outdated" label.
- Render and export dialogs: a languages multiselect; on a 409 the dialog shows the list and a "Render anyway" button.
- Batch card: provider, calls with characters, estimate, Approve, Always and Decline.

- [ ] **Step 1. Failing tests:** each control above, RTL disabled, 409 flow, batch card actions, stale outline.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): languages panel, translation review and locale preview`.

---

### Task 6: Core — store pack (brief, series prompt, requirements, pack export)

**Files:**
- Create: `packages/core/src/store-pack/{brief.ts,requirements.ts,flatten.ts,pack-export.ts}`, `packages/core/src/server/store-pack-routes.ts`
- Modify: `packages/shared/src/formats.ts` (re-checked limits with a dated comment), `prompt.ts` (series section when `brief.storePack`), render jobs (flatten for App Store screenshots; preview audio track).
- Test: `packages/core/test/{store-pack-brief,store-requirements,store-flatten,store-pack-export}.test.ts`

**Interfaces:**
```ts
// POST /api/projects/:slug/creatives/store-pack   { title, storePack: StorePack }  -> { creative }   (brief from storePackFormats)
// POST .../versions/:n/store-pack/export          { locales?: LocaleTag[]; destination }  -> { written: string[]; failed: { file: string; reason: string }[] }
export function checkStoreFile(kind: 'screenshot'|'preview'|'feature', store: StoreId, file: string): Promise<{ ok: true } | { ok: false; reason: string }>;
```
- Step 0 (before code): re-read the public Apple pages (screenshot specifications, app preview specifications) and Google Play pages (preview assets) with WebFetch. Update `formats.ts` if a size or limit changed, and write the date and URLs in the comment. Make no API calls.
- Brief builder: from `StorePack`, build the instances, labels and links (iPad and Play instances follow the iPhone screenshot of the same index). `brief.assets` gets the app screens. The message is built from app name, tagline and captions.
- Series prompt section:
  - same grid and style across the series;
  - caption at the top;
  - the app screen inside a generic device frame drawn with HTML/CSS (rounded rectangle, no notch logos, no brand marks);
  - the story progresses from screenshot 1 to N;
  - never use Apple or Google logos or device artwork.
- Requirements, checked on the rendered files:
  - exact size: PNG IHDR parse, or JPEG SOF parse with a bounded reader;
  - App Store PNG colour type without alpha: flatten through ffmpeg onto the composition background (`format=rgb24`) using the typed filter builders;
  - preview: duration 15–30 s, 30 fps, H.264 and an audio track, all checked by probe; when there is no audio, add a silent AAC track during the render;
  - Play feature graphic: no alpha.
- Pack export: layout as in the spec, file names `NN-<slugified caption>`, a README with limits, date checked, upload order and the Play video note. Failed files are listed and the rest is exported. It uses the existing export destination handling.

- [ ] **Step 1. Failing tests:**
  - brief builder;
  - series prompt section;
  - flatten (PNG with alpha → colour type 2, checked by IHDR);
  - wrong size refused;
  - preview of 12 s and 35 s refused with limits;
  - silent track added;
  - pack layout with and without locales;
  - partial failure;
  - README content.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): app store pack with store requirement checks and pack export`.

---

### Task 7: Web — store pack wizard and pack export

**Files:**
- Create: `packages/web/src/screens/new-creative/StorePackWizard.tsx`, `packages/web/src/screens/creative/StorePackExport.tsx`
- Modify: New creative screen (new card "App store pack"), creative header (pack export action when `brief.storePack`).
- Test: `packages/web/test/{StorePackWizard,StorePackExport}.test.tsx`

- Wizard steps:
  1. App (name, tagline).
  2. Stores and devices (required devices locked on).
  3. Screenshots: count stepper within the store bounds; caption and app screen per row, picked from the library with an inline upload.
  4. Preview yes/no.
  5. Review.
- Channel marks from the existing `ChannelMark` component.
- Pack export dialog: languages, destination, result list with failures and their reasons.

- [ ] **Step 1. Failing tests:** bounds per store, required devices, captions required, review payload, export results with failures.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(web): app store pack wizard and pack export`.

---

### Task 8: Live verification and docs

**Files:**
- Create: `docs/live-check-phase12.md`
- Modify: `README.md` (variants, languages, store pack), `docs/decisions-log.md`

- Throwaway core in the scratchpad: `MOTION_STUDIO_CONFIG_DIR` temp, `MemoryVault` without keys, haiku, headless Chrome via CDP for the UI. Check the mtimes of the three real folders before and after.
- Checks:
  1. Duplicate a format and iterate only the instance, with a real haiku turn; the other instance must be byte-identical.
  2. Translate two formats into German and Japanese, with voice "Keep original" (no key): overlays exist, the Noto Sans JP fallback is added, and the localized preview and render are correct.
  3. Edit a translation by hand: the overflow is shown, then fixed with `fit`.
  4. A new iteration changes one title: stale marking in the UI and the render.
  5. App Store pack with 3 screenshots and a preview: render, export, then check with ffprobe (duration, fps, audio track) and the PNG IHDR (no alpha, exact size).
  6. Batch voice approval with a fake `fetch`, injected into the throwaway core, never a real provider.
- [ ] **Step 1.** Run the checks and record results, costs and mtimes in `docs/live-check-phase12.md`.
- [ ] **Step 2.** Docs. Commit: `docs: phase 12 live check and docs`.
