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
