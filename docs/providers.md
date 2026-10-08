# Providers

Providers are external services the agent uses through MCP tools of the `studio` server. The agent never sees the keys: it asks Motion Studio (the core) to call the provider; the core reads the key, makes the call and saves the result in `assets/`, recording it in `assets/assets.json`.

> Verification status: providers are covered by tests with a simulated `fetch`. Images, voice and stock have not been tried live with real keys: the details below describe the code, not a guarantee about the services' behavior (models, prices and APIs change).

## Where the keys live
- In the system keychain (`@napi-rs/keyring`, service "Motion Studio", one entry per provider; Secret Service on Linux), set from **Settings**.
- Or in environment variables, which take precedence: `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY`.
- Keys do not end up in project files. The variables are removed from the environment of the agent and its MCP server; provider error messages are scrubbed of keys (`redact`).
- A missing key produces the error "Set the <Provider> key in the Motion Studio settings" (shown in the language chosen in Settings → Language); in the request to the agent, unconfigured tools appear as "not configured".

## Costs and confirmations
`generate_image` and `tts` are paid: if the option **Ask before using paid providers** is on in Settings (default), every call appears as a request on the job's page (*Allow once*, *Always for this project*, *Deny*; with no answer in 10 minutes it is denied). "Always" saves the rule `provider:openai-images`, `provider:tts-openai` or `provider:tts-elevenlabs` in `<project>/.studio/permissions.json`. Stock search and download and fonts do not ask for confirmation (they are not paid).

## Images: OpenAI gpt-image-2 (`generate_image`)
- Key: `OPENAI_API_KEY`. Model `gpt-image-2`, PNG output.
- Parameters: `prompt`, `width`, `height`, `quality` (`low|medium|high|auto`), `background` (`transparent|opaque|auto`), `references` (up to 16 project images, png/jpg/webp, for editing), `name`.
- Sizes are brought to the nearest supported format (multiples of 16, aspect ratio between 1:3 and 3:1, between about 0.65 and 8.3 megapixels, longest side 3840); if they change, the response says so.
- The file goes in `assets/generated/`, with origin "generated" and tag `gpt-image-2`.

## Voice-over: OpenAI TTS and ElevenLabs (`tts`)
- Keys: `OPENAI_API_KEY` (model `gpt-4o-mini-tts`, default voice `marin`, text up to 4096 characters, optional tone instructions) or `ELEVENLABS_API_KEY` (model `eleven_multilingual_v2`, text up to 5000 characters; with no voice given it uses the first in the account's list).
- If the provider is not given, it uses OpenAI when the key is present, otherwise ElevenLabs.
- Formats `mp3` (default) and `wav`; files in `assets/audio/`, with the attribution "AI-generated voice (<Provider>)" (in the language set in Settings).

## Stock photos and videos: Pexels and Unsplash (`stock_search`, `stock_download`)
- Keys: `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY`. Unsplash offers only photos; search videos on Pexels.
- Search: `query`, `kind` (`photo|video`), `orientation`, `limit` (1–20). Download by `id`: file in `assets/stock/`.
- Attribution: every download records the text the service requires (e.g. "Photo by <author> on Pexels") in the `attribution` field of `assets/assets.json`; for Unsplash the download also notifies the download event and the source link carries the `utm` parameters. Keep the attribution wherever the license requires it.
- 200 MB limit per file. For videos Pexels picks the largest mp4 up to 1920 px wide.

## Fonts: Google Fonts (`fonts_fetch`)
- No key. Parameters: `family`, `weights` (multiples of 100, default 400 and 700), `italic`. Files in `assets/fonts/`.
- Accepts only files served from `fonts.gstatic.com`. OFL or Apache 2.0 license (the response reminds you).

## Downloads from outside: `download_file` (brand analysis)
Only for brand analysis, whose sandbox has no network: downloads a logo, image or font from a website into `assets/brand/` or `assets/fonts/` (image and font extensions, 50 MB maximum). All downloads of externally supplied URLs (provider ones too) go through `safe-fetch.ts`: private, local or reserved addresses are refused by checking the resolved IPs at every redirect, and the connection goes to the very address that was checked. Providers accept only https.

## Adding a provider
1. **Module** in `packages/core/src/providers/<name>.ts`: pure functions that take `HttpDeps & { apiKey }` (`fetch`, `transport`, `lookup`) and use `requestJson`/`requestBytes` from `http.ts` with `secrets: [apiKey]` (errors scrubbed of keys, size limits). To download URLs returned by the service use `safeDownload`.
2. **Key**: add the id to `PROVIDER_IDS` (`packages/shared`) and the variable to `PROVIDER_ENV` (`secrets/vault.ts`); the variables in `PROVIDER_ENV` are automatically removed from the agent's environment. Add the entry in the web app's Settings.
3. **Bridge tool** in `packages/core/src/bridge/provider-tools.ts`: a handler in `providerTools` (validates the arguments, `allowed(c, '<tool>')`, `keyOf`, `confirmPaid` if it costs, `saveGeneratedFile` and `register` to save and record the asset) and a line in `availableTools`.
4. **Authorization per job type**: add the name to `MCP_TOOLS` (`agent/launcher.ts`) for the jobs that may use it.
5. **MCP schema** in `packages/mcp-studio/src/server.mjs` (`TOOLS` list, with an English description: it is agent-facing text).
6. **Tests** with an injected `fetch` (see `openai-images.test.ts`, `stock.test.ts`, `provider-tools.test.ts`): never real network calls or real keys.
7. **Texts**: any message shown to the user goes in the language catalogs (`packages/shared/src/i18n`), not in the code; `pnpm check:i18n` flags Italian text left behind.
