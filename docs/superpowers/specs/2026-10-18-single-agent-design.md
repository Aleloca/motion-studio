# One agent per creative (decisions 977–982, user reports 32 and 35)

Status: design, not built. Branch `feat/single-agent`. Decisions of this design: 1140–1145 in `docs/decisions-log.md`.

## 1. Why

Today each variant (A, B, C…) of a creative is a creative of its own (`slug`, `slug~b`, …). Each has its own Claude Code
session, its own `conversation.jsonl`, its own queue, Stop and approvals. The variants page has a "Tutte" selector, and a
message sent from there goes to every variant (`VariantFanout.run`). So "create a new variant F" ran five times and
failed five times on the five-variant limit (report 32). The user strongly dislikes one agent per variant: the chat is
hard to follow and hard to talk to (report 35).

The user's calls:

| # | Call |
|---|---|
| 977 | ONE agent and ONE chat per creative, for every variant. The target variant comes from the comments or notes left on a variant, or from the message naming it. "New variant" runs once. |
| 978 | No limit on the number of variants. |
| 979 | A message that names no variant and has no comment attached: the agent always ASKS which variant, even when the user is inside one. |
| 980 | The same chat on the variants page, inside a variant and in the editor. Each agent message shows which variants it worked on. |
| 981 | The first generation of N variants stays parallel. The one agent hands the heavy work to helpers behind the one chat. |
| 982 | For existing creatives, the per-variant chats are merged into one, in time order, with each message labelled with its variant. From then on there is one agent. |
| 972 / 1060 | Versions stay per variant and per format. A run that changes no output makes no version. |

## 2. Goals, non-goals, anti-goals

**Goals**
- The user sees one conversation per creative and one voice. Every work message carries the letters of the variants it
  touched.
- One request runs once, whatever page it was sent from.
- Several variants are worked on in parallel when one request targets several of them (the first generation included).
- Versions, validation, the repair loop, decision 1060's kept version, renders, picks and export stay per variant and per
  format, with the code they have today.
- There is no cap on variants.
- Existing groups migrate on their own, with nothing lost.

**Non-goals**
- Creatives without variants (no `variantGroup`): unchanged. Their one turn already is "the agent".
- Translation turns, brand analysis, the console and export jobs: unchanged.
- Folder layout: each variant keeps its own creative folder (`slug~b/`) with `versions.json`, `outputs/vN`, `creative.json`.
  Only the conversation, the agent's session and the queue move up to the group.

**Anti-goals**
- No guessing of the target. The variant open on screen is never the target by default (979).
- No hidden fan-out. Nothing the user typed is copied to N agents. The agent decides the work for each variant and says
  so.
- No single Claude session editing every variant's files. Section 5 explains why.
- No merged Claude sessions. They can't be merged, and section 10 says what the agent remembers.

## 3. The shape, in one picture

```
user ── one chat (host's conversation.jsonl, every entry may carry `variant`)
          │
          ▼
   GROUP TURN (job kind `creative-group`, key `group:creative:<root>:<project>:<host>`, lane `coordinator`)
     1. coordinator run   — Claude CLI, the group's session, read-only on the variants' folders,
                            tools: list_variants, work_on_variants, add_variants, set_pick, update_brief, …, AskUserQuestion
                            → answers, asks (979), or dispatches work items {variant, instruction, formats?}
     2. paid card         — one card for the dispatched variants (2 or more), only for services their formats can use
     3. helper turns      — one per dispatched variant: TODAY's creative turn of that member (CreativeTurnService.run),
                            in parallel under the group's slot limit; each saves (or keeps, 1060) its own version
     4. report run        — the coordinator's session resumed with the outcome per variant → the closing message
```

The coordinator is "the agent" the user talks to. The helpers are today's per-variant turns. Their sessions stay per
variant, and in the UI they work behind the one chat (981).

## 4. Data model

### 4.1 The conversation

