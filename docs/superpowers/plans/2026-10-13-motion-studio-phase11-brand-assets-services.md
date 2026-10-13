# Motion Studio — Phase 11: Brand, assets and external services — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Fonts come from the site's CSS and from a Google Fonts search in the UI.
- Brand analysis shows real phases.
- The asset library plays, measures, renames, sorts and generates.
- The agent gains ElevenLabs sound effects and music with a brand sound style.
- The brief chooses which external services a creative may use (changeable from the chat), and the core enforces it.
- Saved keys are tested per capability.

**Architecture:**
- **Shared:**
  - schema additions: `brief.services`, brand kit `sound`, asset `origin: 'google-fonts'` and `provider`/`model`/`durationSec`/`bytes`, `report_progress.phase`, new provider rules;
  - key-check result types.
- **Core:**
  - `providers/google-fonts-catalog.ts` (catalog cache, search, preview subsets);
  - `brand/site-fonts.ts` (`inspect_site_fonts`);
  - `providers/elevenlabs-audio.ts` (sound generation, music, voices);
  - `providers/key-check.ts`;
  - `services/service-policy.ts` (brief services → allowed providers per job);
  - library rename, probe metadata and waveform;
  - core-run generation routes for the Assets "Generate" dialog.
- **MCP:** `inspect_site_fonts`, `sound_effect`, `music`, `list_voices`.
- **Web:**
  - Google Fonts picker in Brand → Fonts;
  - analysis phases stepper;
  - Assets playback, metadata, rename, sort and Generate dialog;
  - brand Sound section;
  - brief Services selector and the composer "Services" chip;
  - key Test results in App Settings.

