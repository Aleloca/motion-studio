# User test of 2026-10-17: reports to work on

The user is testing the app by generating the project's 60 s launch video (brief agreed in chat). Each report is kept here as it
arrives and worked on later together.

## Found before the test

1. **The app does not start with an Intel-only ffmpeg on a Mac without Rosetta.** macOS 27 has no Rosetta; the old Intel
   Homebrew's `/usr/local/bin/ffmpeg` (x86_64) made startup fail with a modal "spawn Unknown system error -86" (EBADARCH).
   The code assumes Rosetta exists (`render/encode.ts` `FfmpegInfo.translated`: "it works, slower"). Expected: the system check
   reports "FFmpeg non utilizzabile" (wrong architecture) and the app still starts. The user's machine is fixed (ARM ffmpeg
   in `/opt/homebrew`); the app bug is still open.

## Reports

1. **Double plus in "+ Variant".** In the editor's overflow menu ("…" next to Render and Export) the item shows a `+` icon and
   the label "+ Variant" (`addVariant` in `packages/shared/src/i18n/{it,en}.ts`, also used as a bare button label on the variant
   canvas). The menu item needs a label without the "+", or no icon.
2. **No way to delete a creative.** Confirmed: there is no delete route or UI for a creative (nor for a variant group). It was
   already an open follow-up ("group/creative delete"). Needs design: what happens to its versions, renders, running jobs,
   variant sisters, and whether it goes to the macOS Trash (recoverable) or is archived.
3. **Header logo: the user doesn't like it.** The global bar (`shell/TopBars.tsx:137`, `BrandLogo height={22}`) shows the
   mark with "Motion" and "Studio" stacked. Wanted: the wordmark "Motion Studio" on one line next to the mark, as a new
   horizontal SVG (light and dark) built from `packages/web/src/assets/logo.svg` / `logo-dark.svg` by moving the "Studio"
   paths onto the first line. Check the README `<picture>` and the site too.
4. **The old logo is still in the other bars.** The project bar and the screens inside a project/creative still use the old
   glyph (`shell/TopBars.tsx:22`, `.ms-logo`; `initials('Motion Studio')` at :109 to check). Every bar should use the new
   (horizontal) logo, or the mark alone where space is tight.
5. **Brand page, Typography header: the add buttons look bad.** "+ Add from Google Fonts" floats in the middle of the row and
   "+ Add manually" sits at the far right (the header spreads its three children). Group the two actions together at the right
   (or as real secondary buttons), consistent with the other Brand sections' headers.
6. **Brief text says 60 s, the form's duration field said 6 s: every variant ends "Incomplete".** The New creative form kept
   its default `durationSec: 6` while the pasted brief asked for 60 s. The agent rightly built 60 s, the output check
   (`composition-contract.ts:85`, `durationOffBrief`) refused it, three fix attempts were spent (the agent can't change the
   brief), and the version was saved as `incomplete` with no outputs (variant b: about 3.50 USD). Ideas: read a duration
   stated in the brief text and prefill or warn at creation ("the text says 60 s, the field says 6 s"); let the agent flag a
   brief contradiction instead of looping three times; explain "Incomplete" and the problem in plain words in the chat, with
   the fix ("change the duration in the brief"); offer a re-check after the brief is edited, without a new paid turn.
7. **The user has never seen the editor's timeline.** The editor opens, but no timeline to edit clip times. Variant b's v1
   composition is a proper video (60 s, 9 scenes, 7 tracks), and `EditorScreen.tsx:693` renders the Timeline whenever the
   draft's duration is > 0, so it is either pushed out of the window by the layout or the editor opens in another state
   (incomplete version?). Waiting for a screenshot.
   **Screenshot:** the user was in the *format view* (scenes on the left, player, plain scrubber, chat), not in the editor:
   the editor is behind the small "Edit" button in the top bar. The format view looks enough like an editor (scene list,
   stage, a time ruler) that the user took it for one. Ideas: make "Edit" a primary, clearly labelled action ("Apri
   l'editor"), maybe on the stage too or by double-clicking a scene or the ruler; a hint in the format view ("To change
   times and texts without the agent: Edit"). Also seen in the screenshot: every scene thumbnail is a black box (dark
   first frames?), and the agent's message says "validate again", but there is no such button (see 6).
   **User's call:** "non si capisce per nulla". Don't hide the editor behind "Edit": opening a format should show the
   editor directly (merge the format view into the editor, keeping chat, versions, render and export there).
8. **Editor timeline: selecting a clip should move the playhead to it.** Clicking anything on the timeline should seek the
   video to that clip (its start, or the clicked point inside it) so the user sees what was selected.
