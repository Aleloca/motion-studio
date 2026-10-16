# Motion Studio — Phase 15: Creative variants — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creative can have up to 5 variants. Each variant is a complete creative direction across every format. The user picks a ★ per format from any variant, discards variants (hidden, restorable), and exports the group's selection.

**Architecture:**
- **Group and sisters.** A variant group is hosted by the existing creative (variant A) in an additive `variantGroup` field. The other variants are sister creatives `<slug>~b`…`~e` with `variantOf`. Each sister is a normal creative, so turns, versions, editor, renders, localization, comments, queue and Stop are reused unchanged.
- **New core pieces:**
  - a `VariantGroupService` (create, add, discard and restore, propagate the brief, ★ picks, layout);
  - a directions turn with the MCP tool `submit_variant_directions`;
  - a fan-out runner for "Tutte" and for initial generation, with concurrency 2 and one paid-batch confirmation;
  - a group export.
- **Web:** the variants field in New creative, the chat selector, the canvas grouping toggle, the ★ across variants, the "Selezione finale" summary, discard and restore, and "+ Variante".

**Tech Stack:** TypeScript, zod, Fastify, React 19, the existing JobQueue, approval broker (`paid-batch`), MCP bridge and export pipeline. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-motion-studio-phase15-variants-design.md` (Italian; every choice confirmed by the user on 2026-10-16). Read it first.

## Global Constraints

**Limits.**
- Max **5** variants per group; letters `a`…`e`, and A is always the host.
- At most **2** variant turns running at once per group.
- `~` is reserved in creative slugs.

**Compatibility.**
- `creative.json` changes additively only (`variantGroup` on the host, `variantOf` on sisters).
- A creative without `variantGroup` behaves and renders exactly as today, with no selector and no toggle. The existing `exportPicks` stays authoritative for it.
- Export file names are unchanged.

**Brief.**
- Brief, formats, formatLabels, languages, services and storePack are shared. Editing them updates every active variant.
- A variant that is running gets the new brief at its next turn, never mid-turn.

**Paid services.**
- Each variant generates its own audio.
- One `paid-batch` confirmation covers every variant of a start or of an "all variants" request.
- Brief services apply to all variants.

**Agent isolation.** A variant's agent never writes into a sister's folder: the existing per-creative protections apply. It sees the other variants' directions only as prompt text.

**Real folders.**
- Baselines: `~/Library/Application Support/Motion Studio` 1792005599, `~/MotionStudio` 1792004787, `~/Library/Application Support/Motion Studio Electron` 1792006312, and `~/Library/Application Support/Electron` absent. Check them before and after any live check.
- Every Electron launch uses `MOTION_STUDIO_USER_DATA_DIR`, with `CLAUDE*`/`ANTHROPIC*` removed from its env. No shim downloads. No packaged app launches.

**Chrome.** Only through the harness or `BASE_FLAGS` (mock keychain, basic password store).

**Providers.** No real calls to paid providers: fake fetch, `MemoryVault`, a temp `MOTION_STUDIO_CONFIG_DIR`.

**Tests (decision 702).** Each task runs its targeted tests plus `pnpm typecheck` and `pnpm check:i18n`. The full suite runs once at the end, on a quiet machine: no parallel suites.

**Process.**
- No push, PR, release or publish.
- Never kill by pattern.
- No `git stash`, `reset`, `checkout -- <path>`, `clean`, amend, rebase or history rewrites.
- Run every script with cwd = the phase worktree.
- Commit trailers exactly:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01KxKL6zuy8dbnJieqN1eCNg`
- Decisions-log entries from **820** on. The design choices are the user's (spec), so label orchestrator rulings "decisione: orchestratore (2026-10-16)".
- On a safety-classifier stop: stop, report, and never rephrase around it.

## Review Focus

1. **Brief edited while variant B is running and variant C is queued.**
   - Expected: B finishes on the old brief and picks up the new one at its next turn; C starts with the new brief; A, B and C converge.
   - No variant ever has a mix of old and new formats.
   - Test in Task 2.
