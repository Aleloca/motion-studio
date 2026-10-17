# Open follow-ups (2026-10-17)

Recovered after the macOS temp folder was cleared. This file replaces the scratchpad copies.

## User notes, second test round (2026-10-16)

Notes 1 and 4 are done (phase 15, merged as 385f898). The rest are open:

- **2:** the canvas starts the live player on hover for image formats (logo, favicon, app icon). The cause: `CanvasBoard.tsx` `liveOn = comp !== null && hover` ignores `preset.kind === 'image'`. Image formats keep the still image.
- **3:** editing inside SVGs (colours, texts, elements) without regenerating. Needs a design with the user. Does it also apply to SVGs in other formats?
- **5:** use the user's logos (`branding/`, untracked) for the desktop app icon (.icns, .ico, PNG), the web UI favicon and manifest, the in-app logo and the README. Open question: the app-icon mark is about 45% of the canvas; should it be larger?
- **6:** the macOS header needs more space between the traffic lights and the content to their right.
- **7:** a live user message (sent during a turn) stays at the bottom of the conversation, below every later agent message, although its time is earlier. It should sit in the timeline at its send time.
- **8:** Claude Code's AskUserQuestion goes through the generic permission card ("Uses AskUserQuestion", "Unknown command", raw JSON cut at 500 characters). It should be shown as a real question in the chat: the text, clickable options with descriptions and a free answer, with the answer sent back to the agent. A real case: the brief duration (~30 s) conflicted with the title/goal (12 s).
- **9:** the logo format must always produce a negative logo for dark backgrounds too: a second "dark" SVG, checked with `checkVectorSvg`, and `logo-dark.svg` and `logo-dark.png` in the set. The on-dark preview uses it, and "Usa come logo del brand" adds it to the kit (`background: 'dark'`). Open question: is a monochrome version needed too?

## Phase 15 deferred minors (from the SDD ledger)

Already resolved before the merge:
- T2 orphans (833), T3 memberOf (843), the T3 intro provider, T3 busy formats-only (841), the T3 flake (80b4ffc), T6 translations, the Task 4 create-route slug (16a19ba), the leftover pending brief at recovery (524e2c1), the discarded variant's translation edit and render-now (99a022b).

Open:
- Task 1: minor (deferred): variants.test.ts "6 members" test does not isolate the .max cap (also has a duplicate letter and a bad slug)
- Task 1: minor (deferred): variantGroupSchema does not tie a member's slug to its letter/host (slug === sisterSlug(host, letter)) — carried into Task 2 (R2 real-sister helper)
- Task 1: minor (deferred): the superRefine pick issue has no path
- Task 2: minor (deferred): requestedFormats computed before the pending brief is applied (re-check in run())
- Task 2: minor (deferred): POST variants decides `creating`/count outside the host lock (race)
- Task 2: minor (deferred): seed commits the sister before writeGroup; a later failure leaves an uncommitted deletion
- Task 2: minor (deferred): readRegularFileSync allocates maxBytes+1 on every call
- Task 2: minor (deferred): PUT picks with no body clears the ★ (only an explicit null should)
- Task 2: minor (deferred): count:1 on a new group answers with a misleading variantDirections reason
- Task 2: minor (deferred): sisters seeded with the host's links when a pending brief differs
- Task 2: minor (deferred): the lock test checks only goal, not b's final status/picks
- Task 2: minor (deferred): duplicateLocked with an existing groupId throws a misleading format-instances-full (unreachable)
- Task 2: minor (deferred): the localization overlay-edit route doesn't apply the pending brief first (only after a restart)
- Task 3: minor (deferred): directions-turn system lines go into A's conversation (834)
- Task 3: minor (deferred): legacy-policy.ts "never update" touched (could use Exclude<> typing)
- Task 3: minor (deferred): a card with busy entries isn't auto-cancelled when the user clears every job by hand (waits 600 s)
- Task 3: minor (deferred): stale queuedHooks entries after a manual removeQueued/editQueue
- Task 3: minor (deferred): card items include candidates whose start then failed
- Task 3: minor (deferred): whenIdle() never resolves while a job is held
- Task 3: minor (deferred): race (b) test still has two sleeps (could be waitFor)
- Task 3: minor (deferred): cancelAll swallows non-404 removeQueued errors, then drops the hook (the request could auto-run later)
- Task 3: minor (deferred): queuedHooks leak for never-started requests; the card isn't auto-cancelled after manual removal (600 s expiry)
- Task 4: minor (deferred): no test for the default ?? 3 when concepts is absent, favicon-only >1, mixed identity+other formats; the "no @" assertion on stringified JSON is brittle
- Task 4: minor (deferred): the IdentityStart hint names logo/favicon/app icon even for favicon-only; withConcepts prop partly vestigial
- Task 5: minor (deferred): Genera fans out only when every other active variant has 0 versions (a partly started group falls back to a single turn)
- Task 5: minor (deferred): changing variant remounts the canvas (loading blink)
- Task 5: minor (deferred): addFirstVariant implicitly assumes the host stays letter a; FormatView's synthesised star could be a helper
- Task 6: minor (deferred): indeterminate progress; the pack dialog doesn't mark language gaps; no-op `ext` in the test
- Residual minor (deferred): handFormats reads the raw choice vs the filtered kept (no-op click at worst); a render job queued before a discard still runs; the preview routes are not refused (by design)
- Out of scope (partly open): "Selezione finale" rows follow the open creative's brief.formats, so they go stale on a discarded sister. A group export with a failed source (see the SDD review).
- 182 `TimeoutOverflowWarning` lines near the web Assets tests (an absolute timestamp passed as a delay), probably pre-existing.
- `git add -A` version commits can include a sister's files in the history. Cosmetic since 868/871.
- The holds and paid-batch covers are kept in memory only, so a restart loses them.

