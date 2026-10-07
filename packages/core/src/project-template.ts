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