- A group's single conversation is the HOST's `creatives/<host>/conversation.jsonl`. No new file and no new route:
  `GET …/creatives/:c/conversation` for any member returns the group's conversation.
- **One choke point, the store.** `CreativeStore.appendConversation(slug, entry)` and `readConversation(slug)` resolve a
  group member to its host. Appends are stamped `variant: <letter of slug>` unless the entry already says otherwise.
  About forty call sites in `creative-turns.ts`, `variant-fanout.ts` and `agent-actions.ts` write with the member's slug
  today, and they keep doing so. Readers that reason about their own creative get a filter: `readConversation(slug, {
  variant })` (the queued-entry check in `startLocked`, the "conversion told once" check in `run`, `lastTurnSession`,
  `turnEndOf`, the Activity center's "versions made").
- New optional fields on entries (shared `ConversationEntry`):
  - `variant?: VariantId` on every entry type. It is absent on coordinator entries and on entries of a creative outside
    any group.
  - `groupJobId?: string` on helper entries: the group turn they belong to (the UI folds them under it).
  - A new entry type `{ type: 'group-turn', at, jobId, outcome: Array<{ variant, jobId, version: number | null,
    kept: boolean, status: 'complete' | 'incomplete' | 'failed' | 'stopped' | 'unchanged' }> }`. It is written once
    when the group turn settles. It is the source of the "worked on B (v4), C (no change)" footer (980).
- The sisters' own `conversation.jsonl` files are no longer read after migration. They stay on disk as
  `conversation.premerge.jsonl` (section 10).

### 4.2 Sessions

- **Coordinator session.** Stored in the host's core side state (`CreativeSideStateStore`, next to `queued` and
  `pendingBrief`) as `groupSession: { sessionId, at }`. The agent can't reach it there, and it stays out of git, like
  `stoppedSession`. It is set from the coordinator run's `session` / `result` events. If resuming fails `not-found`, the
  turn starts a fresh session with the bootstrap digest (section 10), once per turn, using the same rule as
  `resumeErrorOf`.
- **Helper sessions.** Unchanged: per member, per version (`VersionEntry.sessionId`, `resumeFrom`, `stoppedSession`).
  B's helper resumes B's chain, so it keeps everything it knew about B's compositions.

### 4.3 What a turn targets

- A **work item** is `{ variant, instruction, formats?, pins? }`. `instruction` is the coordinator's own words for that
  variant. The helper's prompt gets them as today's `userText`, followed by the user's original message, quoted, under
  "The user's request (for context)". `pins` are the user's pins on that variant only.
- A group turn's **plan** is its list of work items. It is fixed when the coordinator run ends. A second
  `work_on_variants` call in the same run adds items or replaces the item for the same variant. It is never a second
  wave. The report run can't dispatch: if more work is needed, it says so and the user asks (or a later phase allows one
  follow-up wave, section 13).
- **Per variant, everything stays as it is.** Each work item becomes one helper turn of that member, through
  `CreativeTurnService.start(memberRef, message, { formats, parent: groupJobId, hold })`. The helper plans its formats
  (`planTurn`), validates (`validateOutputs`, `checkTargets`), runs its repair loop (`maxAttempts`), saves `vN+1` or keeps
  the latest (1060, `keepsLatest`), and runs its deferred app actions. That is today's code path, unchanged.
- **Report 33 must be fixed first** (Phase 0). A helper that writes no composition must count as unchanged. Today
  `keepsLatest` needs every target format delivered, and an untouched version folder delivers none, so a no-op made an
  incomplete version and two repair runs. Under one agent this matters more: the coordinator may dispatch a variant that
  then needs nothing.

### 4.4 Variant ids without a limit (978)

- `VariantLetter` (`'a'…'e'`) becomes `VariantId`: `a…z`, then `aa…az`, `ba…`, a bijective base-26 sequence that is
  lower-case in folders and slugs and upper-case on screen. `VARIANT_LETTERS` becomes `variantIdAt(i)` / `variantIndex(id)`.
