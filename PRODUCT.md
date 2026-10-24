# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who already use Claude Code (developers, makers, small product teams) and need videos and graphics for their
own products, launches and channels without a motion designer. They know the terminal and git; they are not motion
designers.

## Product Purpose

Motion Studio is a local, open-source app on top of Claude Code. From a brief, the agent builds real compositions for
every chosen channel and format; the user iterates in chat or edits directly, then exports ready files. Success: a
person goes from an idea to publishable motion for every channel in minutes, and stays in control of every frame.

## Positioning

- Compositions, not generated pixels: layers, texts and timings the user can retouch by hand or in chat.
- Local and open source: projects, renders and versions (git) stay on the user's computer; no subscription.
- Every format recomposed for its own frame (9:16, 1:1, 16:9, languages, icons), never cropped.
- Uses the Claude Code plan the user already has; paid services (images, voice, music) only with the user's own keys
  and explicit confirmation.

## Operating Context

Desktop app (macOS signed and notarized, Windows, Linux) or `npx`/sources in the browser. A project holds a brand kit
(from a website or a codebase), Assets and creatives. A creative goes: brief (by hand or with the agent) → formats on a
canvas with live preview → chat requests and direct edits in the editor → versions → export. Variants: extra formats,
languages, store packs, creative directions side by side. Identity sets (logo, favicon, app icon, social preview).
Subtitles from local Whisper.

## Capabilities and Constraints

- Requires Claude Code installed and signed in.
- Renders with Chrome; ffmpeg for video.
- First public release: 0.1.0 (2026-10-24).
- The site (site/, GitHub Pages) plays compositions with the product's own runtime and validator.

## Brand Commitments

- Name: Motion Studio. Tagline in use: "Brief in. Motion out."
- Logo and app icon in branding/ (not committed) and site/src/assets.
- Site copy in English.

## Evidence on Hand

Only the product itself: real compositions (site/compositions), real app screenshots (site/src/assets/guide), the
public 0.1.0 release. No customers, testimonials, usage numbers or benchmarks exist: never invent them.

## Product Principles

1. The gesture is small, the result is large: show the cause and the effect together.
2. Everything the agent makes stays editable and inspectable.
3. Local first: the user's files, keys and versions stay theirs.
4. Honest claims only: show the real product, never a mock of a feature that does not exist.
