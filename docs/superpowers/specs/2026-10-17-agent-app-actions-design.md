# Agent app actions (decision 917, user note 6)

## Why

The user pasted a brief saying "60-second" while the New creative form kept its default duration of 6 s. The agent built
60 s, the output check (`composition-contract.ts`, `durationOffBrief`) refused it, the three automatic fix attempts were
spent (the agent cannot change the brief), the version was saved `incomplete`, and the agent told the user to change the
duration and "validate again" — a button that does not exist.

Decision 917 (the user's call): the agent gets tools to act on the app as the user would, **always without a confirmation
card**: edit its creative's brief, add / discard / restore variants and mark the ★, add and duplicate formats, create a
language variant, render a version, prepare an export. Never: archive, delete, anything outside the agent's own creative,
variant group and project, settings, keys, permissions. The paid provider confirmations stay exactly as they are.

## What changes

1. Ten new `studio` MCP tools for **creative turns only** (`MCP_TOOLS.creative`), each one a thin call into the SAME core
   function the UI's route calls (same validation, same locks, same 409s, same side effects).
2. Every action writes one readable system line in the creative's chat (it/en), marked `origin: 'agent'`, and the clients
   are told (`creative` event), so the UI updates live.
3. Duration problems end without loops: the fix prompt says the agent may update the brief's duration (or ask with
   AskUserQuestion), the turn's own checks use the new duration at once, a brief edit re-checks the latest incomplete
   version without a new turn, an incomplete version explains itself in the chat, and the New creative form warns when the
   brief text states another duration.

## The tools

All inputs are JSON objects with `additionalProperties: false` in the MCP schema; the core parses them again with zod
(strict) and never trusts the MCP server's schema. No tool takes a path, a project, a creative slug or a job id: the scope
comes from the bridge token (below).

| Tool | Input | What it calls | During the agent's own turn |
|---|---|---|---|
| `update_brief` | `durationSec?` (int 1..600 or null), `goal?` (1..2000), `message?` (≤ 500), `notes?` (≤ 10 000), `services?` (`images`/`voice`/`music`/`sfx`, the brief's choices) — at least one | single creative: `CreativeTurnService.briefChange` + the pending brief; group: `VariantGroupService.updateGroupBrief` | kept as the creative's pending brief, applied when the turn ends; `durationSec` applies at once to this turn's output checks (see "Duration") |
| `add_format` | `format` (a catalog preset id, not already in the brief, not an identity preset), `label?` (1..60) | the same brief save as the brief editor (`briefChange` with the new format) | brief change as above; after the turn, ONE follow-up turn with no message makes the new formats ("Save and regenerate"), see "Paid turns" |
| `duplicate_format` | `format` (an instance id of the brief), `label?` | `DirectEditService.duplicate` | after the turn, on the version the turn saved (the duplicate is an editor version and refuses while a turn runs) |
| `add_language` | `locale` (BCP-47 tag of the curated list), `primary?` (required when the brief has no languages yet), `formats?` | brief change (`locales.extra`) + `LocalizeService.start` | brief change as above; the translation starts after the turn on the version it saved |
| `add_variant` | `direction` (3..140 characters, one line) | `VariantGroupService.addVariants` + `VariantFanout.run([letter], null)` — exactly the canvas's "+ Variante" (a creative outside a group becomes A of a group of two) | immediate (another creative's job) |
| `discard_variant` / `restore_variant` | `variant` (`a`..`e`) | `VariantGroupService.discard` / `restore` | immediate; discarding the agent's own working variant is refused by `discard` itself (409 `variant-running`) |
| `set_pick` | `format`, `version` (int or `"current"`), `variant?` (`a`..`e`, groups only) | group: `VariantGroupService.setPick`; single: `CreativeTurnService.setExportPick` | a saved version: immediate; `"current"` (the version this turn makes): after the turn |
| `render_version` | `version` (int or `"current"`), `formats?` | `RenderJobService.start` under the creative lock, after `assertNotDiscarded` (the render route's body) | a saved version: immediate (renders have their own lane and never touch the version being written); `"current"`: after the turn |
| `prepare_export` | none | single: the `…/export/prepare` route's body, moved to `prepareExportRenders` and called with the current ★ of every format; group: `planGroupExport` + `pendingByMember` + `renders.ensureJob` | after the turn (the ★ may be the version it saves). It only renders what the ★ export needs: **the export itself (a destination outside the project) stays the user's** |

Never a tool: archive, delete, remove a format, restore an earlier version, links, title, codebases, store pack, identity
options, project or workspace settings, keys, permissions, the queue, Stop.

## Scope (security)

- `BridgeContext.appScope` (`root`, `projectSlug`, `projectDir`, `creativeSlug`, `version`) is set by the creative turn
  when it launches the agent and frozen with the context. A handler acts only on that creative, its variant group (resolved
  from the host's stored group: letters are mapped to member slugs by the core) and the project's format catalog.
- The bridge route already refuses a tool not in `MCP_TOOLS[kind]`; each app-action handler also refuses (403) a context
  without `appScope` or of another kind (brand analysis, describe, console, localize, directions never get them).
- No input is a path; strings are bounded; format ids must be catalog presets or instance ids of the brief; locales go
  through `checkedLocale`; versions must exist. Nothing writes a file the existing functions would not write.
- A malicious brief can make the agent call these tools (accepted by the user for the listed actions). The bounds below
  keep it from spending without end.

## Paid turns and limits

- At most **30 app-action calls per turn** (429 `actions-limit` after): the chat and git history cannot be flooded.
- `add_variant`: at most `MAX_VARIANTS - 1` (4) per turn, and the group's own cap (5 members, discarded ones included, never
  freed) bounds every variant turn the tools can ever start in one group to 4.
- `add_format`: at most one follow-up turn per turn, only when the turn saved a version and was neither stopped nor failed,
  only when the creative's queue is empty (a queued request's turn makes every primary anyway), and never from a turn that
  is itself a follow-up (depth 1): there the chat says the new format is made at the next turn.
