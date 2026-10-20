# Brief with the agent (user request of 2026-10-20)

Status: design, approved by the user in the prototype; not built. Decisions of this design: 1410–1424 in
`docs/decisions-log.md`. Prototype: https://claude.ai/artifact/MMTjKsgYyTnpBHyomm57qn, artboard "A" (`Main.dc.html`) is
the approved one; B and C are rejected alternatives, kept only for reference.

## 1. Why

To write a brief, the user today opens Claude Code in a terminal outside the app. They give it a codebase or some
screenshots, explain roughly what they want, and Claude writes the brief text, which they paste into "Nuova creatività".
They were never blocked by the form; they want users to never have to leave the app for this.

The feature: on "Nuova creatività" the user can open a Claude Code session in the app, link N local codebase folders and
N assets, say what they want, and the agent fills the brief's fields. The user reviews the fields and presses Genera.

## 2. The user's calls

| # | Call |
|---|---|
| 1410 | It lives on "Nuova creatività", next to the form of today, which stays. A segmented control in the top bar: "Compila tu / Con l'agente". |
| 1411 | The screen opens on "Compila tu". The goal box ("Cosa vuoi realizzare?") carries a CTA "✦ Fallo compilare all'agente" that opens the session. |
| 1412 | The session is a chat panel on the left. The form stays on the right and fills as the agent works. Variant A of the prototype. |
| 1413 | The chat's look: a floating "liquid glass" card (variant C's look), inset 12 px from the edges, radius 20, the composer's glass (`conversation.css` `.ms-composer` tokens). |
| 1414 | Every command to add context sits UNDER the text input, as in the Claude app: a "+" inside the composer opens a menu (link a folder, asset from the library, upload from the Mac). Added items show as removable pins in the composer. Under the composer, a row summarises the session's context ("2 cartelle ▾ · 3 asset ▾"). No context block above the chat. |
| 1415 | Codebases: local folders on the Mac only. No remote repos for now. |
| 1416 | Assets serve both as reference for the agent and as material for the video. An upload from the Mac goes into the project library. |
| 1417 | When done, the agent's work is the same form of today, filled in its fields (not text to paste), for the user to review before creating. Nothing is created until the user presses Genera. |
| 1418 | The right side is the real NewCreative form: brief column + format board with tiles (not a list or a select). Assets as 72 px tiles, codebases in "Altre opzioni" with path + note. |
| 1419 | After Genera, the session goes on as the start of the new creative's chat (shared-element transition, §6.3). |
| 1420 | This chat look (1413) becomes the look of EVERY chat in the app: creative canvas, format view, editor, variant group chat. |

Calls marked "orchestrator's call" below were settled without the user; they are listed in §10 for review.

## 3. Goals, non-goals, anti-goals

**Goals**
- A user writes a complete brief without leaving the app, starting from their code and assets.
- The agent fills: goal, key message, video length, assets (from the library and uploads), linked codebases with a note
  on what each is for, notes for the agent, formats (preset ids from the catalog), and the variant count when the user
  asks for variants.
- The user sees each field the agent wrote, can change any of it, and keeps chatting to change it.
- The conversation is not lost when the creative is created.

**Non-goals**
- Remote repositories, GitHub, cloning.
- The agent producing compositions or renders inside the brief session: it only writes the brief.
- Editing an existing creative's brief through this session (the creative's own chat and `update_brief` already do it).
- Store-pack briefs (the store pack keeps its own wizard). Identity / logo creatives: the agent may pick identity
  presets only if the existing identity rules allow it; otherwise out of scope for the first version.

**Anti-goals (failure even if it works)**
- The agent overwrites a field the user edited by hand.
- A creative, a render or a paid provider call starts before the user presses Genera.
- The agent writes into a linked codebase, or reads secrets from it.
- The user loses the conversation or the attached context by leaving the screen or reloading.
- A second, different-looking chat: the session must look and behave like the app's chat (approvals, questions, Stop,
  queued messages).

## 4. Constraints