- Regexes: `sisterSlugSchema` and `SISTER_SLUG_RE` go from `~[b-e]` to `~(?!a$)[a-z]{1,2}`. `letterOfSlug` reads
  everything after `~`; today's `slice(-1)` breaks on `aa`. The 80-character slug rule leaves room.
- Drop `MAX_VARIANTS` from `variantGroupSchema`, `creative-routes.ts` (`count`, `directions`, `targets`), the
  `paidBatchSchema` item enum, the `mcp-studio` enums and `maxItems: 5`, `VariantsField` and CreativeCanvas `canAdd`, and
  the i18n `variantsFull` / `addFull` (`variants-full` goes away). Discarded variants keep their id, and ids are never
  reused.
- `MAX_RUNNING_VARIANTS = 2` stays. It is a parallelism limit, not a cap: dispatching to 8 variants runs 2 and queues 6,
  with the existing `variant-slot` wait reason.

## 5. How the parallel helpers work: options weighed

**A. Claude CLI subagents (the `Task` tool) inside one session.** Rejected.
- The core can't see or scope them. The bridge token and `appScope` are per job (one creative, one version `n`).
  `validate_composition`, `preview_frames`, deferred actions and usage records would all need a variant argument, with
  no way to bind a subagent to it.
- Approvals, per-variant Stop, per-variant usage, the tripwire and the per-version `protectedDirs` all assume one job,
  one creative.
- Subagents write into the parent's session context, so the cost grows with every variant.
- `Task` is neither allowed nor denied today. It would fall through to `mcp__studio__approve`.

**B. One session that edits several variants per turn, in sequence.** Rejected.
- `CreativeTurnService.run` (≈1300 lines: plan, prompt, attempts, repair, save, keep) would have to become multi-creative.
  That is the riskiest rewrite in the codebase.
- The one session's context fills with every variant's composition work. With no variant limit, it compacts often and
  gets worse.
- Multi-variant requests ("bigger titles everywhere") become N times slower. First-generation parallelism would still
  need forks whose memory is lost, which is A or C again.

**C. A coordinator conversation plus core-run helper turns.** Recommended.
- The parallel work is today's per-variant turn. It is battle-tested: versions, 1060, repair, Stop, cover, slot,
  usage, and the tripwire scoped per creative.
- The coordinator's context stays small (conversation, summaries, tool results), and each helper's context stays per
  variant. That scales to any number of variants.