9. **Editor: the playhead can't be dragged.** In the bottom bar the user can't grab the time line (playhead) on the ruler and
   drag it to scrub through the video.
10. **Inspector "Custom animation · ask the agent to change it": add a button** that puts a reference to that clip's animation
    into the chat composer (like the clip comment chip), so the user can talk to the agent about exactly that animation.
11. **Colour fields: add a generic colour picker.** The brand and composition swatches are good, but every colour field also
    needs a free picker (any colour, plus hex input).

## Reports of 2026-10-18 (editor, an SVG image layer)

12. **An SVG layer's elements belong in the Layers panel, nested under the layer.** Today the Inspector of a vector-image
    layer lists "Texts" and "Elements" (Path 1…7, each with an eye). Wanted: the elements appear in the Layers list as
    children of the layer (expandable), like a design tool's layer tree. Clicking the layer shows the layer's inspector;
    clicking an element shows an inspector with only that element's settings (fill, stroke, visibility).
13. **"Path 7" is the word "MotionStudio", but its text can't be changed.** The SVG's lettering is outlined (paths, not
    `<text>`), so the inspector says "No texts" and offers only colours. Not a bug of the reader, but the user expects to
    edit the word. Ideas: say it plainly ("this text is drawn as shapes: to change the words, ask the agent or replace it with
    a text layer"), a one-click "Replace with text" that swaps the element for a real text layer in the brand font, or a
    shortcut "Ask the agent to change this text" (as in report 10).
14. **The element's colour fields are two unlabelled pickers.** Selecting Path 7 shows two identical blocks (swatch, hex,
    Brand palette): the first is the fill, the second the stroke (`svgFill` / `svgStroke` are not visible labels), and the
    stroke one is empty (`#rrggbb`). Needs visible "Fill" / "Stroke" labels, a compact layout (one palette, not two), and a
    clear "no stroke" state.
15. **The stage toolbar's buttons are unclear on an image.** Undo, Redo, "Comment a point" (pin), "Comment on clip", Snap
    (magnet): icons with tooltips only, and Snap duplicates the timeline's magnet. On an image layer the user can't tell what
    they do. Ideas: labels or richer tooltips, drop the duplicate Snap, hide what does not apply.
16. **Switching between the Editor (chat) and the Inspector on an image is not obvious.** The right panel's Chat | Inspector
    tabs are easy to miss; selecting a layer could open the Inspector by itself, and the tabs need to look like tabs.
17. **The editor's top bar is cluttered, with no visual hierarchy.** Right side, in a row: the pick badge "★ v1 ⌄", "Versions 2
    ⌄", the "Live preview" pill, "Render", "Duplicate format", the black "Export", then the bell, "0 tokens" and the avatar.
    The user: the controls look added one at a time, with no shared UX logic and no clear hierarchy. Ideas: one version control
    (merge the pick badge and the Versions menu: "v1 ★ · 2 versions ⌄"); "Live preview" as status text, not a pill that looks
    like a button; one primary action (Export) and one secondary (Render); "Duplicate format" (and other rare actions) into
    the "…" menu; consistent sizes and spacing; separate the creative's actions from the app's (bell, tokens, avatar).
18. **"Ask the agent" on an animation should work like the notes.** Today (`EditorScreen.tsx` `askAnimation`) it adds a clip
    pin with a fixed note ("about the In animation") and jumps to the Chat tab, so the user's words go in the composer, not in
    the comment. Wanted: the same flow as a clip or spot comment: the note popover opens (`startComment`), the user writes what
    to change, and the comment is stored bound to that clip and that animation slot (in/out); the user stays in the editor,
    comments pile up in the chat's pending list and are sent to the agent together.
19. **(with 17) While a render runs the top bar breaks.** The "Render" button turns into a "Rendering 26%" pill, and a short
    orange progress line sticks out of it and runs into "Duplicate format". The redesign of 17 must include the rendering
    state: progress inside the Render control (same size), no stray line, no layout shift.
20. **The Export dialog can't be closed while it renders.** "Export the starred versions" with a format not rendered yet:
    "Rendering 1 format first…", and the ×, Cancel and the checkboxes are disabled (`ExportDialog.tsx`: `dismissible={!busy}`,
    close `disabled={running}`). The render is a server job and would go on, but the copy to the folder is driven by the open
    dialog, so closing would lose the export. Wanted: close the dialog and keep working; the export finishes on its own
    (server-side: render, then copy) and tells the user when the files are in the folder (bell/toast), with a way to cancel it
    from the job list. Also: "Cancel" while rendering should stop the export, not only be disabled.