- Agent jobs go through `AgentLauncher.start` (`packages/core/src/agent/launcher.ts`) and a policy from
  `buildAgentPolicy` (`policy.ts`). App actions are MCP tools in `packages/mcp-studio/src/server.mjs`, served by
  `/api/bridge/<tool>`; today `scopeOf` (`creatives/agent-actions.ts:150`) only allows creative scopes.
- The console (`kind:'console'`) is the only creative-less live job and keeps nothing on disk; it is not a model to copy
  for persistence.
- Linked codebases are read-only for the agent (`readOnlyRules`); brand analysis adds a secrets scan
  (`codebaseSecrets`).
- Chat UI: `<Conversation>` (`packages/web/src/components/Conversation.tsx`) with `conversation.css`; used in
  CreativeCanvas, FormatView, EditorScreen and the variant group chat.
- Motion: only through `packages/web/src/motion` and the tokens `--d-*` / `--e-*`; `prefers-reduced-motion` makes every
  transition instant.
- i18n: every string in `shared/src/i18n/en.ts` and `it.ts`; `check:i18n` must pass.
- No paid providers in tests; no real Claude CLI in tests (fake agent, as the existing turn tests do).

## 5. How it works (the parts the user decided, plus the orchestrator's calls)

### 5.1 The brief session (server)

- A new job kind `brief`: project-level, live (accepts messages mid-turn, Stop, approvals and AskUserQuestion like a
  creative turn). Orchestrator's call: its own kind rather than reusing `console`, because it needs persistence, its own
  tools and its own scope.
- A brief session has an id and lives under the project, e.g. `<project>/.studio/brief-sessions/<id>/` with
  `session.json` (context, draft brief, Claude session id, status) and `conversation.jsonl` using the existing
  `ConversationEntry` schema, so `<Conversation>` renders it unchanged. Exact layout: builder's call. It is protected from
  the agent's writes like the creative core files.
- Orchestrator's call: one open session per project at a time. Opening "Nuova creatività" with an unfinished session
  offers to resume it ("Riprendi la sessione del brief" / "Inizia da capo"); "Inizia da capo" discards it. A session ends
  when its creative is created or the user discards it.
- Context of the session: a list of codebases `{path, note?}` and asset paths (project library paths). It grows as the
  user adds pins and sends; a pin can be removed from the context row.
- Policy for `brief`: read-only. Read/Grep/Glob on the linked codebases (as `addDirs` + `readOnlyRules`) and on the
  attached assets; no Edit/Write anywhere; no Bash. The codebases get the brand-analysis secrets scan
  (`codebaseSecrets`) and its Read denies. No provider tools (images, voice, music).
- MCP tools for `brief` (new scope "brief session", same 30-call cap idea as `scopeOf`):
  - `list_formats`: the catalog's presets the user can pick (id, label, channel, kind, size, max duration), so the agent
    never guesses an id. Identity presets follow existing identity rules.
  - `fill_brief`: a partial patch of the draft: `goal`, `message`, `notes`, `durationSec`, `assets` (library paths in the
    session context), `linkedCodebases` (paths in the session context, with `note`), `formats` (preset ids), `variants`
    (count). Validated with the same schemas as `briefWriteSchema` / the create route. Each call writes a system line in
    the session's conversation (like `noteFromTurn`) and emits an event.
  - AskUserQuestion through the existing permission path (`bridge-routes.ts:87`), for short choices (e.g. the length).
- The prompt for `brief`: what the brief fields mean, the catalog through `list_formats`, the user's current form (sent
  with every user message, §5.2), the rule of §5.3, and: never create anything, never claim the creative exists.

### 5.2 The form and the agent (web)

- The form state stays in NewCreative. Every user message to the session carries the current form values, so the agent
  sees the user's edits. The server keeps the draft (`fill_brief` results + the last form snapshot) so a reload restores
  both the form and the chat.