2. **A format removed while its ★ points to variant C.**
   - Expected: the ★ is removed; the group export no longer lists the format; C's history keeps its old versions; nothing throws in the "Selezione finale" summary.
   - Test in Task 2, plus the summary in Task 5.
3. **Discarding a variant that holds ★s, or that is running.**
   - Expected:
     - the ★s fall back to the default rule;
     - a running variant can't be discarded until stopped, with a translated reason;
     - the last active variant can't be discarded;
     - restoring brings it back without its old ★s.
   - Test in Task 2, with UI in Task 5.
4. **"Tutte" with 4 active variants and a paid tool.**
   - Expected: exactly one paid-batch confirmation listing every variant and the total. Two variants run, two wait with the reason. Declining cancels all four with no spend. Stopping one leaves the others running.
   - Test in Task 3.
5. **The group host A deleted by hand, or a sister's folder missing.**
   - Expected: the orphan sister opens as a single creative with a notice. A lists the missing member as "mancante". The list, export and canvas never throw.
   - Test in Task 2, with the list and canvas in Task 5.

---

### Task 1: Shared model

**Files:**
- Create: `packages/shared/src/variants.ts`
- Modify: `packages/shared/src/creative.ts` (additive fields), `packages/shared/src/index.ts`, `packages/shared/src/i18n/{en,it}.ts`
- Test: `packages/shared/test/variants.test.ts`

**Interfaces (produces):**
```ts
export const MAX_VARIANTS = 5;
export const MAX_RUNNING_VARIANTS = 2;
export type VariantLetter = 'a' | 'b' | 'c' | 'd' | 'e';
export const VARIANT_LETTERS: readonly VariantLetter[];
export interface VariantMember { slug: string; letter: VariantLetter; direction: string | null; directionSource: 'agent' | 'user' | null; status: 'active' | 'discarded'; createdAt: string }
export interface VariantPick { slug: string; version: number }
export interface VariantGroup { members: VariantMember[]; picks: Record<string, VariantPick>; layout: 'variant' | 'format' }
export const variantGroupSchema: z.ZodType<VariantGroup>; // members 1..5, unique letters and slugs, members[0].letter === 'a' (the host), at least one member 'active', every pick's slug is a member
export const sisterSlug: (hostSlug: string, letter: VariantLetter) => string; // `${host}~${letter}` for b..e; host itself for a
export const isSisterSlug: (slug: string) => boolean; // contains '~'
export const hostOf: (slug: string) => string;
export const nextLetter: (g: VariantGroup) => VariantLetter | null;
export const activeMembers: (g: VariantGroup) => VariantMember[];
export const canDiscard: (g: VariantGroup, letter: VariantLetter, running: boolean) => { ok: true } | { ok: false; reason: 'last-active' | 'running' | 'unknown' };
export const directionLine: (m: VariantMember) => string; // "B · <direction>" or "B"
// creative.ts additions: creativeFileSchema.variantGroup?: VariantGroup ; creativeFileSchema.variantOf?: string ; brief-level: nothing new
```
- Slug validation: the existing creative slug rule refuses `~` for user-created creatives (`creativeSlugSchema`). A separate `sisterSlugSchema` accepts exactly `<slug>~[b-e]`.
- A (the host) may be marked `discarded` only while another member is active. It always keeps hosting the group data.