**Tech Stack:** TypeScript, zod, Fastify, React 19, existing `safeFetch`/`http.ts`, ffmpeg via the `ffmpeg-exec` helper and typed filter builders (waveform). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-13-motion-studio-phase11-brand-assets-services-design.md`. Read `docs/providers.md` (adding a provider checklist) before Tasks 4–6.

## Global Constraints

**Network.**
- Every core request to the open web (Google Fonts catalog and css2, site pages and stylesheets) goes through `safeFetch` / `safeDownload`, with byte caps and the job's abort signal.
- Provider API calls use `http.ts` (`requestJson`/`requestBytes`, `redirect: 'error'`, 120 s timeout).
- The web UI never loads third-party resources: font previews are served by the core.

**Keys.**
- Keys stay in the vault. They never appear in logs, events, responses, test snapshots or the decisions log.
- Key checks are read-only, free endpoints. Results live in core memory only.
- Tests use `MemoryVault` and fake `fetch`. No real provider call in tests.

**Paid actions.**
- Every new paid tool and every Generate in the Assets dialog asks for confirmation with the existing `confirmPaid` / approvals flow and per-project "Always" rules.
- The new rules `provider:sfx-elevenlabs` and `provider:music-elevenlabs` go into `PROVIDER_RULES`.

**Services policy.**
- `brief.services` is enforced in the core (provider tool handlers and the Generate routes are not affected: Generate is a direct user action).
- The agent never edits the brief.

**Agent prompts** stay English and are not localized; UI text comes from the `en`/`it` catalogs.

**Data.** All schema changes are additive and optional. Old projects and briefs load unchanged (tests with fixtures from before this phase).

**Real folders.** Same rules as phases 10a/10b:
- the three real folders' mtimes are checked before and after every live check;
- the isolation guard stays on;
- every Electron launch uses `MOTION_STUDIO_USER_DATA_DIR`, verified before acting;
- no packaged app launches.

**Process.**
- No push, PR, release or publish. Never kill processes by pattern.
- Commit trailers exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01KxKL6zuy8dbnJieqN1eCNg`
- `pnpm test`, `pnpm typecheck` and `pnpm check:i18n` stay green. Per-file timeouts only.
- Decisions-log entries from 300 on (290–297 are the orchestrator's for this phase).
- On a safety-classifier stop: stop, report, never rephrase around it.

## Review Focus

1. **Hostile websites in `inspect_site_fonts`.** The pages and stylesheets must not make the core read private addresses or loop forever, and must not exhaust memory. Cases:
   - redirects to 127.0.0.1 or 169.254.169.254;
   - `@import` cycles;
   - 50 MB stylesheets;
   - thousands of `@font-face` rules;
   - `url()` with `data:`, `file:` or `javascript:`;
   - a stylesheet on another domain that is not a known font CDN.

   Each case is refused or bounded, with a partial result and a translated warning in the proposal. Tests in Task 2.
2. **A brief that forbids a service.** Voice `none`, then the agent calls `tts`. The core must refuse with the translated reason, without starting the confirmation dialog or spending money. Choosing `openai` for voice must make a `tts` call with `provider: 'elevenlabs'` use OpenAI (or refuse when OpenAI has no key, never silently switch). Changing the services from the chat chip mid-conversation applies to the next turn. Tests in Task 7.
3. **Keys with partial permissions.** An ElevenLabs key with only `text_to_speech` (no `user_read`, no `voices_read`) must not show as "invalid". It shows the missing read permissions and "unverified" for the generation capabilities. A first real `music` call answering 403 marks music `missing` with the permission name. A network error is `error`, never `missing`. Tests in Task 8.
4. **Renaming an asset that is in use.** A file referenced by the brand (logo, font), by a brief (`assets`), and by an open editor draft's staging: rename updates brand and briefs atomically under their locks. Saved versions keep their own copies. A rename onto an existing name, into another folder or through a symlink is refused. Tests in Task 3.
5. **Google Fonts unavailable or changed.** The catalog endpoint answers 500, HTML, a changed JSON shape or 20 MB. Search falls back to "exact name" with a clear message. Any cached catalog older than 7 days is still used, marked stale. Adding a font never writes a partial set of files. Tests in Task 1.

---

### Task 0: Housekeeping and shared schema

**Files:**
- Modify: `packages/shared/src/{creative.ts,brand.ts,library.ts,permissions.ts}`, `packages/shared/src/i18n/{en,it}.ts`
- Create: `packages/shared/src/services.ts`
- Test: `packages/shared/test/{services,brand-sound,library-meta}.test.ts`

**Interfaces (Produces):**
```ts
export const SERVICE_KINDS = ['images', 'voice', 'music', 'sfx'] as const;
export const SERVICE_CHOICES = { images: ['auto', 'openai', 'stock', 'none'], voice: ['auto', 'openai', 'elevenlabs', 'none'], music: ['auto', 'elevenlabs', 'none'], sfx: ['auto', 'elevenlabs', 'none'] } as const;
export type BriefServices = { images?: 'auto'|'openai'|'stock'|'none'; voice?: 'auto'|'openai'|'elevenlabs'|'none'; music?: 'auto'|'elevenlabs'|'none'; sfx?: 'auto'|'elevenlabs'|'none' };
// briefSchema gains services?: BriefServices (absent = all 'auto')
export const brandSoundSchema: z.ZodType<{ genre: string; energy: 'low'|'medium'|'high'|null; instruments: string[]; avoid: string[]; voice: { provider: 'openai'|'elevenlabs'; id: string; name?: string } | null }>;
// brandKitSchema gains sound?: BrandSound (absent = empty)
// assetEntrySchema: origin adds 'google-fonts'; gains provider?: string; model?: string; durationSec?: number|null; bytes?: number; loop?: boolean
export type KeyCapability = 'key' | 'images' | 'tts' | 'voices' | 'account' | 'sfx' | 'music' | 'search';
export type KeyCheckStatus = 'ok' | 'missing' | 'unverified' | 'error';
export type KeyCheckResult = { provider: ProviderId; checkedAt: string; capabilities: { capability: KeyCapability; status: KeyCheckStatus; permission?: string; detail?: string }[] };
export const BRAND_PHASES = ['queued', 'reading', 'fonts', 'colors', 'logos', 'tone', 'writing', 'done'] as const;
```
- [ ] **Step 1. Failing tests:** old briefs, brand kits and asset entries parse; new fields round-trip; enum refusals; `services` absent means `auto` (helper `effectiveServices(brief)`).
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(shared): services in the brief, brand sound style, asset metadata and key check types`.

---

### Task 1: Core + web — Google Fonts catalog, search, preview and add

**Files:**
- Create: `packages/core/src/providers/google-fonts-catalog.ts`, `packages/core/src/server/fonts-routes.ts`
- Modify: `packages/core/src/providers/google-fonts.ts` (shared download path, origin `google-fonts`), `packages/core/src/bridge/provider-tools.ts` (`fonts_fetch` uses the same path)
- Create: `packages/web/src/screens/brand/GoogleFontPicker.tsx`; modify `BrandKitSections.tsx`
- Test: `packages/core/test/google-fonts-catalog.test.ts`, `packages/core/test/fonts-routes.test.ts`, `packages/web/test/GoogleFontPicker.test.tsx`

**Interfaces:**
```ts
// GET  /api/fonts/google?q=&category=&limit=50   -> { stale: boolean; fallback: boolean; families: { family: string; category: string; weights: number[]; italic: boolean; variable: boolean }[] }
// GET  /api/fonts/google/preview?family=&weight=  -> font bytes (woff2), Cache-Control private, from the core's cache
// POST /api/projects/:slug/brand/fonts/google     { family, weights: number[], italic: boolean, role } -> { font: BrandFont; files: string[] }
```
- Catalog fetch: `https://fonts.google.com/metadata/fonts` via `safeFetch`, cap 8 MB.
  - Strip the anti-JSON prefix `)]}'` if present.
  - Validate with zod, keep only the needed fields, cache at `<configDir>/cache/google-fonts-catalog.json` with fetchedAt. Refresh after 7 days; on failure use the stale cache; with no cache answer `fallback: true` and search by exact name through `css2`.
- Preview: `css2?family=<f>:wght@<w>&text=<sample>` (sample = "AaBbGg 0123" plus the family name). Download the single woff2 (cap 200 KB) and cache by family+weight under `<configDir>/cache/font-previews/`. LRU of 300 files.
- Add: reuse `fetchGoogleFont`; download into a temp folder, then move all files at once (no partial set). Register with origin `google-fonts`, attribution "Google Fonts · <license>", and append the brand font under the brand lock.
- UI: search field with debounce, category filter, results rendered with the core-served preview through `FontFace` under a private family (like `brandFonts.ts`), weights checkboxes from the catalog, italic toggle, role select, Add. The manual "family name + file from Assets" path stays as "Add manually".

- [ ] **Step 1. Failing tests:**
  - catalog parse with prefix and without;
  - 500, HTML, changed shape and oversize all lead to the fallback;
  - stale cache used and marked;
  - search ranking (prefix before substring, then popularity if present);
  - preview cache and LRU;
  - add writes all files or none (inject a failure on the second file);
  - brand updated under lock;
  - origin `google-fonts`;
  - web picker: search, preview loaded from the core URL only, add flow, fallback message.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat: Google Fonts search, preview and add from the brand`.

---

### Task 2: Core — `inspect_site_fonts` and analysis phases

**Files:**
- Create: `packages/core/src/brand/site-fonts.ts`, `packages/core/src/brand/css-scan.ts`
- Modify: `packages/core/src/bridge/{bridge-routes.ts,provider-tools.ts}` (tool + `report_progress.phase`), `packages/core/src/agent/launcher.ts` (`MCP_TOOLS` brand-analysis), `packages/mcp-studio/src/server.mjs`, `packages/core/src/brand/{brand-prompt.ts,brand-analysis.ts}` (core emits `queued`/`done`)
- Modify web: `packages/web/src/screens/{brandModel.ts,BrandSide.tsx}` (phases stepper)
- Test: `packages/core/test/{site-fonts,css-scan}.test.ts`, `packages/web/test/brand-analysis-phases.test.tsx`

**Interfaces:**
```ts
export type SiteFont = { family: string; roles: ('heading'|'body'|'button'|'other')[]; weights: number[]; italic: boolean; source: 'google'|'self-hosted'|'adobe'|'system'; files: { url: string; format: string | null; weight: number | null }[] };
export function scanCss(css: string, baseUrl: URL, budget: ScanBudget): { families: Map<string, Usage>; faces: FontFace[]; imports: URL[]; googleLinks: URL[] }; // linear, bounded
export function inspectSiteFonts(deps: { fetch: SafeFetchDeps; signal: AbortSignal }, url: string): Promise<{ fonts: SiteFont[]; warnings: string[] }>;
```
- Limits: page 2 MB, 20 stylesheets × 2 MB, import depth 3 (cycle detection), 2000 `@font-face`, total time 30 s.
  - Stylesheets are followed on the page's site (same registrable domain) and on font CDNs: `fonts.googleapis.com`, `fonts.gstatic.com`, `use.typekit.net`, `p.typekit.net`, `fonts.bunny.net`, `cdn.jsdelivr.net`.
  - Only `http(s)` URLs; `data:` fonts are reported as "embedded" without bytes.
- The CSS scan is a small tokenizer (comments, strings, at-rules, blocks), not regexes over the whole file. Selector-to-role mapping: `body`, `p` → body; `h1`–`h3` → heading; `button`, `.btn` → button.
- The prompt step 1 becomes: call `inspect_site_fonts` for the main URL; Google families → `fonts_fetch`; self-hosted → `download_file` into `assets/fonts/` with "license unknown" in the proposal notes; Adobe and system fonts → name only. Report `phase` with every `report_progress`.
- UI: a stepper of `BRAND_PHASES` (completed / current / pending) above the existing free-text steps; with no phases received it renders as today.

- [ ] **Step 1. Failing tests:**
  - scanner on fixtures: real-world CSS snippets, minified, with comments and strings containing braces;
  - a Google link and a Typekit link;
  - every Review Focus 1 case;
  - 5 MB of hostile CSS scanned in under 200 ms;
  - tool allowed only for brand-analysis jobs;
  - phase events and the stepper;
  - fallback without phases.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat: site fonts from the CSS and brand analysis phases`.

---

### Task 3: Core + web — asset metadata, waveform, rename, sort, playback

**Files:**
- Modify: `packages/core/src/library/{library-store.ts,upload.ts}`, `packages/core/src/server/library-routes.ts`, `packages/core/src/brand/*` (rename references), `packages/core/src/creatives/creative-store.ts` (brief `assets` references)
- Create: `packages/core/src/library/asset-meta.ts` (probe + waveform PNG/JSON through `ffmpeg-exec` and typed filter builders)
- Modify web: `packages/web/src/screens/Assets.tsx` (split into `assets/*` if it grows past ~700 lines), `packages/web/src/ui/` (an `AudioPlayer` and a small `VideoPlayer` built on the existing transport styles)
- Test: `packages/core/test/{asset-meta,library-rename}.test.ts`, `packages/web/test/Assets.test.tsx`

**Interfaces:**
```ts
// PATCH /api/projects/:slug/assets/item/*  gains { name?: string }  (rename within the same folder)
// GET   /api/projects/:slug/assets/item/*/waveform -> { peaks: number[] } (≤ 400 values, cached in .studio/cache/waveforms/)
export function readAssetMeta(deps, absPath: string, kind: AssetKind): Promise<{ durationSec: number | null; width: number | null; height: number | null; bytes: number }>;
```
- Metadata is read at registration and, lazily, for existing assets without it (once, then stored).
- Rename:
  - `sanitizeFileName`, same folder, no overwrite, refused through symlinks (`realDirChain`);
  - updates brand logos and fonts and every creative's `brief.assets` under their locks;
  - one git commit.
  - Editor staging copies are untouched (they are copies).
- Sort: date (default), name, kind, duration.
- Players: audio with play/pause, scrub and time; video with the same controls. Both are keyboard-accessible and themed, with no native controls.

- [ ] **Step 1. Failing tests:** metadata for image, video, audio and font; waveform peaks bounded and cached; rename success with brand and brief references updated; every Review Focus 4 refusal; sort orders; players' keyboard and scrub; old assets get metadata once.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat: asset metadata, waveforms, rename, sort and playback`.

---

### Task 4: Core — ElevenLabs sound effects, music and voices

**Files:**
- Create: `packages/core/src/providers/elevenlabs-audio.ts`
- Modify: `packages/core/src/bridge/provider-tools.ts` (`sound_effect`, `music`, `list_voices`; `tts` uses the brand voice when the agent passes none), `packages/core/src/approvals/permissions-store.ts` (`PROVIDER_RULES`), `packages/core/src/agent/launcher.ts` (`MCP_TOOLS` creative + console), `packages/mcp-studio/src/server.mjs` (schemas), `availableTools()`
- Modify: `docs/providers.md`
- Test: `packages/core/test/elevenlabs-audio.test.ts`, `packages/core/test/provider-tools.test.ts`

**Interfaces:**
```ts
export function elevenlabsSoundEffect(deps: HttpDeps & { apiKey: string }, req: { prompt: string; durationSec?: number; loop?: boolean; promptInfluence?: number }): Promise<{ bytes: Uint8Array; format: 'mp3' }>;
export function elevenlabsMusic(deps: HttpDeps & { apiKey: string }, req: { prompt: string; durationSec: number; instrumental?: boolean }): Promise<{ bytes: Uint8Array; format: 'mp3' }>;
export function elevenlabsVoices(deps: HttpDeps & { apiKey: string }, req: { search?: string; pageSize?: number }): Promise<{ id: string; name: string; labels: Record<string, string>; previewUrl: string | null }[]>;
```
- Endpoints (verify against the current ElevenLabs API reference and record the date checked in `docs/providers.md`; tests use fake `fetch` only):
  - `POST /v1/sound-generation` `{ text, duration_seconds?, prompt_influence?, loop? }`;
  - `POST /v1/music` `{ prompt, music_length_ms, force_instrumental? }`;
  - `GET /v2/voices?page_size=&search=`.
- Limits: prompt 1000 chars; SFX 0.5–30 s; music 10–300 s; 50 MB response.
- Confirmation detail shows the prompt, the duration and the provider. Rules `provider:sfx-elevenlabs` and `provider:music-elevenlabs`.
- The file goes to `assets/audio/`, registered with description = prompt, `provider: 'elevenlabs'`, `model`, `durationSec` (probed), `loop`, attribution "AI-generated (ElevenLabs)".
- A 401/403 answer feeds the key-check cache (Task 8) as `missing` for that capability.

- [ ] **Step 1. Failing tests:** request bodies and headers (no key in errors); limits; confirmation once/always/deny; abort mid-request; 401/403/429 mapping; registration fields; `list_voices` free with no confirmation; `tts` defaults to the brand voice.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): ElevenLabs sound effects, music and voice listing for the agent`.

---

### Task 5: Brand sound style and voice choice

**Files:**
- Modify: `packages/web/src/screens/BrandKitSections.tsx` (new Sound section), `packages/core/src/creatives/prompt.ts` (sound style lines), `packages/core/src/brand/brand-prompt.ts` (the analysis may propose a sound style from the site's tone, optional)
- Create: `packages/web/src/screens/brand/VoicePicker.tsx` (lists voices through a core route, plays the voice preview through the core: the core fetches `previewUrl` with `safeDownload`, caps 2 MB, and serves it)
- Routes: `GET /api/voices?provider=elevenlabs|openai&q=` (OpenAI: the fixed list of documented voices); `GET /api/voices/preview?provider=&id=`
- Test: `packages/web/test/brand-sound.test.tsx`, `packages/core/test/voices-routes.test.ts`, `packages/core/test/prompt.test.ts`

- The Sound section has: genre (text with suggestions), energy (segmented), instruments (chips), avoid (chips), and voice (picker with preview).
- The prompt adds `Sound style: …` and `Brand voice: <provider> <name> (id …)` lines. Voice previews never load from the web UI directly.

- [ ] **Step 1. Failing tests:** section edits save through the brand saver; picker list, search and preview served by the core; no key gives a disabled picker with a link to Settings; prompt lines.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat: brand sound style and voice`.