- A `fill_brief` event updates the form fields it names, except fields the user edited by hand (§5.3).
- Field marks: a field the agent wrote shows a small accent pill "Agente" next to its label, and plays the fill glow
  once (prototype: `msGlow`, 1.6 s). Asset and format tiles enter with the tile spring (`msTile`). The footer summary
  frames update. The pill disappears when the user edits that field.
- "Fallo compilare all'agente" (1411): opens the panel; if the goal box has text, that text becomes the composer's draft
  (not sent automatically).

### 5.3 What the agent never overwrites

- Per field, the form tracks "edited by the user after the agent's last write". The agent's `fill_brief` does not change
  such a field; the tool result tells the agent which fields were kept and why, so it can mention it.
- Same idea as decision 1389 / `agentFormatLabels` for format names. For list fields (assets, codebases, formats): once
  the user adds or removes an item by hand, the whole list counts as the user's. Orchestrator's call.

### 5.4 Context: the "+" menu (1414)

- **Collega una cartella** — desktop: native folder picker (`desktop().pickFolder`); web: a path field like
  `CodebaseList`. Validation as `codebases.ts` (no glob characters, must exist, readable).
- **Asset dalla libreria** — the existing library picker of NewCreative (popover, 4-column grid), multi-select.
- **Carica dal Mac** — `<input type=file multiple>` → `api.uploadFiles(slug, 'assets', files)` → the new assets are
  in the library and pinned. Same limits as today (`upload.ts`).
- Pins: inside the composer above the text, removable with ×, sent with the next message; after sending they join the
  session context and show under the user's message (`ms-msg-pins`). The context row under the composer shows counts with
  a dropdown listing the items, each removable.
- When the session's context changes, the agent learns it with the next message (no hidden turn).

## 6. Look and motion (all from the prototype, artboard A)

### 6.1 Layout
- Top bar: breadcrumb, then on the right the segmented "Compila tu / Con l'agente" (sparkle icon on the agent side).
- Agent mode: the glass panel at left, 448 px wide, inset 12 px, radius 20. Header: agent avatar, "Brief con l'agente",
  a neutral pill with the session state ("Nuova sessione" / "Al lavoro…" / "Brief compilato"). Body: `<Conversation>`.
- The form body sits right of the panel, inset 12 px, radius 16, with a 1 px line; its brief column is 380 px when the
  panel is open and 480 px when closed (the format board takes the rest).
- The footer (summary frames, "Salva bozza", "Genera ⌘↵") is a floating card inset 12 px, radius 16, aligned with the
  panel's bottom, not a full-width bar (user: the full-width bar met the panel badly).
- The composer in the glass panel has no second glass frame around it (user: it looked cramped): one field with the pins,
  the text, and a bottom row with "+" (left) and Send (right); generous padding (12/10/10/14, gap 10); the context row 10
  px below.

### 6.2 Opening and closing the panel
- To "Con l'agente": the space opens first (form `left` and brief column width, 480 ms `--e-out`), then the panel
  slides in from −32 px, scale .98 → 1 and fades in, delayed by 0.6 × `--d-s`.
- To "Compila tu": the panel leaves first (`--e-in`), then the space closes after 0.6 × `--d-s`.
- Reduced motion: instant.

### 6.3 Genera → the creative canvas (1419)
- Shared-element transition, like T3/T4 (`PageHost` `modeOf` → `'shared'`): the form recedes (scale .98, fade, 320 ms
  `--e-in`); at the same time the chat panel moves from its left slot to the canvas's right side panel slot (left, width,
  480 ms `--e-out`), keeping its glass look (1413/1420). The canvas fades in after 0.6 × `--d-s`; its boards enter one
  after the other (16 px rise, scale .97, 70 ms apart) with the loading shimmer and the indeterminate bar.
- In the canvas panel the tabs Chat / Commenti / Brief fade in at the top; the conversation shows the whole brief
  session, then a version entry "Creatività creata · v1" and the first turn's steps.
- From "Compila tu" (no panel open), Genera uses today's page transition and the canvas panel appears in place.