- The existing per-variant sessions become the helpers' memory, so migration loses nothing (section 10).
- Costs:
  - Two extra short Claude runs per group turn (the coordinator run and the report run). With prompt caching on a
    resumed session they are small next to a helper's run.
  - When the coordinator answers a question itself, there is no helper at all. Today every message to a variant runs a
    full composition turn (report 33's "Che problemi dovrebbe avere?" made v3).
- Cancellation: Stop on the group turn stops its coordinator run and every helper (`stopJob` on each child). Stop on one
  helper's row stops that variant only, and the report run says so.

**The coordinator never blocks on its helpers.** `work_on_variants` only records the plan and returns at once. The
coordinator is told to end its run with one short line ("Lavoro su B e C"). The core starts the helpers when the run
ends, and resumes the session for the report once they all settle. This avoids an MCP call that waits for twenty
minutes (`MCP_TOOL_TIMEOUT` is 15 minutes) and a live CLI process that bills nothing but holds a slot.

**Queue mechanics.**
- The group turn is a new job kind `creative-group` in a new lane `coordinator` (limit 4). If it took a main-lane slot
  while waiting for its helpers, with `concurrency: 2` it could starve the very helpers it waits for.
- One group turn per group at a time: its key conflicts by `JobQueue.enqueue`.
- Helpers keep their `creative:` keys, their `variant-slot` group and their main-lane slots. `JobSummary` gains
  `parentJobId`.
- A user action on the variant page that already names its variant ("Genera" on a card, a format's regenerate, a failed
  variant's retry) starts a group turn **without a coordinator run**: one work item, the variant given. The chat gets a
  system line, and the coordinator learns of it from the digest in its next prompt (section 10).

## 6. The coordinator's tools (MCP kind `creative-group`)

These are new entries in `MCP_TOOLS` and `APP_ACTION_TOOLS`, scoped by the bridge token to the group (`appScope.group =
host ref`), with the same thin-call rule as decision 917.

| Tool | What it does |
|---|---|
| `list_variants` | Id, direction, status (active/discarded), working or queued, latest version per format with status and problems, ★ picks. |
| `work_on_variants({ items: [{ variant, instruction, formats? }] })` | Records the plan (section 4.3). Refuses unknown or discarded ids, and refuses targets that fail the ask guard (section 7). |
| `add_variants({ items: [{ direction, baseFrom?: { variant, version } }] })` | Creates the sisters at once, with no limit. Each new variant becomes a work item of this turn (its first generation). Replaces `add_variant`. |
| `discard_variant` / `restore_variant({ variant })` | As today. Refused for a variant with work in this turn. |
| `set_pick({ format, variant, version })` | `variant` is now required. `'current'` is gone (a coordinator has no version of its own). |
| `update_brief`, `add_format`, `duplicate_format`, `add_language`, `render_version({ variant, version, formats? })`, `prepare_export` | Group-wide versions of today's actions, through the same `VariantGroupService` and `AgentActionService` code. |
| `set_variant_directions` | Replaces the separate `variant-directions` job: the coordinator writes the missing directions itself, checked by today's `checkDirections`. |
| `AskUserQuestion` (built in) | The ask of 979. It goes through the existing `questions` approval card, with the variants as options (the user's preference: questions with options). |

- **Coordinator permissions.**
  - Read/Grep/Glob on the project: it can open any variant's compositions to answer or compare.
  - No Edit or Write: `denyWrite` on `creatives/**`, with no `acceptEdits` paths of its own, and no Bash.
  - No paid provider tools: those are the helpers'.
- **Helper tools.** Today's creative tool set without the group-level actions (`add_variant`, `discard_variant`,
  `restore_variant`, cross-variant `set_pick`). The helper prompt says it works on one variant for a coordinator, and must
  not ask the user about targets. `AskUserQuestion` stays for in-work choices, and its card carries the variant id.
- **Prompts.**
  - `prompt.ts` gains `buildCoordinatorPrompt`. Its inputs: the group brief, the variants (`list_variants` data inline),
    the request with its pins grouped by variant, the explicit targets, the digest since the coordinator's last run, the
    rules (ask rule, dispatch instead of editing, one closing line, answer questions directly), and the locale.
  - It also gains `buildCoordinatorReport` for the report run: the per-variant outcome (version, kept, problems, the
    helper's final text, trimmed).
  - `variantSection` stays for helpers.

## 7. Targeting and the ask rule (979)

- **Pins carry their variant.** `Pin` gains `variant?: VariantId`, set by the UI from the member on which the pin was
  placed. The canvas, `FormatView` and `EditorScreen` all know it. Pending pins move from the key `project/creative` to
  `project/host`, so the one composer shows the pending comments of every variant, each with its letter chip.
- **Explicit targets** are the set of variants of the message's pins. The core computes them and passes them to the
  coordinator.
- **The ask rule, in the prompt.** If a request asks for work and has no explicit target and no variant named in the
  text, the coordinator calls `AskUserQuestion` with options "A · direction", "B · direction", …, plus "Tutte". It does
  this even when the message came from inside a variant. The prompt says nothing about the page the user is on: that
  fact is deliberately not given.
- **The ask rule, as a guard in the core.** `work_on_variants` accepts a variant only when at least one of these holds:
  - it is an explicit target;
  - it was the answer to an `AskUserQuestion` in this group turn;
  - the user's text names it (a small parser for the letter tokens "B", "variante B", "B e C", "B-D", and the words
    "tutte/tutti/ogni/all/every"; `it` and `en`);
  - it is a new variant created by `add_variants` in this turn.

  Otherwise the call fails with "ask the user which variant (AskUserQuestion)". That makes the "never guess" rule
  testable without trusting the model. Questions that need no work ("quanti formati ha C?") need no target and dispatch
  nothing.
- **Notes.** The brief's `notes` are the group's and target nothing. Only pins (comments) target.

## 8. UI

- **One `Conversation` everywhere.**
  - `useCreative` loads the host's conversation for any group member: the variants page, a sister's `FormatView`, and
    `EditorScreen`.
  - `VariantSelector` and `ChatTarget` (`'all'`) are removed, along with `runAll`, `fanout`, `sentToAll*` and
    `pinsNotSentToAll`.
  - The Composer always posts to the group: `POST …/creatives/:host/turns` with `{ text, pins }`, where the pins carry
    their variants.
- **Entries.**
  - User messages show the chips of their pins' variants.
  - A coordinator message is the agent's voice.
  - A group turn's helpers are folded under it: one collapsed row per variant ("B · al lavoro…" with the live progress
    line, then "B · v4 completa"). It opens on the helper's own stream: events filtered by `groupJobId` and `variant`.
  - The `group-turn` entry renders the footer "Ha lavorato su: B (v4), C (nessuna modifica)" (980). Merged history shows
    each old entry with its variant chip (982).
- **Live messages (Phase 13).**
  - While the coordinator run is live, a message goes to it (today's `LiveTurn` path, now on the group job).
  - While helpers work, a message whose pins all target working variants is sent live to those helpers.
  - Any other message is queued as the group's next request, in the existing queue UI, at group level (side state
    `queued` on the host). Redirect (`POST /api/jobs/:id/redirect`) works on the group job during the coordinator run.
- **Variants page.**
  - The cards show "al lavoro" from their helper jobs.
  - "Nuova variante" calls `add_variants`, the same core function as the coordinator's tool, with no limit, and it runs
    once.
  - The card grid wraps for many variants.
- **Approvals.** `FormatView` and `EditorScreen` show the approvals of the group (the group job, any helper), not only
  `a.creativeSlug === creative`.

## 9. The paid-services card under one agent

- **When it shows.** When a group turn's plan has 2 or more work items and `confirmPaidProviders` is on, one
  `paid-batch` card is shown after the coordinator run and before the helpers start. That is today's `VariantFanout` rule
  of two or more candidates, moved from fan-out to plan. With a single work item there is no card, and each paid call asks
  as it does for a plain creative.
- **Only usable services (report 31).** `paidPlan` gets the target formats. Voice, music and sound effects are listed
  only if a target format has audio (a video format). Images are listed only if the brief's services allow them. Whether
  an SVG-only identity pack should list Images is left to the user (open question 2).
- **Decline no longer stops the work.** Decline means "without the paid services": the helpers start with a cover that
  refuses those rules (`approvals.cover(id, rules, Promise.resolve(false))`), so their paid calls fail fast with a clear
  tool error and the agent uses free means. Stop on the group turn still cancels everything. An expired card counts as
  Decline.
- **Mechanics.** The card's code moves out of `VariantFanout`, the hold/cover/cancel engine, which is kept and renamed
  `GroupDispatch`. Held helpers wait with `waitReason: 'variant-confirm'`, as today.

## 10. Migration of existing groups (982) and what the agent remembers

- **When it runs.** Lazily, under the host's lock, on the first group read that needs it: open conversation, turn, or
  message. It is idempotent, marked by `variantGroup.chat: 'single'` in the host's `creative.json`; `variantGroupSchema`
  accepts the field as optional.
- **Merge.**
  1. Read every member's `conversation.jsonl`.
  2. Stamp each entry with its member's `variant` (host entries become `a`).
  3. Sort stably by `at`, keeping each file's own order on ties.
  4. Write the host's file through a temp file and a rename.
  5. Rename each sister's file to `conversation.premerge.jsonl`. The host keeps its original as
     `conversation.premerge.jsonl` too.
  6. Commit the creative files: one commit, under `commitCreativeFiles`.
- **Old `jobId`s.** `jobId`s stay as they were, so old entries render as before, each with its chip.
- **Queues.** Each sister's queued requests (side state) move to the host's group queue, in time order, with
  `pins[].variant` set. Each sister's `stoppedSession` and `pendingBrief` stay where they are: they belong to that
  variant's helper.
- **Refused while busy.** Migration waits while any member has a queued or running turn: it runs at the next idle moment,
  and the old UI paths keep working until then. The UI always reads through the store, which serves a not-yet-migrated
  group as the merged view in memory, so the user sees one chat at once.
- **Memory.**
  - Sessions can't be merged. The helpers keep their per-variant sessions, so B's helper still remembers B's work.
  - The coordinator starts with no session. Its first prompt (and any prompt after a lost session) carries a **digest**
    built by the core from the merged conversation. The digest holds:
    - every user message, verbatim, trimmed to 600 characters, with its variant;
    - per old turn, the agent's last text, trimmed to 400, with its variant;
    - the saved versions per variant with their status;
    - directions and picks.
  - The digest is capped at about 30k characters, newest first: older messages are dropped and a count is noted.
  - The same "since your last run" digest, from the coordinator's last entry on, goes into every coordinator prompt.
    That way direct UI actions (section 5) and helpers' work that the coordinator didn't see are never unknown to it.

## 11. Activity center

- One row per group turn: "<titolo> · agente", running from the coordinator run to the report run. Under it, one child
  row per helper ("· B", "· C", queued with `variant-slot` or running). `jobPlace` learns the `group:` key and the
  `parentJobId`.
- One "Needs you" entry for the paid card and for coordinator questions. A helper's question shows its variant.
- Done rows: the versions each helper made come from the `group-turn` entry, so there is no longer one
  `getConversation` per member.
- The `variant-directions` job kind disappears once the coordinator writes the directions (old jobs in history still
  render).

## 12. What breaks, and the tests that cover it

| Area | Changes | Tests |
|---|---|---|
| Variant ids | `VariantLetter` → `VariantId`, regexes, schemas, enums, i18n of the limit | `shared/test/variants.test.ts`; `core/test/variant-group.test.ts`, `variant-routes.test.ts`; `mcp-studio/test/server.test.ts`; `web/test/variants-new-creative.test.tsx`, `variants-list.test.tsx` |
| Conversation routing | Store resolves members to host; `variant` stamp; filtered reads | new `core/test/group-conversation.test.ts`; `creative-turns.test.ts` (queued-entry check, conversion line, `lastTurnSession`) |
| Group turn | New job kind and lane, coordinator run, plan, helpers with `parentJobId`, report run, Stop cascade | new `core/test/group-turn.test.ts` with the fake launcher; `variant-fanout.test.ts` → `group-dispatch.test.ts`; `variant-paid-batch.test.ts` |
| Tools | Coordinator MCP kind, `work_on_variants`, `add_variants`, ask guard, required `variant` in `set_pick` | `agent-actions.test.ts`, `bridge-routes.test.ts`, `mcp-studio/test/server.test.ts`, new `core/test/ask-guard.test.ts` |
| Prompt | Coordinator and report prompts, digest, helper "works for a coordinator" note | `variant-prompt.test.ts`, new `coordinator-prompt.test.ts` |
| Report 33 | No-op helper is unchanged | `creative-turns.test.ts` (Phase 0) |
| Migration | Merge, rename, queues, idempotence, busy group, in-memory merged view | new `core/test/group-migration.test.ts` |
| Web chat | One conversation everywhere, chips, folded helpers, footer, no selector, group-wide pending pins | `conversation.test.tsx`, `composer-live.test.tsx`, `variants-chat-selector.test.tsx` (removed / rewritten), `variants-format-view.test.tsx`, `variants-canvas.test.tsx` |
| Paid card | Plan-based, filtered by format, Decline = without paid | `PaidBatchCard.test.tsx`, `variant-paid-batch.test.ts` |
| Activity | Group row with children | `activity-center.test.tsx` |

Code removed:
- `VariantFanout.run` with a request (the message fan-out);
- `POST …/variants/run` with `request`;
- `VariantDirections` as a separate job;
- `add_variant` (it becomes `add_variants`);
- the composer's fan-out.

## 13. Phased build order (each phase merges on its own)

**Phase 0: prerequisites (small, independent).**
- Report 33: a helper/turn that writes no composition counts as unchanged (`keepsLatest` / carried formats).
- Report 31: `paidPlan` filtered by the target formats.

**Phase 1: no variant limit (978).**
- `VariantId`, the regexes, the schemas, the `mcp-studio` enums, the i18n and the UI `canAdd`.
- Visible on its own: a sixth variant can be added.

**Phase 2: one conversation (980 read side, 982).**
- Store routing and the `variant` stamp, then migration and the in-memory merged view.
- Web: one `Conversation` everywhere, variant chips, `Pin.variant`, group-wide pending pins.
- The fan-out still sends turns at this stage, but they all land in one chat with labels.
- Visible on its own: the merged chat.

**Phase 3: the group turn (977, 979, 981).**
- Job kind and lane, the coordinator run, the tools (`list_variants`, `work_on_variants`, `add_variants`,
  `set_variant_directions`, group app actions), the ask guard, helpers via `start(…, { parent })`, the report run, the
  `group-turn` entry, Stop cascade.
- The Composer posts to the group, and the selector and fan-out are removed.
- The first generation goes through the coordinator, and the directions job is retired.
- This is the largest phase: build it behind a workspace flag `singleAgent` (off by default) until it passes the
  end-to-end test with the fake CLI, then switch the default on.

**Phase 4: the paid card on the plan, and Decline without paid services.**
- Moves the card from fan-out to plan, adds the Decline semantics and the UI copy.

**Phase 5: Activity center and live messages.**
- Group rows with children, and live routing to the coordinator and helpers.

**Phase 6 (optional, after use): one follow-up wave.**
- The report run may dispatch one more round when a helper failed or left problems, with the same card rules.
- Decide only with real usage data.

Phases 1 and 2 can be merged and tried by the user before Phase 3 exists.

## 14. My calls (the builder may revisit them)

1. Option C: a coordinator conversation plus core-run helper turns. No CLI subagents, no multi-variant session.
2. The coordinator dispatches and ends its run. The core resumes it for the report. The report run doesn't dispatch
   (until Phase 6).
3. The group conversation is the host's `conversation.jsonl`, behind store routing. The sisters' files are kept as
   `conversation.premerge.jsonl`.
4. The coordinator's session lives in the host's side state. The helpers keep their per-variant sessions.
5. The ask rule is both a prompt rule and a core guard on `work_on_variants`.
6. UI actions that already name a variant skip the coordinator run.
7. Unlimited bijective base-26 ids (`a…z`, `aa…`). The parallel limit stays at 2 per group.
8. Decline on the paid card means "without paid services", not "stop everything".
9. The coordinator uses the same model setting as other turns. It has read-only file access and no Bash.
10. The coordinator turn runs in its own lane so it never starves its helpers.

## 15. Open questions for the user

1. **Paid card Decline.** Should Decline run the work without the paid services (my call), or stop everything as today?
   - (a) Without paid services, recommended.
   - (b) Stop everything.
2. **Images for SVG-only identity packs.** Should the paid card list Images (OpenAI) for an identity pack whose formats
   are all SVG?
   - (a) No: vector formats never call image generation. Recommended if the user never wants raster images in a logo.
   - (b) Yes: the agent may use an image as a reference.
3. **Seeing the helpers' work.** Should the helpers' detailed work (their tool steps) be visible in the chat?
   - (a) Folded under each variant's row, opened on click. Recommended.
   - (b) Hidden entirely; only the coordinator's messages and the per-variant results show.