---

### Task 6: Assets "Generate" dialog (core-run)

**Files:**
- Create: `packages/core/src/server/generate-routes.ts`, `packages/web/src/screens/assets/GenerateDialog.tsx`
- Test: `packages/core/test/generate-routes.test.ts`, `packages/web/test/GenerateDialog.test.tsx`

**Interfaces:**
```ts
// POST /api/projects/:slug/generate { kind: 'image'|'voice'|'sfx'|'music', provider, prompt|text, options } -> 202 { jobId }
```
- It runs as a core job (kind `asset-generation`) in the jobs queue, with progress in the activity center, cancellable. It uses the same provider functions and `confirmPaid` (approval card in the UI; "Always" per project). The result is registered like the agent's.
- The dialog is a tabbed form per kind with the brand voice and sound style prefilled. It shows the provider, the duration limits and, when the provider documents it, a cost note. A missing key gives disabled tabs with a link to Settings.
- `brief.services` does not apply here (direct user action, decision 293).

- [ ] **Step 1. Failing tests:** each kind end to end with fake fetch; confirmation; cancel; registration; disabled tabs without keys; validation messages.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat: generate images, voice, sound effects and music from the asset library`.

---

### Task 7: Services in the brief and from the chat; core enforcement

**Files:**
- Create: `packages/core/src/services/service-policy.ts`
- Modify: `packages/core/src/bridge/{bridge.ts,provider-tools.ts}` (the job context carries the creative's effective services), `packages/core/src/creatives/{creative-turns.ts,prompt.ts}`, `packages/web/src/components/BriefEditor.tsx`, `packages/web/src/screens/NewCreative.tsx`, the composer (`Conversation*`)
- Create: `packages/web/src/components/ServicesSelector.tsx`
- Test: `packages/core/test/service-policy.test.ts`, `packages/core/test/provider-tools.test.ts`, `packages/web/test/services-selector.test.tsx`

**Interfaces:**
```ts
export type ServiceDecision = { ok: true; provider: string } | { ok: false; reason: 'disabled' | 'noKey'; messageKey: string };
export function resolveService(services: BriefServices | undefined, kind: ServiceKind, requested: string | undefined, configured: ReadonlySet<ProviderId>): ServiceDecision;
```
- Rules:
  - `none` → refused before any confirmation.
  - A specific provider → that provider. A different requested one is overridden and logged in the tool result; a missing key → `noKey`, never a silent switch.
  - `auto` → today's behaviour.
  - `stock` for images → `generate_image` refused with "use stock_search"; stock tools are always allowed unless images is `none`.
- The prompt lists the services: `Services for this creative: images stock only; voice ElevenLabs; music none; sound effects auto.` It adds: "If the user asks for a disabled service, tell them it is off and that they can change it with the Services button."
- UI: the selector in BriefEditor and NewCreative (four rows; segmented choices; unavailable providers disabled with the reason). A "Services" chip in the composer opens the same selector in a popover and saves the brief (a normal brief update, a commit). The chip shows a compact summary.
- Each turn reads the brief at start, so changes apply from the next turn.

- [ ] **Step 1. Failing tests:** `resolveService` table (all choices × requested × configured); each tool handler refusal without approvals or fetch (Review Focus 2); prompt lines; selector and chip save the brief; the next turn's prompt reflects the change; old briefs behave as `auto`.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat: choose external services per creative, enforced by the core`.

