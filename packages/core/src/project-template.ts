// Agent-facing: written in English. The agent answers in the language the prompt asks for.
export const CONTEXT_MD = `# Motion Studio context

This folder is a **Motion Studio** project: a local app that uses a coding agent to produce motion-graphics videos and images.

## Structure
- \`project.json\` — project metadata (do not edit it by hand).
- \`brand/\` — brand kit (\`brand-kit.json\`), guidelines (\`guidelines.md\`), analysed sources.
- \`assets/\` — project assets with metadata in \`assets.json\`.
- \`references/\` — reference images with notes in \`references.json\`.
- \`creatives/<slug>/\` — one folder per creative: \`work/\` is your workspace, \`outputs/vN/\` holds the delivered outputs.

## Rules
- Work only inside the folder of the creative you are given.
- Linked codebase folders are read-only.
- Install dependencies only locally, in the work folder.
- Do not use git in the project: Motion Studio manages the versions.

## Output contract
You are free to choose tools and techniques (Remotion, Motion Canvas, HTML + Playwright, ffmpeg, Python…). At the end of every turn deliver in \`creatives/<slug>/outputs/vN/\` (the exact folder is given in the request):
1. one file for each requested format, named \`<preset-id>.<extension>\` (e.g. \`instagram-reel-9x16.mp4\`), with the exact resolution of the preset;
2. \`manifest.json\`:
   \`\`\`json
   { "schemaVersion": 1,
     "files": [{ "format": "<preset-id>", "file": "<file name>", "width": 1080, "height": 1920, "durationSec": 15 }],
     "tools": ["remotion"],
     "renderCommand": "command to run in work/ to regenerate the outputs" }
   \`\`\`
   - \`file\` is the file name only, without subfolders (the file sits directly in \`outputs/vN/\`).
   - \`durationSec\` (seconds, positive number) is required only for videos; omit it for images.
Each format is a dedicated **recomposition** (adapted layout, resized text, safe zones respected), never a crop of a master.
Motion Studio checks the outputs after the turn: if formats are missing or the resolutions do not match, you will receive the list of problems to fix.
Suggestions (not constraints): Remotion works well for short videos; for still images, HTML/CSS rendered with Playwright.

## Brand and assets
- \`brand/brand-kit.json\`: colors, fonts, logos, tone, dos and don'ts (each entry with its source).
- \`brand/guidelines.md\`: narrative guidelines.
- \`assets/assets.json\`: list of the assets with description, tags and origin; the files are in \`assets/\`.
- \`references/references.json\`: reference images with notes; the files are in \`references/\`.
Brand rules take precedence over generic choices. Use the project's assets before generating new ones.

## Motion Studio tools
When the request lists the Motion Studio tools (MCP) you can use them: generate images (gpt-image-2), voice-overs, search and download stock photos/videos, download Google Fonts. The files end up in \`assets/\` and are already registered in \`assets/assets.json\`. Keep the attribution of stock assets (\`attribution\` field). Use \`report_progress\` to say where you are and \`validate_output\` (only in creatives) to check the outputs before ending the turn.
`;

export const CLAUDE_MD = `@.studio/context.md
`;

export const GITIGNORE = `outputs/
creatives/*/work/out/
node_modules/
.venv/
.cache/
creatives/*/work/tmp/
*.tmp
.DS_Store
.*.part
assets/.describe/
`;

/** The usage ledger stays versioned; a merge of two histories keeps both sides' lines (append-only JSONL). */
export const GITATTRIBUTES = `.studio/usage.jsonl merge=union
`;

export const PROJECT_DIRS = ['brand', 'assets', 'references', 'creatives'] as const;
