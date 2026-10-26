# Home page: Motion Studio makes its own launch video — design

Date: 2026-10-24. Status: approved by the user in chat (they will judge the result on a local preview before it goes
live). Product truth: PRODUCT.md. Visual system: the site's existing one (site/src/css/tokens.css), unchanged.

## Intent
The GitHub Pages home (site/src/index.html) tells the product by following Motion Studio while it creates its own
launch video. A visitor who scrolls to the end has understood everything Motion Studio can do and is struck by how
easy it is: every step is a small gesture with a large result. The page ends with the finished launch video, which is
also embedded in the README.

Audience: people who already use Claude Code (PRODUCT.md). Language: English.

## Chosen structure: "the page is the canvas" (user's pick on the decision page)
Reference sketches: .impeccable/mocks/decision/canvas.html (desktop first viewport, 1440×900) and
.impeccable/mocks/decision/canvas-mobile.html (phone, 390×844, two states).

Desktop
- The page looks like the app: dotted canvas ground, the app's top bar, a chat panel on the right (Chat · Comments ·
  Brief tabs, messages, composer with ⌘↵), boards on the canvas with their format labels.
- First viewport: headline ("The page is the app. Watch it work." or better), Download for macOS (primary, the real
  latest-release link) and "Watch the final cut ↓"; the first user message "A launch video for Motion Studio. Three
  variants." and the agent's answer; three variant boards on the canvas, one gets chosen (outline + ★).
- Scroll drives the story: the chat advances one exchange per step (sticky panel), the canvas reacts in place. Steps,
  one product capability each, in this order:
  1. Brief → three variants appear.
  2. Choose a variant (one click).
  3. Chat request ("Make the title bigger, more energy") → the board changes.
  4. Manual edit in the editor (select a clip, drag/resize, change a colour; "no agent, no tokens") → Save as v3.
  5. Brand: paste a website → palette, fonts, logo applied to the boards.
  6. Formats: the 16:9 board multiplies into 9:16 and 1:1, each recomposed (not cropped).
  7. Languages: the same boards in IT, DE, JA; text stays inside its box (fit).
  8. Subtitles: voice → synced lines on the board.
  9. Identity: logo → favicon, app icon, social preview.
  10. Export: one click, files per channel.
  Also worth a beat if it fits without bloating: versions/compare, talking to the agent while it works, local + git.
- End: the canvas steps aside and the finished launch video plays full width, with Download and GitHub actions.

Phone
- Top bar with Download; the canvas above; the chat becomes a bottom sheet fixed at the bottom showing the current
  step's request and answer; variants swipe one at a time; formats sit side by side scaled; same story order.
- End: the video at screen width.

Reduced motion / no JS: every step is readable as a static section (message + the board's resulting state as a poster);
no scroll-jacking; the video has controls and a poster.

## The final launch video
- A real Motion Studio composition (site/compositions/launch-16x9, plus 9:16 and 1:1 if cheap), 45–60 s, built with
  the product's runtime and validator like the hero compositions (a generator in site/scripts, a test keeping JSON in
  step), rendered to MP4 with the product's own renderer for the README and as the page's video file.
- It replays the same ten steps fast, with interface pieces redrawn as vector motion (not a screen recording), ends on
  "Brief in. Motion out." + logo + GitHub.
- README: a poster image linking to the video (GitHub does not inline repo MP4s) or an uploaded asset; decide in the
  plan.

## Truth
- The boards play real compositions with the product's runtime (existing site/compositions may be reused: KOVA,
  TIDEFALL, Fernwise and the launch video's own frames). Chat messages are authored demo copy, labelled once as a demo.
- No invented customers, numbers or claims (PRODUCT.md Evidence on Hand).

## Constraints
- Same site build/test/check pipeline (site/build.mjs, site/test, site/scripts/check.mjs at 360/768/1440/2000,
  reduced motion); no external runtime dependencies beyond the vendored GSAP; page weight reasonable (lazy posters).
- The guide page stays as it is; the home links to it.
- Local preview before anything is pushed: the user judges it at http://127.0.0.1:4400/motion-studio/.

## Left to the builder
Exact copy, step timings, how each board animates between states, which compositions each board plays, the sticky
mechanics, the launch video's scene design within the ten steps.

## Revision 2026-10-26: classic sections (user tests)
User tests showed two failures of the scroll-driven canvas: visitors type into the chat panel (it looks real), and the
scroll-linked story is either not discovered or scrolled through too fast to read. Decision (user, in chat): keep the
story — Motion Studio making its own launch video, one capability per step, the finished film at the end — but tell it
as a classic page of sections.
- First viewport: headline + Download + the step-1 animation (the brief typing itself, then three variants appearing),
  playing by itself. The full film stays at the end.
- Then one section per step, stacked: a title, two lines of copy, and beside it (alternating sides on desktop, stacked
  on phones) an animation of that step applied to our video. Each animation starts by itself when its section enters
  the viewport and loops at its own pace, independent of scroll speed; no scroll scrubbing, no pinned/sticky story.
- The chat is part of each animation (a request bubble, the agent's short answer), styled as an illustration, never as
  an input; no fixed chat panel and no phone bottom sheet.
- Sound: the Generate and Subtitles sections get an explicit play-with-sound control; nothing plays audio by itself.
- Kept: the final cut (plays only on Play, with sound), Get started, the gallery, the footer, the phone memory budget
  (at most two live runtimes on a phone, four on a computer, unloaded off screen, posters first), reduced motion and
  no-JS fallbacks (posters + copy).