- [ ] **Step 1. Failing tests:**
  - schema accepts or refuses: 6 members, duplicate letters, member[0] not `a`, a pick to an unknown slug, a `~` in a user slug, `~f`;
  - `canDiscard`: last active, running, ok;
  - `nextLetter` skips used letters and returns null at 5;
  - an old creative.json without the fields parses unchanged;
  - i18n keys exist in en and it: variant labels, "Raggruppa per", "Variante", "Formato", "Tutte", "+ Variante", "Scarta", "Ripristina", "Mostra scartate", "Usa questa variante per tutti i formati", "Selezione finale", "mancante", and the reasons.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(shared): variant group model`.

---

### Task 2: Core — VariantGroupService (group lifecycle, brief propagation, picks, discard, orphan handling)

**Files:**
- Create: `packages/core/src/creatives/variant-group.ts`
- Modify:
  - `packages/core/src/creatives/creative-store.ts` (list collapses sisters; reads `variantOf`/`variantGroup`);
  - `packages/core/src/server/creative-routes.ts` (new routes);
  - `packages/core/src/creatives/creative-turns.ts` (`updateBrief` on a grouped creative goes through the service; a running variant gets the brief at its next turn);
  - `packages/core/src/creatives/export.ts` (group export, see Task 6, only the hook here).
- Test: `packages/core/test/variant-group.test.ts`, `packages/core/test/variant-routes.test.ts`

**Interfaces (produces):**
```ts
export class VariantGroupService {
  constructor(deps: { store: CreativeStore; turns: CreativeTurnService }); // group writes use the existing per-creative lock, CreativeTurnService.runLocked
  /** Creates the sisters for a new or existing host (members b..), copying brief and formats; no turn starts here. */
  addVariants(ref: CreativeRef, specs: Array<{ direction?: string; baseFrom?: { slug: string; version: number } }>): Promise<VariantGroup>;
  discard(ref: CreativeRef, letter: VariantLetter): Promise<VariantGroup>;   // 409 'variant-running' | 'variant-last-active'
  restore(ref: CreativeRef, letter: VariantLetter): Promise<VariantGroup>;
  setPick(ref: CreativeRef, formatId: string, pick: VariantPick | null): Promise<VariantGroup>; // 422 when the slug is not an active member or the version lacks the format
  useVariantForAll(ref: CreativeRef, letter: VariantLetter): Promise<VariantGroup>; // ★ = that variant's default-rule version per format it has
  setLayout(ref: CreativeRef, layout: 'variant' | 'format'): Promise<VariantGroup>;
  setDirection(ref: CreativeRef, letter: VariantLetter, direction: string, source: 'user' | 'agent'): Promise<VariantGroup>;
  /** Writes the brief to every active member; members running a turn get it on their next turn (pendingBrief in core side-state). */
  propagateBrief(ref: CreativeRef, brief: Brief): Promise<{ applied: string[]; deferred: string[] }>;
  resolve(ref: CreativeRef): Promise<{ host: CreativeRef; group: VariantGroup | null; missing: string[]; orphan: boolean }>;
}
// Routes (all under the UI token, like the other creative routes):
// POST   /api/projects/:p/creatives/:c/variants            { count?: number, directions?: (string|null)[], baseFrom?: {...} }
// POST   /api/projects/:p/creatives/:c/variants/:l/discard  | /restore
// PUT    /api/projects/:p/creatives/:c/variants/picks/:formatId   { slug, version } | null
// POST   /api/projects/:p/creatives/:c/variants/:l/use-for-all
// PUT    /api/projects/:p/creatives/:c/variants/layout      { layout }
// PUT    /api/projects/:p/creatives/:c/variants/:l/direction { direction }
// GET    /api/projects/:p/creatives  -> one row per group, `variants: { count, active }` on the host row; sisters omitted
```
- All group writes happen under the host's creative lock. A brief propagation takes each member's lock in letter order (a→e), so two writers cannot deadlock.
- `pendingBrief` lives in the core's config-dir side-state (like the queue, `creative-side-state.ts`): out of the agent's reach and out of git. It is applied at the start of that member's next turn.
- Removing a format from the brief deletes any `picks[formatId]`.
- Discarding clears that member's picks.
- Deleting or renaming the host applies to every member.
- [ ] **Step 1. Failing tests:**
  - Review Focus 1, 2, 3 and 5;
  - adding a 6th variant is refused;
  - `baseFrom` copies the base version's compositions into the new sister as its starting point, using the same mechanism as the editor's "agent turn after a save" (decision 263);
  - list collapses sisters;
  - an old creative is unchanged by every route except POST variants;
  - lock ordering: a concurrent propagate plus a discard leaves no deadlock (fake slow store).
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): variant groups — sisters, shared brief, picks, discard and restore`.

---

