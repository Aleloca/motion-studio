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
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = join(here, 'web');
  const mcpServerPath = join(here, 'mcp-studio.mjs');
  try {
    const { url, close } = await startServer({ port: args.port, webDir, mcpServerPath });
    console.log(`Motion Studio è attivo su ${url}`);
    // Registered before opening the browser so a stop is always handled.
    let closing = false;
    const stop = () => {
      if (closing) process.exit(1); // second signal while closing: force quit
      closing = true;
      close().then(() => process.exit(0), (err: unknown) => {
        console.error(`Chiusura non riuscita: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
    };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, stop);
    if (args.open) {
      try {
        await open(url);
      } catch {
        console.log(`Apri manualmente ${url}`);
      }
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.error(err.code === 'EADDRINUSE' ? `La porta ${args.port} è già in uso: riprova con --port <altra>` : err.message);
    process.exit(1);
  }
}

void main();