### Phase 15 minors: triage (decisions 906-913)

| Item | Group | Why / what was done |
| --- | --- | --- |
| T1 6-members test does not isolate .max | TEST-ONLY | The test now checks the `too_big` issue on `members` (shared/test/variants.test.ts). |
| T1 member slug not tied to letter/host in the schema | LEAVE | A stricter schema would make a hand-edited creative.json unreadable; `groupTiedTo` already treats it as 'no group' (913). |
| T1 superRefine pick issue has no path | FIX | The issue now has path `['picks', format]` (variants.ts), with a test. |
| T2 requestedFormats before the pending brief | FIX | `run()` refuses a request whose formats the newly applied brief no longer has, instead of widening to every format (908). |
| T2 POST variants decides creating/count outside the host lock | FIX | Decided inside `addVariants` under the lock; concurrent test (906). |
| T2 seed commits before writeGroup | FIX | A rollback commits the removal of an already committed sister; test checks git status and ls-files (906). |
| T2 readRegularFileSync allocates maxBytes+1 | LEAVE | Cost only, and shrinking the buffer risks truncating a file that grows between fstat and read (913). |
| T2 PUT picks with no body clears the star | FIX | No body is 400; explicit `null` clears (907). |
| T2 count:1 on a new group, misleading reason | FIX | Answers `invalid-request` now (906). |
| T2 sisters seeded with the host's links, pending brief differs | FIX | The sister starts as the host is and takes the pending brief with `applySharedBrief` (906). |
| T2 lock test checks only goal | TEST-ONLY | Now also checks B's final status, picks and that no member stays discarded. |
| T2 duplicateLocked with an existing groupId, misleading error | LEAVE | Unreachable: the group service always allocates the id first; nothing for a user to see. |
| T2 localization overlay-edit route ignores the pending brief | FIX | The route applies it under the lock and the early check counts it (908), with a route test. |
| T3 directions-turn system lines in A's conversation | LEAVE | It is decision 834. |
| T3 legacy-policy.ts 'never update' touched | LEAVE | Typing nicety (`Exclude<>`), no behaviour. |
| T3 card with busy entries not auto-cancelled after a manual clear | FIX | Every target has `gone`; the card is cancelled when all are gone (909), with a test (was 600 s). |
| T3 stale queuedHooks after manual removeQueued/editQueue | FIX | `removeQueued` already dropped the hook; it now also tells the run (909). `editQueued`/`reorderQueue` keep the clientId, so nothing goes stale. |
| T3 card items include candidates whose start failed | FIX | The plan is filtered to the started variants (909), with a test. |
| T3 whenIdle() never resolves while a job is held | LEAVE | A held job is queued: not idle. The only caller (server close) cancels everything first; documented on the method (913). |
| T3 race (b) test has two sleeps | TEST-ONLY | Both are waitFor now. |
| T3 cancelAll swallows non-404 removeQueued errors | FIX | The hook stays and stops the request's turn as it is made, with a warning (909); test. |
| T3 queuedHooks leak for never-started requests | LEAVE | Bounded by the queue limit, consumed at 'Run next' or dropped at removal (909); no leak that grows. |
| T4 missing tests (default 3, favicon-only, mixed formats), brittle '@' assertion | TEST-ONLY | `identityGroupSize` cases added; the assertion now parses the stored briefs. |
| T4 IdentityStart hint names all three icons; withConcepts partly vestigial | LEAVE | Cosmetic wording and a prop kept for the brief editor (913). |
| T5 Genera fans out only if every other variant has 0 versions | FIX | Starts the open variant and every active one without versions (910), with a test. |
| T5 changing variant remounts the canvas | LEAVE | A short loading blink; remounting is what keeps each variant's state clean. |
| T5 addFirstVariant assumes host is a; synthesised star helper | LEAVE | The host is always A by construction; the helper is a refactor. |
| T6 indeterminate progress, language gaps in the pack dialog, no-op ext | LEAVE | Cosmetic. |
| Residual: handFormats raw choice; render queued before discard still runs; preview routes not refused | LEAVE | No-op click at worst; the render is inert and harmless; preview routes are by design. |
| Out of scope: Selezione finale rows follow the open creative's formats | FIX | Rows follow the host's brief (910), with a test on an open sister. |
| Out of scope: group export with a failed source | LEAVE | A failed source is already left out and listed in `unavailable`, not an error. |
| 182 TimeoutOverflowWarning lines near the web Assets tests | FIX | Not Assets: the refresh delay `expiry - now` with a 2099 expiry (editor tests) exceeded 2^31 ms. Capped in product code (911). |
| git add -A version commits can include a sister's files | LEAVE | Cosmetic since 868/871. |
| Holds and paid-batch covers in memory only, restart | LEAVE | Queue, card and covers die together; interrupted creatives are recovered, queued requests wait for 'Run next'. Nobody is stranded (912). |
