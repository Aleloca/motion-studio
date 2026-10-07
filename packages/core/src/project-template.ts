export const CONTEXT_MD = `# Contesto Motion Studio

Questa cartella è un progetto di **Motion Studio**: un'app locale che usa un agente di coding per produrre video in motion graphics e immagini.

## Struttura
- \`project.json\` — metadati del progetto (non modificarlo a mano).
- \`brand/\` — brand kit (\`brand-kit.json\`), linee guida (\`guidelines.md\`), sorgenti analizzate.
- \`assets/\` — asset del progetto con metadati in \`assets.json\`.
- \`references/\` — immagini di riferimento con note in \`references.json\`.
- \`creatives/<slug>/\` — una cartella per creatività: \`work/\` è il tuo spazio di lavoro, \`outputs/vN/\` gli output consegnati.

## Regole
- Lavora solo dentro la cartella della creatività che ti viene indicata.
- Le cartelle di codebase collegate sono in sola lettura.
- Installa dipendenze solo in locale nella cartella di lavoro.

## Contratto di output
Sei libero di scegliere strumenti e tecniche (Remotion, Motion Canvas, HTML + Playwright, ffmpeg, Python…). Al termine di ogni turno consegna in \`creatives/<slug>/outputs/vN/\` (la cartella esatta è indicata nella richiesta):
1. un file per ogni formato richiesto, chiamato \`<id-preset>.<estensione>\` (es. \`instagram-reel-9x16.mp4\`), con la risoluzione esatta del preset;
2. \`manifest.json\`:
   \`\`\`json
   { "schemaVersion": 1,
     "files": [{ "format": "<id-preset>", "file": "<nome file>", "width": 1080, "height": 1920, "durationSec": 15 }],
     "tools": ["remotion"],
     "renderCommand": "comando da eseguire in work/ per rigenerare gli output" }
   \`\`\`
Ogni formato è una **ricomposizione** dedicata (layout adattato, testi ridimensionati, safe zone rispettate), mai un ritaglio di un master.
Motion Studio controlla gli output dopo il turno: se mancano formati o le risoluzioni non tornano, riceverai l'elenco dei problemi da correggere.
Suggerimenti (non vincoli): per video brevi Remotion funziona bene; per immagini statiche HTML/CSS renderizzato con Playwright.
`;

export const CLAUDE_MD = `@.studio/context.md
`;

export const GITIGNORE = `outputs/
node_modules/
.venv/
.cache/
*.tmp
.DS_Store
`;

export const PROJECT_DIRS = ['brand', 'assets', 'references', 'creatives'] as const;