---

### Task 8: Key checks per capability

**Files:**
- Create: `packages/core/src/providers/key-check.ts`
- Modify: `packages/core/src/server/settings-routes.ts` (`POST /api/secrets/:provider/check`; PUT runs a check after saving and returns it), `packages/web/src/screens/AppSettings.tsx` (results per capability, Test button, permissions help)
- Modify: `docs/providers.md` (per-provider permission table, e.g. ElevenLabs: `text_to_speech`, `sound_generation`, `music_generation`, `voices_read`, `user_read`), catalogs
- Test: `packages/core/test/key-check.test.ts`, `packages/web/test/AppSettings.test.tsx`

**Interfaces:**
```ts
export function checkKey(deps: HttpDeps, provider: ProviderId, apiKey: string): Promise<KeyCheckResult>; // read-only, free probes; never throws on 4xx/5xx
export class KeyCheckCache { get(p: ProviderId): KeyCheckResult | null; record(p: ProviderId, capability: KeyCapability, status: KeyCheckStatus, permission?: string): void; }
```
- Probes are as in spec §7, run in parallel with a 15 s timeout each:
  - 401 on the base probe → `key: missing` (invalid key);
  - 403 on a capability probe → that capability `missing` with its permission name;
  - network or 5xx → `error`;
  - capabilities with no free probe → `unverified`.