21. **"Show in Finder" opens the folder's parent.** After an export to `~/Desktop`, the button (`ExportDialog.tsx:367`,
    `bridge.revealPath(phase.destination)`) reveals the destination folder itself, so Finder shows its parent with the folder
    selected (here iCloud Drive with "Scrivania" highlighted) and the user has to open it by hand. Wanted: Finder opens inside
    the folder, with the exported file(s) selected: reveal the exported file (one file), or open the folder (several files).
    Check the other "Show in Finder" buttons (renders, project folder) for the same mistake.
22. **The export doesn't look Full HD; wanted: a quality choice (480p, 720p, 1080p…).** Measured on the user's export
    (`~/Desktop/create-a-60-second-…-v1.mp4`, ffprobe, read-only): 1920×1080, 30 fps, H.264 High, yuv420p, video about
    4.1 Mbps (AAC 136 kbps), 31.8 MB for 60 s. So the size is right; the softness comes from the encoding:
    the target is 5000 kbps for 1080p landscape (`shared/formats.ts` `BITRATE_REFS`), on Apple Silicon likely
    `h264_videotoolbox` (bitrate mode, no CRF, weaker than x264 at the same rate), from JPEG frames at quality 90
    (`renderer.ts:250`), with 4:2:0 chroma (sharp coloured text edges suffer most). YouTube recommends about 8 Mbps for
    1080p30 SDR. Ideas: a quality setting in Export (and Render): resolution (480/720/1080/1440/2160, scaled from the
    format's size, same ratio) and quality (Standard / High / Max: bitrate or x264 CRF, PNG frames for Max); raise the
    1080p default; confirm which encoder ran (the render's `encoder` field) before choosing the fix.
23. **The editor's top bar, left side: too long, and the breadcrumb is not clickable.** In a row: "‹ All formats", "Motion
    Studio / 2026-10-17-create-a-60-second-16-… / [YouTube] Video 16:9" and the meta "1920×1080 · 60 s · 30 fps · brief 6 s".
    With long names it grows and pushes the right side (see 17). Wanted: each breadcrumb part is a link back to that page
    (project, creative), so "‹ All formats" may become redundant. Also seen: the creative crumb shows the folder slug
    (date + truncated brief), not a readable title; the meta line could move under the title or into a tooltip; "brief 6 s"
    next to "60 s" is report 6 again (the brief of that creative is still 6 s) and should read as a warning, not plain meta.
24. **Composer: the Services button and the send button don't explain themselves.** Bottom left, the "Services" control
    (`components/Conversation.tsx`, the brief's paid services: image, voice, music) is a bare plug icon: without hover or a
    click the user can't tell what it is about. Wanted: a label ("Services", or the active ones, e.g. "OpenAI · ElevenLabs")
    or a clearer icon with text. The send button is a bare upload arrow (`Icon name="upload"`), and sending takes Cmd+Enter
    (Enter makes a new line): show the shortcut on the button itself ("Send ⌘↵", or the ⌘↵ glyph in the icon), and say it in
    the placeholder too; use a send icon rather than "upload".
25. **Composer as floating "liquid glass", with the chat scrolling under it.** Wanted: the text input floats over the bottom
    of the conversation with the translucent, blurred glass look of recent macOS/iOS (backdrop blur + saturation, a soft
    light edge and shadow, rounded), and the message list scrolls underneath it (the list gets bottom padding equal to the
    composer's height, so the last message can still be scrolled above it). Check: light and dark themes, readable text over
    busy content (a tint behind the blur), `prefers-reduced-transparency` falling back to an opaque panel, and the Electron
    window (on macOS a native vibrancy is possible, but CSS `backdrop-filter` keeps web and desktop the same).
26. **The variants canvas: the user dislikes both layouts.** By variant: each variant is a full-width text strip ("A · Minimal
    Apple-style keynote: …", "Ready", "…") with its format block underneath ("Video 16:9 ☆ v1", "16:9 Not rendered", a
    thumbnail), stacked A, B, C down a long page. By format: the three strips stacked on top (of unequal widths: A's is
    narrower), then "YouTube · Video 16:9" with three cards side by side. Seen in the screenshots: the variant's identity is a
    long sentence, not a short name; the strip and its formats read as separate things; the version control differs
    between cards (A: orange "v1 ⌄" badge; B, C: "› v1"); "Ready" next to "Not rendered" is confusing; every thumbnail shows
    the same first frame ("Describe a video."), so the variants look alike, and C's is cropped ("Describe a"); A's title
    shows an orange focus box. Needs a redesign (mockups first): one card per variant with a short name, the style sentence
    as a secondary line, a representative thumbnail (a middle frame, or hover to play), one status, the formats inside it.
27. **The variants canvas's floating toolbar: "what is it for?"** Bottom bar (`CreativeCanvas.tsx:913–925`): Select (V),
    Comment (C), Hand (H), zoom − 75% +, "Safe zones". The user can't see when they would use it. A Figma-like canvas toolbar
    on a page that is really a list of cards: Select is the default and the only one most people need; Hand duplicates
    scrolling (and space/middle-drag); Comment pins a note on a card, a feature nobody finds from an unlabelled icon; zoom on
    a card grid is rarely wanted; Safe zones belongs to a format preview, not the overview. Decide together with 26: likely
    drop the toolbar, keep zoom as a small size control (or Cmd +/−), move "comment" into the card's own actions, and Safe
    zones into the editor only.
    **User's call on zoom:** zoom with the trackpad gestures. Today the canvas has no wheel/pinch handling at all
    (`CreativeCanvas.tsx`: no `wheel` listener). Pinch on a Mac trackpad arrives as `wheel` with `ctrlKey` in Chromium and
    Electron: zoom around the pointer; also Cmd +/− and Cmd 0 (fit); two-finger scroll keeps panning. Check that Electron
    does not zoom the whole page instead (`webContents.setVisualZoomLevelLimits(1, 1)`, preventDefault on the canvas).
28. **"Final selection" is hard to find.** On the variants page's toolbar it is an outline button at the far right, styled
    like "+ Variant" and as quiet as "Show discarded"; the user took a long time to find it. It is the page's goal (choosing
    the variant to keep), so it needs primary weight: a primary button, or a step/banner ("3 variants ready: choose the
    final one"), and a star on each variant card to pick it directly. Part of the 26–27 redesign; suggests the page's main
    job is comparing and choosing.
    **Clicked:** "Final selection" only opens a read-only popover ("Where each format of the group export comes from.
    Without a ★ the default rule applies to variant A." and one row "YouTube · Video 16:9 · Variant A · v1 · default rule").
    The actual choosing is the small ☆ next to each format name on the variant cards (`variants/GroupStar.tsx`), which the
    user did not connect to it. Wanted: the choice is made where the user clicks: the popover (or a real dialog) lists each
    format with the variants side by side to pick from, and the card ☆ gets a visible label ("Choose" / "Chosen").
29. **"Versions" in the variants page's header: what is it for?** The user remembered versions as per format, not per
    creative. How it works (phase 9, decisions 149, 849): a version is one agent turn (or editor save) of one variant, and it
    holds all that variant's formats; each format then has its own history (the versions where *it* changed) and its own ★.
    So the header menu ("v2 04:13 PM · 149.9k tokens · Per tutte le varianti cambia il brief…", "v1 · Generation from the
    brief") is the turn history of the variant currently open in the chat (A/B/C selector), but nothing on the page says which
    variant, and it sits next to Render/Export as if it were the whole creative's. Its thumbnails are cropped ("scribe").
    Ideas: drop it from the creative page (the per-format version badge on each card is enough), or label it with the variant
    ("Variant C · 2 versions") and move it to the chat panel, where the turns are.
30. **A format's version menu: broken layout, and "1 version" where the user expects 2.** Variant C, "YouTube · Video 16:9
    versions 1": the row's ★ sits outside the row, past the "Auto" chip, at the popover's edge; "Your pick" and "Auto" on the
    same row contradict each other; the thumbnail is cropped ("scribe"); "Compare" is a disabled grey block; two stars side by
    side on the card (the group ★ and the badge's "★ v1"). **Why 1:** checked read-only in the user's `versions.json`: in all
    three variants v2 has the same 16:9 composition hash as v1 (v2 was the turn that only changed the brief, report 6), so the
    format's history correctly lists only v1. Right by design, but invisible: the user sees v2 in the variant's menu (report
    29) and v1 here. Also for A and B v1 is `incomplete` and v2 `complete` with the same hash: the format menu shows only the
    incomplete one. Ideas: show "v1 (unchanged in v2)" or "v1 · v2", explain "only versions that changed this format"; let a
    brief-only turn not create a version (or mark it "brief only"); fix the row layout.

31. **The paid-services card lists services a creative can't use.** An identity pack (formats `identity-logo`,
    `identity-favicon`, `identity-app-icon`, SVG only, brief services unset) with 5 variants asked to approve about 20 paid
    calls: Images (OpenAI), Voice (OpenAI), Music and Sound effects (ElevenLabs) for each variant. Cause:
    `VariantFanout.paidPlan` (`core/src/creatives/variant-fanout.ts:296`) takes `paidServicePlan`
    (`core/src/bridge/provider-tools.ts:456`), which lists every paid service the brief's services allow with a key set
    (unset = auto = all), and never looks at the formats. Still and vector formats have no audio, so voice, music and sound
    effects can never be called. Whether an SVG identity pack should list Images at all is open. Note that Decline on this card
    stops every variant (`cancelAll`), so the user can't just say no to the paid part.

32. **"Create a new variant F" from the variants page went to all five variants.** Creative
    `audin/…-al-momento-ho-gia-loghi-e-icone…` (identity pack, variants A–E), 2026-10-18 21:13Z. The composer on the group
    page sent the message to A–E. Five agents started; each tried to add F and got "A creative has at most 5 variants".
    Two questions: a request to add a variant should run once, not per variant; and the user wants a sixth variant, so
    the limit of 5 (and how to make room, e.g. archiving one) needs a decision.
    **User's call (2026-10-18):** no limit on the number of variants. Fixes for 31–34 wait for more reports.
33. **A turn that changes nothing still makes an "incomplete" version (decision 1060 does not apply).** In the run above,
    variant A's agent refused (limit) and changed nothing. The core still made v2. Its new version folder had no
    compositions, so the check found "Missing composition" for all three formats, ran two automatic fix attempts, and saved
    v2 as incomplete. The user then asked "Che problemi dovrebbe avere questa variante?" and the same happened again: v3
    incomplete. `keepsLatest` (`creative-turns.ts:1429`) requires every format delivered, and an untouched version folder
    delivers none. A turn that writes no composition must count as unchanged. The fix attempts also cost tokens for nothing.
34. **Noise in the chat during generation.** The agents' shell commands hit:
    - "The WOFF2 decoder requires the Brotli Python extension" (the agent reads a woff2 font with fontTools);
    - "sed reads 'build.py' after a cd whose target cannot be resolved, and a deny rule (//Users/…/.ssh/**) …" (the
      command guard refuses a command after a `cd` it cannot resolve);
    - the warning "The agent wrote files that Motion Studio makes itself; they were removed: compositions/.claude" (variants
      B and D).
    The agents recovered each time, but the user reads them as errors.

35. **One agent for the whole creative, not one per variant.** The user strongly dislikes that each variant has its own
    agent and chat: it makes it hard to follow and to talk to. Wanted: a single agent that handles every variant. Which
    variant it works on comes from the comments/notes left on a variant, or from the message naming it. This also settles
    report 32 (a "new variant" request runs once). Open points, for the design:
    - first generation of N variants: today N agents run in parallel; one agent could still hand the heavy work to
      parallel workers behind the one chat;
    - a message that names no variant and has no comment attached (the variant open on screen? ask?);
    - versions stay per variant and per format (decision 972); the existing per-variant chats need a migration.

36. **App store pack wizard, step 3: a caption is required for every screenshot.** The user finds it awkward to write
    a caption per screenshot when the general brief already has them (2026-10-19). Today the wizard refuses an empty
    caption (`captionRequired`, schema `.min(1)`), and a caption is cut at 80 characters (`maxLength={80}`, schema
    `.max(80)`). The user pasted longer lines ("Messaggi › Tutte, casella piena | **Tutti i clienti, …"), so the
    field cut them.
    User's call: captions become optional; an empty one is taken by the agent from the general brief, a written one
    wins. The 80-character cut goes too: the agent shortens a caption that does not fit. To do with the next reports.
    Then the creation failed: "Couldn't create the creative: Invalid request: brief.formatLabels.appstore-iphone-69: Too
    big: expected string to have <=60 characters; …" for all 16 screenshots (App Store and Play Store). Cause:
    `storePackFormats` (shared `store-pack.ts`) builds each label as "N · caption", but a caption may be 80 characters
    and a label at most 60. Any caption over 56 characters blocks the whole pack. Workaround until the fix: captions of
    56 characters at most.

37. **New creative: the "Store pack" entry should not sit on top of the formats list.** The user wants it as part of the
    "App Store" and "Play Store" groups (2026-10-19). Done with 36 (decisions 1221, 1222).

38. **Blurry text in a 2K export.** The user exported a 60 s 16:9 video at 2560×1440 and the text looks soft, "not like
    2K" (2026-10-19). Cause: the agent's camera rig (`layers/world.html`, `#world{will-change:transform}`, scaled and
    rotated every frame) is rasterised by Chromium once, at its first scale, and then resampled, at any export size.
    User's call: fix it. Done (decisions 1230–1232, 1237–1247): the layer agent drops the hints that freeze the raster
    (transform, scale, rotate, translate) in every layer document, in renders and in the preview; the agent
    is told not to use them on what scales or rotates. Measured on 10 px text scaled to ~3.9x (squared gradient energy):
    215 with the hint against 1174 without; 1174 for every case after the fix.

39. **Export frame rate.** Every video is exported at the composition's fps (30); the user wants to choose 24, 25, 30, 50
    or 60 fps in Export (2026-10-19). User's call: offer them. Done (decisions 1233–1236): the frame rate is part of the
    export profile (default: the format's own, not remembered), the export renders at it, and the render records its fps
    (decisions 1241, 1242 after the review).

40. **Store pack canvas: every board on one row, the space not used.** While the 19 formats of an App Store + Play Store
    pack generate (2026-10-19), the canvas shows the App Store screenshots 1…8 in a single row that runs off the right edge,
    small, with the rest of the canvas empty below. Cause: `canvasModel.worldAt` puts every tall board (ratio ≤ 0.75) in
    one row and the others in one column next to it; `fitBoards` cannot zoom out past `min` and the labels keep a width
    floor (`LABEL_MIN`), so many tall boards overflow. The user wants the boards laid out to use the space.
    User's call: one row per group of the side list (App Store 1–8 + App Preview, then Play Store 1–8, then the other
    formats such as the feature graphic and the video); a row that is too long wraps; the opening zoom shows everything.
    Done (decisions 1270–1272): the canvas follows the formats column's groups (a store pack by store, each on lines of its
    own; small groups of an ordinary creative share a line when they fit whole), lines wrap at the opening zoom, which can
    go down to 10% (labels follow the boards below 50%, a screenshot named by its number). Checked in Chrome at 1280,
    1440 and 1728 px: all 19 boards in view, opening at 24%, 30% and 41% (decision 1288 after the review).

41. **Formats appear only when the whole turn is done.** While a multi-format turn runs (the 19-format store pack,
    2026-10-19), every board shows "Rendering…" / "Not generated yet" until the end, then all appear together. The user
    wants each format shown as soon as it is ready. Cause: the canvas shows the outputs of a recorded version
    (`versions.json`), and the version is recorded when the turn ends; during the turn a board only has the `rendering`
    flag (`renderingOf(job, states)`), with no per-format progress.
    User's call: a live preview of each composition while the agent is still writing it would be nice, if it does not
    make the app lag (many boards at once, e.g. 19 in a store pack); otherwise show each format as soon as it is ready
    and checked, marked "In lavorazione", with the version still recorded at the end of the turn. Measure the cost
    before choosing. Done (decisions 1277–1281): 19 playing previews took ~1.5 cores and halved the page's frame rate, so a
    format the agent's check passes shows its poster, "In lavorazione", and plays on hover; the version is recorded at the
    end as before, and a stopped or failed turn clears those boards (review fixes: decisions 1282–1287).

42. **The chat's "Applies to" chips do not scale to many formats.** In a creative with 19 formats (store pack,
    2026-10-19) the composer shows one chip per format ("All formats", "App Store · 1" … "Play Store · Promo video
    16:9"): ten rows of chips above the message field. The user finds it awkward with many formats.
    User's call: one menu button "Si applica a: Tutti i formati ▾" that opens the formats grouped as in the side list
    (App Store, Play Store…), a checkbox per format and one per group; the button says what is chosen ("App Store · 3
    formati"). Done (decisions 1275, 1276): one menu button on the canvas, the format view and the editor, also with few
    formats; the scope sent is unchanged.

43. **"Not rendered" under every finished board is confusing.** The store pack screenshots show v1 with "Not rendered"
    (2026-10-19); the user asks what it means and whether rendering was removed in favour of export only. It means the
    version's compositions exist (the board shows them live) but the final file (PNG/MP4) was not made: since decision
    974 a render starts from Export (it renders what is missing) or from the board menu "Render vN"; the bar has Export
    only. The label reads like something is missing or broken.
    User's call: no label on a ready board that has no render; only the useful states stay (queued, rendering %, failed
    · retry, problems). Renders still start from Export or "Render vN". Done (decisions 1273, 1274).

44. **Project icon from an asset.** On the Projects page every project's mark is its initials ("AU", "MS", "HS", "K-")
    (2026-10-19). Motion Studio already extracts the brand's assets (logos, favicons, app icons) from the site and
    elsewhere; the user wants to pick one of the project's assets as the project's icon inside the app.
    User's call: automatic and choosable. When the brand has a fitting icon (app icon, favicon, square logo) it is used
    by itself; Project settings let the user pick another asset or go back to the initials; an image's detail offers
    "Usa come icona del progetto". Done (decisions 1306–1309): `project.json` may carry `icon` (an image of the library or
    the initials; absent: automatic: the kit's icon logo, else an app icon or favicon of the library, else a square logo);
    the project bar, the switcher and the Projects page show it contained on a neutral tile, the initials when there is
    none or it cannot load; Project settings › General picks Automatic, Initials or a library image; an image's detail
    offers "Usa come icona del progetto"; a renamed image stays the icon.

45. **No thumbnails outside the creative for a version that was never rendered.** Project Audin (2026-10-19): its only
    creative (the Audin Desk store pack, v1 ready, 19 formats shown live on the canvas) has empty dashed placeholders
    ("110:239") on its card in the Creatives list, and the project card on Projects shows the brand placeholder instead
    of a creative. The cards use rendered output files; since decision 974 a v2 version has no file until Export or
    "Render vN", so every new creative will look empty from the outside. The user wants previews there too.
    Proposed fix: without a render file, cards and covers use a frame of the composition (as the canvas does). Done
    (decisions 1302–1305): the creative card, the project cover, "Jump back in" and the version menus show the canvas's
    storyboard poster when a version has no current render (the render file wins when there is one), through the existing
    storyboard route and cache; asked only once on screen, two at a time for the page, shared; no renderer keeps today's
    placeholder.

46. **"Esporta pacchetto" in the formats column is redundant.** The user wants it removed (2026-10-19). It is not the
    same as the top bar Export: it opens the store pack export (store folders, per-device subfolders, store checks).
    User's call: remove the column button; in a creative with a store pack the top bar Export opens the store pack
    export; when the creative also has formats outside the pack, the dialog first asks what to export ("Pacchetto
    store" or "File dei formati").
    Done (decisions 1300–1301): the column button is gone; Export opens the pack export, or first a small "Cosa vuoi
    esportare?" window with the two choices when formats sit outside the pack ("File dei formati" is the ★ export of
    every format, as before); a variant group's pack export works the same from the top bar.

47. **The Export dialog shows no thumbnails for never-rendered versions.** "Export the starred versions" (2026-10-19)
    lists the 19 formats with empty grey thumbnails and "Rendered first", so the user cannot tell whether the right
    things are being exported. Same cause as 45 (the thumbnails come from render files). Done together with 45:
    without a render file, a thumbnail is a frame of the composition. Done (decisions 1302–1304): the ★ export and the
    group export show the storyboard poster of each format rendered first.

48. **The store pack export cannot export a part of the pack.** "Export the store pack" (2026-10-19, after decision
    1300 moved it to the top bar Export) has only the destination and "Export the pack": everything or nothing. The
    user wants to pick by hand what to export from a pack.
    User's call: above the destination, the pack's files grouped by store and device, each with its thumbnail and a
    checkbox, plus a checkbox per group; everything checked by default; the store folders and the store checks stay
    the same; the button counts the files ("Esporta 18 file"). To do with the next reports.
    Done (decisions 1320–1325): the pack export lists the pack's files by store and device, each with its thumbnail (the
    render, or a still of the composition) and a checkbox, with a tri-state checkbox per store and device; all on at first;
    "Esporta N file" counts files × languages. The core takes the selection (`formats`, only the pack's own formats, else 400),
    renders only what is chosen and missing, keeps folders, numbers and store checks; the same for a variant group's pack.

49. **After the final selection the other variants should step aside.** In "Final selection" (2026-10-19) the user
    picks the variant per format (YouTube · Video 16:9 → C v1 ★ Chosen) while A and B stay as visible as C. The user
    asks whether the variants not chosen should be hidden, so the focus stays on the chosen format of each variant.
    User's call: once there is at least one choice, the variants page opens on a "Scelte" view: per format only the
    chosen variant (and version). A "Tutte le varianti" toggle shows them all again; nothing is deleted and the choice
    can always change. To do with the next reports, together with 48.
    Done (decisions 1326–1329): with at least one pick the variants page opens on "Scelte": per format the chosen variant at
    the chosen version (its ★ still changes the pick), then "Senza scelta" with the variant the default rule takes. A
    "Scelte | Tutte le varianti" switch in the variant bar shows the cards again, remembered per group.

50. **The top bar Export button is too wide.** (2026-10-19) It is wide at rest because the export progress bar shows
    inside it. User's call: at rest it is a normal-size button; it widens only when an export starts, with a nice
    dedicated animation, and shrinks back when the export is over. To do with the next reports, with 48 and 49.
    Done (decisions 1330–1332): at rest Export is icon + "Esporta" (about 92 px); while an export or a render runs it widens
    (the motion system's `stretch`, a small spring; nothing under reduced motion) to show its progress, and shrinks back.

51. **Text still not sharp in a 2K export after report 38.** The user exported again at 2560×1440, quality max, 60 fps
    (2026-10-19), and the text is still soft. Cause (measured): html layers are sandboxed iframes running out of process;
    the export scale (decision 974) is set with `Emulation.setDeviceMetricsOverride` on the top-level page only, which
    never reaches them (the iframe's own session refuses it), so each layer draws at 1x and the page stretches it: every
    html layer of an export at another resolution is an upscale. Squared gradient energy on the user's frames at t = 20
    and t = 22.5: 298 and 237 against 542 and 424 for the ground truth (5120 shrunk). Same in the desktop app (Electron
    provider, same page code, layers also out of process).
    Proposed fix: give the scale to the whole browser or window, keeping the layers' process isolation.
    Done (decisions 1340–1348): Chrome is launched with `--force-device-scale-factor` when the render has a scale, the
    desktop's render window renders offscreen at that scale (`offscreen.deviceScaleFactor`); the layers stay out of
    process and see `devicePixelRatio` = the scale; stills, previews and 1x renders are unchanged. On the user's frames,
    both providers: 298 → 532 at t = 20, 237 → 431 at t = 22.5 (98% and 101% of the ground truth). Page zoom and
    device emulation were measured and rejected (1342, 1343). After review (1346–1348): exports below 1 (720p, 480p)
    keep the layers at 1x as before, chrome-headless-shell checked, and the render windows no longer copy every
    offscreen frame into the main process (main-process CPU of a 2560×1440 render 7.5 s → 5.6 s).

52. **"Scelte" view: one tiny preview inside a huge card.** With one chosen format (a 16:9 video) the view shows a card as wide
    as the canvas with a thumbnail of about 280 px in its corner. The user: the space for formats and previews must be used
    better, and why a card at all? No other view puts boards in a card (the variants' cards excepted). Cause: each cell of
    "Scelte" is capped at 240 px × zoom (`chosenColumns`, `CHOSEN_CELL`) and the sections are drawn as `ms-vcard`.
    User's decision: like the plain canvas: no card, the chosen boards laid out as the canvas of a creative without
    variants (fit to the viewport, lines per group), each with its variant's letter above it; "Scelte" and "Senza scelta"
    as plain headings one above the other. Timing: wait for further reports.

53. **Store pack export: scrolling the file list stutters.** Audin's store pack (19 files, version 1, not rendered). The
    user asked whether it is the previews being rendered live, and whether images should be saved. First look: the
    thumbnails are the storyboard posters (270 px JPEG, about 17 KB) already in `.studio/cache/storyboards`, made at
    14:48 and not made again when the dialog opened at 22:24; there are no render files. So nothing is rendered while
    scrolling, and saving renders would not change the list. The cause is still to be measured.
    Timing: measure and fix together with further reports (user).
    Correction by the user: the list no longer stutters; the stutter was while a 2560×1440 60 fps video export ran in the
    background. So the report is: the app's UI stutters during a heavy export (the render windows and the encoder share
    the machine and the desktop app's processes). To measure with the batch: UI frame times during an export, and whether
    the export should yield (fewer parallel frames, lower process priority) while the user works.

## Follow-ups found while working on 12–30

- **Single agent: `add_language` from the coordinator (re-review of feat/single-agent-coordinator, point 4).** The coordinator's
  `add_language` adds the language to the group's brief and starts the translation of every idle variant that has a version
  (decision 1203); a working variant is only named in the tool's answer. Its translations are not shown per variant card,
  and there is no way to ask "only B in German". Decide with use whether a language should be a per-variant action (cards
  and a `variant` argument) or stay group-wide.
- **Flaky on Linux CI:** `core/test/render-media.chrome.test.ts` "lenient (untrusted): a VFR WebM … renders and never fails"
  failed once on ubuntu (run 39141011457, frame index list off by one) with no render code changed, and passed on rerun.
  Make the frame-index assertion tolerant of the container-default-duration rounding, or pin the expected sequence per platform.
- **"Replace with a text layer"** for outlined SVG lettering (report 13): not built (decision 1024).
- **Electron at deviceScaleFactor > 1:** the desktop render windows were only tested with system Chrome (decision 1002).
