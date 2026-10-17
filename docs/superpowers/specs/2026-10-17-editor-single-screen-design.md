# Editor single screen (user test 2026-10-17, items 7–10; decision 916)

## Problem

Opening a format showed the *format view* (scenes list, player, plain scrubber, chat). The user took it for the editor and
never found the timeline, which sat behind the small "Edit" button (`#/…/f/<format>/edit`). Decision 916: one screen.

## Shape

- **One route.** `#/p/<p>/c/<c>/f/<format>` renders `EditorScreen`. The old `…/edit` address is redirected in place to the
  format address (`redirectOf`), and the `edit` route kind is gone: no path leads to a separate editor or format view.
  The "Edit" button disappears.
- **The editor is the format page.** Whenever the format has an editable composition, the page is the editor: scenes or
  layers on the left, the stage in the centre, the timeline under a video, and a right column with the tabs
  **Chat | Inspector**.
- **Viewer fallback, only without a composition.** A format whose version on screen has no composition (a legacy
  rendered version, no version yet / the first generation running, a format outside the creative) shows the old viewer
  component (`FormatView`) inside the same route, with its version choice controlled by the editor screen: picking a
  version with a composition in its menu turns the page into the editor. Its "Edit" button is removed.
- **Read-only, same screen.** The editor opens with editing disabled and the reason on top of the stage and of the
  inspector:
  - an older version on screen (from the version menu, a chat card's "View vN", the canvas' viewed version, or a manual ★
    on an older version): "Edit the latest (vN)" goes back to the editable one;
  - a discarded variant (phase 15);
  - an agent turn or a render at work on the creative.
  Edits are refused at the source (the context's draft actions refuse, the inspector is a disabled fieldset, gestures
  only select). An older version opens in its own throw-away draft: the editable draft (with its unsaved edits) is never
  replaced and is found again when coming back.
- **Draft safety unchanged.** Leaving the route with unsaved edits asks Save / Discard / Keep editing; a chat message
  asks first; a reload asks. Switching to an older version keeps the draft (it is a view, not a leave).

## Layout

Right column: tabs **Chat | Inspector** (288 px below 1200 px, 320 px from 1200 px). Chat is the default tab (the format
view always showed the chat); selecting a clip (timeline, scenes column, layers, stage) switches to Inspector; a comment
(clip, range, spot of the frame) or "Ask the agent" about an animation switches to Chat. Checked in Chrome at 1024 and
1280 px.

## Inventory

| Feature | Where it lived | Where it goes |
| --- | --- | --- |
| "← All formats" with T4 (board grows back) | format view bar | editor bar (replaces "Back to preview"); T3 on the way in flips the stage frame |
| Crumb with channel mark, meta (size · s · fps), "brief N s" note, unverified pill | format view bar | editor bar |
| ★ badge with the format's versions (view, ★, compare), "viewing vN" | format view bar | editor bar; viewing an older version is read-only |
| Follower chip (follows X, Unlink) | format view bar | editor bar; the editor edits the primary and says so |
| Versions timeline (restart from, show in Finder), "vN is ready" notice | format view bar | editor bar |
| Render video / render status / render problems | format view bar (`RenderStatus`) | editor bar |
| Languages button | both | editor bar (read-only for a discarded variant) |
| Duplicate format | format view bar | editor bar |
| Export | both | editor bar |
| Compare dialog | format view (badge) | editor (badge) |
| Live preview (sandboxed player), busy / failed / retry | both | editor stage |
| Legacy rendered video / image of an old version | format view | viewer fallback |
| Identity: image / sizes view, Use as brand logo, light / dark sides, "no dark logo" | format view | editor notes (identity bar) and stage (sizes view, light/dark preview) |
| Safe zones toggle | format view | editor stage |
| Image zoom | both | editor (ZoomBar) |
| Locale switcher (translation preview) | both | editor stage |
| Storyboard / scenes with thumbnails, click seeks | format view left column | editor scenes column and the timeline's scenes lane |
| Transport: play, frame step, loop, speed, markers, keys | format view transport | editor timeline bar |
| Frame comment ("Click the spot of the frame") | click on the paused frame | **Comment a spot** toggle in the stage toolbar (`P`): a click on the frame places the pin, the note is asked in the comment dialog |
| Comment markers on the picture (±0.5 s) | format view stage | editor stage (above the handles) |
| Clip comment (picker / `C`) | format view transport | editor: selected clip + **Comment clip** / `C` |
| Range comment (Shift + drag / `R` / button) | format view transport | editor timeline (unchanged) |
| Comments only on the pin source, lock hint "Comments go on vN" | format view | editor |
| Chat panel (conversation, chips, applies to, queued, brief services, version cards) | format view right column | editor Chat tab; "View vN" opens that version read-only |
| Notes: integrity, formats load failure, resume note, creative error, action error, agent step with progress | format view | editor notes |
| Discarded variant read-only | format view (Edit / Duplicate disabled) | editor read-only with reason |
| Running agent turn or render | format view (Edit hidden) | editor read-only with reason, Save blocked |
| Formats that follow another format | both | editor (edits the primary, follower chip in bar) |
| Still images | both | editor image mode (layers, zoom) |
| Unknown format | format view | viewer fallback |

## Other items of the same test

- **Item 8, selecting a clip seeks.** A plain click on a clip bar (no drag, no trim) moves the playhead to the clicked
  point (frame-snapped, inside the clip's span), else the clip start. Selecting a clip in the scenes column's "In this
  scene" list seeks to its start when the playhead is outside it. Play/pause state is kept.
- **Item 9, draggable playhead.** The playhead has a grab handle on the ruler and a grab strip on its line: both drag
  with pointer capture, frame-snapped. A click on the ruler jumps there (already true, now frame-snapped). Shift + drag on
  the ruler stays "comment a range"; the keyboard keeps working.
- **Item 10, ask the agent about a custom animation.** The inspector's "Custom animation" row gets **Ask the agent**: it
  adds a clip comment chip (clip id and name, at the animation's time) whose note says it is about the clip's in/out
  animation, switches to Chat and focuses the composer.