### Task 3: Core — directions turn, fan-out runner (concurrency 2), one paid-batch confirmation

**Files:**
- Create: `packages/core/src/creatives/variant-directions.ts`, `packages/core/src/creatives/variant-fanout.ts`
- Modify:
  - `packages/mcp-studio/src/server.mjs` (new tool `submit_variant_directions`);
  - `packages/core/src/bridge/bridge.ts` + `provider-tools.ts` (handler; only for job kind `variant-directions`);
  - `packages/core/src/agent/launcher.ts` (MCP_TOOLS for the new kind; no write tools, no Bash);
  - `packages/core/src/creatives/prompt.ts` (a "Variant" section: own direction, the others' directions as "do not copy");
  - `packages/core/src/approvals/confirm-paid.ts` / `broker.ts` (group batch).
- Test: `packages/core/test/{variant-directions,variant-fanout,variant-paid-batch,variant-prompt}.test.ts`

**Interfaces:**
```ts
// MCP: submit_variant_directions { directions: string[] }  -> { ok: true } | { ok: false, errors }
//   exactly the number of missing directions, each 3..140 chars, trimmed, pairwise different (case-insensitive)
export async function runDirectionsTurn(ref: CreativeRef, missing: VariantLetter[], given: Record<VariantLetter, string>): Promise<Record<VariantLetter, string>>;
export class VariantFanout {
  /** Starts `request` (or the initial generation when null) in each target member, at most MAX_RUNNING_VARIANTS at once; the rest wait as queued with reason 'variant-slot'. */
  start(ref: CreativeRef, targets: VariantLetter[] | 'all-active', request: UserRequest | null): Promise<{ jobs: Record<VariantLetter, string> }>;
}
// paid batch: one approval card { kind: 'paid-batch', items: [{ variant, provider, capability, chars|seconds, estimate }], total } shared by the fan-out jobs; decline cancels every job of the batch
```
- The directions turn uses a cheap model where the launcher already supports it; otherwise it uses the default model. Brief services don't apply, since the turn makes no paid calls.
- When the user typed every direction, the directions turn is skipped.
- [ ] **Step 1. Failing tests** (fake runner and fake CLI only):
  - Review Focus 4;
  - the tool refuses a wrong count or duplicates, and a repair turn follows;
  - the directions turn has no write tools;
  - the prompt contains the member's direction and the others' as "do not copy";
  - the queue releases the next variant when one finishes, fails or is stopped;
  - stopping one variant doesn't affect the others.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat(core): variant directions turn, fan-out with two slots, one paid-batch confirmation`.

---

### Task 4: Identity concepts become variants

**Files:**
- Modify:
  - `packages/core/src/server/creative-routes.ts` (create: `identity.concepts` > 1 now creates a group with that many variants instead of `identity-logo@k` instances);
  - `packages/web/src/screens/identity/IdentityStart.tsx` (the "proposte" control becomes "Varianti" for the whole creative);
  - `packages/core/src/creatives/prompt.ts` (identity section: favicon and app icon derive from this variant's logo).
- Test: `packages/core/test/identity-variants.test.ts`, `packages/web/test/identity-picker.test.tsx` (update)

- [ ] **Step 1. Failing tests:**
  - creating a "logo da zero" with 3 concepts plus favicon plus app icon gives 3 variants, each with all three formats, and no `@k` instances;
  - an existing creative with `identity-logo@2/@3` still loads and renders, with its instances untouched (decision 786 data);
  - the prompt of variant B states that its favicon and app icon come from its own logo.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat: identity concepts are variants (logo, favicon and app icon per variant)`.

---

### Task 5: Web — New creative field, chat selector, canvas grouping, ★ across variants, Selezione finale, discard/restore, + Variante

**Files:**
- Create:
  - `packages/web/src/screens/variants/{VariantSelector.tsx,VariantRowHeader.tsx,FinalSelection.tsx,AddVariantDialog.tsx,variantModel.ts}`;
  - `packages/web/src/screens/variants/variants.css`.
- Modify:
  - `packages/web/src/screens/NewCreative.tsx` (field "Varianti" 1–5, optional direction per variant);
  - `packages/web/src/screens/CreativeCanvas.tsx` + `CanvasBoard.tsx` (layout toggle, rows per variant or per format, ★ per board writing the group pick, discarded hidden or shown greyed);
  - `packages/web/src/components/Conversation.tsx` (selector A · B · C · Tutte; posts to the member, or to the fan-out route for Tutte);
  - `packages/web/src/screens/ProjectCreatives.tsx` (one row per group with "N varianti", "mancante" handling);
  - `packages/web/src/api.ts`, i18n.
- Test: `packages/web/test/{variants-new-creative,variants-chat-selector,variants-canvas,variants-final-selection,variants-list}.test.tsx`; Chrome layout check of the canvas in both layouts at 1280 and 1024, it and en, through the harness.

**Behaviour:**
- Defaults match the spec exactly. A creative without a group shows no selector and no toggle.
- The ★ on a board in a grouped creative calls `PUT …/variants/picks/:formatId`.
- The variant row header has ⋯ with "Usa questa variante per tutti i formati", "Scarta" (disabled with its reason when running or last active), "Esporta questa variante" and "Modifica direzione".
- "Mostra scartate" is a toggle in the canvas toolbar. Discarded rows are greyed and offer "Ripristina".
- "Selezione finale" is a popover from the toolbar: one row per format, "Formato · Variante B · v3", and "regola predefinita" when there is no pick.
- [ ] **Step 1. Failing tests:**
  - every behaviour above;
  - Review Focus 2 (summary after a format removal), 3 (UI reasons) and 5 (list and canvas with a missing member);
  - the old creative's canvas DOM is unchanged.
- [ ] **Steps 2–4.** FAIL → implement → PASS. Run the Chrome layout check alone first.
- [ ] **Step 5. Commit:** `feat(web): variants — new creative, chat selector, canvas grouping, ★ across variants, final selection, discard and restore`.

---

### Task 6: Group export

**Files:**
- Modify: `packages/core/src/creatives/export.ts`, `packages/core/src/store-pack/pack-export.ts`, `packages/web/src/screens/ExportDialog.tsx`, i18n
- Test: `packages/core/test/variant-export.test.ts`, `packages/web/test/export-dialog-variants.test.tsx`

- For a grouped creative, the export takes each format from its group pick, or from the default rule applied to variant A. File names are unchanged.
- "Esporta questa variante" uses today's export of that member.
- The store pack export of a group takes, for each pack format, the group pick.
- [ ] **Step 1. Failing tests:**
  - a mixed selection exports the right files with today's names;
  - a removed format is absent;
  - a discarded variant is never used;
  - a single-variant export works;
  - a group pack export works;
  - an old creative's export is unchanged.
- [ ] **Steps 2–4.** FAIL → implement → PASS.
- [ ] **Step 5. Commit:** `feat: group export from the ★ of each format`.

---

### Task 7: Live check, docs, final

**Files:** `docs/superpowers/notes/2026-10-16-phase15-live-checks.md`, `README.md`/`README.it.md`, `docs/decisions-log.md`.

- [ ] **Step 1.** Record the real-folder mtimes. Set up a temp workspace and a temp `MOTION_STUDIO_USER_DATA_DIR`, with `CLAUDE*`/`ANTHROPIC*` removed from the Electron env.
- [ ] **Step 2.** In the dev Electron app, with the real Claude Code and paid services off:
  1. a creative with 3 variants (one direction typed, two from the agent);
  2. one "Tutte" request;
  3. a mixed ★ selection and a group export;
  4. a "logo da zero" with 3 variants (logo, favicon and app icon);
  5. discard and restore.
  - If the classifier stops a step: stop and report.
- [ ] **Step 3.** Write the notes (results, not committed screenshots) and update the docs.
- [ ] **Step 4.** On a quiet machine, run the full suite once with `MS_REQUIRE_CHROME=1` and a temp config, plus typecheck, i18n and build. Recheck the mtimes.
- [ ] **Step 5. Commit:** `docs: phase 15 live checks and user docs`.