- `add_language`: one translation job per turn (the languages asked are merged into it). A translation turn has no app
  actions.
- Provider costs (images, voice, music, sound effects) keep their confirmation cards in every turn these tools start.

## Concurrency rules

The agent only ever calls these tools while its own turn runs. Per action:

- **Brief edits** (`update_brief`, `add_format`, the brief part of `add_language`): a single creative's brief never changes
  under a running turn (`updateBrief` answers 409 to the UI). The tool computes the change with `briefChange` on the brief
  as it will be (the pending one, else the stored one) and keeps it as the creative's **pending brief**
  (`CreativeSideStateStore`, the phase 15 mechanism), which `briefAfterJob` applies when the turn ends, whatever the
  outcome (as a group's pending brief). In a group the change is the group's: `updateGroupBrief` applies it to the idle
  variants now and keeps it pending for working ones (the agent's own included).
- **Duration**: besides the pending brief, `update_brief` with `durationSec` sets the running turn's check duration, so the
  next `validate_composition` and the final check use it (see below). Nothing else of the running turn changes: its
  services stay those read at its start (the provider tools keep enforcing them), its formats stay its plan's.
- **Deferred actions** (`duplicate_format`, `render_version "current"`, `set_pick "current"`, `prepare_export`, the
  follow-up turn, the translation): kept in memory per job, in call order, and run when the turn settles, after the pending
  brief and before the queue's auto-run, in this order: duplicates, ★, renders, export renders, follow-up turn, translation.
  A translation after a follow-up turn waits for that turn (it moves to that job's list). If the turn saved no version, was
  stopped or failed, the deferred actions are dropped and the chat says which. In memory only, like the queue's auto-start
  (Ruling T): nothing on disk can make them run, and a quit forgets them (the pending brief is persisted and recovered).
- **Variant actions** act on other members' state under the host's lock and need nothing from the running turn; their own
  409s (`variants-full`, `variant-running`, `variant-last-active`, `variant-discarded`) reach the agent as the tool's error.

## Duration

- **Fix prompt.** When the problems of an attempt include `durationOffBrief`, the fix prompt adds: if the brief text or the
  user's words clearly ask for the composition's duration, do not shorten it: call `update_brief` with that `durationSec`;
  if it is unclear, ask with AskUserQuestion; otherwise bring the duration back to the brief.
- **First and iteration prompts** list the app actions (when the `studio` server is active) with when to use them ("the user
  asks for a new variant: use add_variant, never tell them to click"), and when the brief's text states a duration other
  than its field (`statedDurationSec`), a line says so and asks the agent to settle it first.
- **The turn's checks.** `CreativeTurnService` keeps a per-job check duration set by `update_brief`; `checkCompositions`
  (the tool and the loop) and `finishCompositions` use it instead of the brief's. A turn whose agent updated the duration
  saves a complete version.
- **Re-check without a new turn.** When a brief save changes `durationSec` (the UI's edit, a group propagation, a pending
  brief applied at the end of a turn), the core re-checks the creative's **latest** version if it is `incomplete`: each
  primary composition with problems is checked again with `checkComposition` against the new duration, on its folder as it
  is (its hash must still be the recorded one, else it is left as it is). Formats that now pass lose their problems (their
  followers too); the version-level problems that only those formats explained go; with none left the version becomes
  `complete` and the creative `ready`. `versions.json` and `creative.json` are committed by path; a chat line says what
  changed. The manifest in `outputs/vN` keeps the turn's original record.
- **Incomplete explains itself.** When a turn saves an incomplete version, a warning line says in plain words what is wrong
  and what to do: for a duration problem "the video lasts 60 s, the brief says 6 s: change the duration in the brief (the
  version is checked again at once, no new turn) or ask the agent to shorten it"; otherwise the count and "ask the agent to
  fix them, or edit in the editor".
- **New creative warning.** `statedDurationSec(text)` (shared, pure; en + it: "60-second", "60 s", "60 sec", "1 minute",
  "1 min 30 s", "30 secondi", "un minuto", "mezzo minuto"…; null when none or when the text states different durations)
  reads goal, message and notes. With video formats chosen and a stated duration other than the field's, the form shows
  "Il testo dice 60 s, la durata è 6 s" with "Usa 60 s" (it picks the preset or the custom field).

## Chat lines

System entries `{ type: 'system', level: 'info', origin: 'agent', text }`, written through the running turn's ordered
writer (so they keep their place among the agent's events), translated when written (as every system line). Examples:
"Durata del brief: 6 s → 60 s", "Formato aggiunto al brief: YouTube 16:9 · si crea dopo questo turno", "Nuova variante C:
<direction>", "Variante B scartata", "★ di YouTube 16:9: v3", "Render avviato: v2 · YouTube 16:9", "Dopo questo turno:
duplica YouTube 16:9". The web shows them as system lines with an agent mark ("Azione dell'agente").

## Not in scope

The brief editor's own duration warning (only the New creative form), removing formats, the export to a destination,
console turns (no creative).