- Provider tool calls (Task 4 and the existing `generate_image`, `tts`, stock) report 401/403/success into the cache.
- UI: per provider row, a list of capability chips (ok / missing / unverified / error) with the permission to enable. "Test" re-runs the checks. After saving, it shows "Saved · checking…" and then the results. Env keys can be tested too.
- Never: key values in results, logs, events or errors (test asserts on serialized results and logs).

- [ ] **Step 1. Failing tests:** each provider's probes with fake fetch (ok, 401, 403 per capability, 5xx, timeout); Review Focus 3 cases; the cache updated by real calls; the PUT returns a check; UI chips and help text; secrets never serialized.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat: test saved keys per capability`.

---

### Task 9: Live verification and docs

- [ ] Throwaway core and driver in the scratchpad: `MemoryVault` with no real keys, system Chrome headless via CDP for the UI, fake fetch for paid providers only where the core supports injection, otherwise those flows are verified with tests and not live. Electron only with `MOTION_STUDIO_USER_DATA_DIR` verified; no packaged app.
- [ ] Scenario (screenshots into `docs/superpowers/notes/2026-10-13-phase11-live-checks.md`):
  1. Brand → Fonts → search "Inter", preview, add 400/700 → files in `assets/fonts/`, origin `google-fonts`, brand font linked;
  2. brand analysis of a real public site with haiku: phases shown, `inspect_site_fonts` used, the fonts found and fetched (or named for Adobe);
  3. Assets: play an audio and a video, rename a logo used by the brand (the brand still shows it), sort by duration;
  4. brief Services: voice `none`; ask the agent (haiku) for a voice-over → the agent says it is off and points at the chip; switch to `openai` from the chip → the next turn's prompt shows it (the paid call itself not made: no key);
  5. Settings: save a fake key → the check shows `error` or `missing` as the fake endpoint dictates (fake endpoint via the core's test hook only, never a real provider with a fake key spamming their API);
  6. Generate dialog: tabs disabled without keys.
- [ ] README en/it (fonts, sound, services, key checks), `docs/providers.md`, decisions log.
- [ ] mtimes of the three real folders before and after.
- [ ] Commit: `docs: phase 11 live checks and docs`.