### 6.4 The chat everywhere (1420)
- CreativeCanvas, FormatView, EditorScreen and the variant group chat get the same floating glass panel: inset 12 px,
  radius 20, glass background, agent bubbles on `--glassField`, the composer without its own outer glass frame, tabs
  inside the panel. Dark and light themes both.
- Orchestrator's call: the panel keeps reserving its column (today's widths), so fit, zoom, the editor's timeline and the
  existing layout tests keep their geometry. The page background shows in the 12 px margins around the card; content
  does not run underneath it. The brief screen is the exception only in that its form body is a card too (§6.1).
- Orchestrator's call: this restyle ships as its own phase, after the brief feature, on its own branch; the brief
  feature's panel already uses the new look.

## 7. From the session to the creative

- Genera calls the existing create route with the form's brief (and `linkedCodebases`), plus the brief session id.
- The route copies the session's `conversation.jsonl` entries into the new creative's conversation before the first
  turn (each entry keeps its time; a system line marks where the creative starts), and marks the session ended.
- Orchestrator's call, builder to confirm feasibility: the first creative turn resumes the brief session's Claude
  session as a fork (`resumeFrom` / `forkSession` hooks, `creative-turns.ts:1088-1134`) so the agent remembers the
  conversation. If forking across job kinds is not reliable, the first turn instead gets a short summary of the session
  in its prompt; the displayed chat is continuous either way.
- Assets uploaded in the session are already in the library (committed by the upload route).
- **Variants (orchestrator's call, from decision 977: one agent and one chat per creative).** When the brief asks for N
  variants, the brief session's conversation is copied once, into the group's one chat (the host creative's, where the
  variant group chat reads it). Only the agent the user talks to, the group coordinator, resumes the brief session as a
  fork; the per-variant helpers get the brief as today. The §6.3 transition lands on the group's canvas, with the panel
  in the group chat's slot. Identity groups made by the core follow the same rule.
- **"Salva bozza" (orchestrator's call).** It moves the session into the draft creative exactly as Genera does (the
  conversation is copied, the session ends), without starting a turn. The Claude session id is stored on the creative as
  `resumeFrom` so the first Generate later resumes it as a fork; if that session can no longer be resumed (aged out or
  missing), the first turn gets the summary fallback. The handoff is therefore part of "create", not of "first generate".
  Today's page transition applies (back to the project page), with the existing "Bozza salvata" toast.

## 8. Errors and edge cases

- Agent turn fails or is stopped: the form keeps what was filled; the chat shows the error as today.
- A codebase folder disappears: the prompt lists it as unavailable (as `prompt.ts:194-197` does).
- `fill_brief` with an unknown preset id or an asset outside the context: rejected with a clear error to the agent.
- Leaving the screen mid-turn: the turn finishes in the background (like other jobs); returning resumes the session.
- Two windows on the same project: one session per project; the second sees the same session.

## 9. Left to the builder

- Storage layout and file names of brief sessions; event types for session updates.
- Whether `fill_brief` is one tool or several.
- How the form tracks user-edited fields.
- The exact component split (a `BriefSession` panel component, reuse of `<Conversation>` props).
- Test strategy: fake agent for the job, unit tests for `fill_brief` validation and the no-overwrite rule, a real-Chrome
  layout check of the panel and the transitions (as the existing layout tests do), i18n.

## 10. Orchestrator's calls for the user to check

1. Its own job kind `brief`, read-only, with the secrets scan of brand analysis on the codebases.
2. One open session per project; reopening "Nuova creatività" offers to resume or start over.
3. For list fields, one manual change makes the whole list the user's.
4. The "Fallo compilare all'agente" CTA moves the goal text into the composer as a draft, not sent.
5. The first creative turn tries to resume the brief session's agent memory; fallback: a summary in its prompt.
6. Store packs are out of scope for the first version.
7. With N variants the session goes into the group's one chat and only the coordinator resumes it.
8. "Salva bozza" moves the session into the draft creative; the first Generate later resumes it.
9. The chat restyle of the other screens keeps their column widths (no content under the panel) and ships as its own
   phase after the brief feature.
