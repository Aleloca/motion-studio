import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { startServer } from '@motion-studio/core';
import { parseCliArgs } from './args.ts';

const HELP = `Uso: motion-studio [--port 4317] [--no-open]

Avvia Motion Studio in locale e apre il browser.
Variabili: MOTION_STUDIO_CONFIG_DIR, MOTION_STUDIO_CLAUDE_COMMAND (array JSON)`;

async function main() {
  let args;
  try { args = parseCliArgs(process.argv.slice(2)); }
  catch (e) { console.error((e as Error).message); console.error(HELP); process.exit(1); }
  if (args.help) { console.log(HELP); return; }
  const webDir = join(dirname(fileURLToPath(import.meta.url)), 'web');
  try {
    const { url, close } = await startServer({ port: args.port, webDir });
    console.log(`Motion Studio è attivo su ${url}`);
    if (args.open) await open(url);
    const stop = async () => { await close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.error(err.code === 'EADDRINUSE' ? `La porta ${args.port} è già in uso: riprova con --port <altra>` : err.message);
    process.exit(1);
  }
}

void main();
