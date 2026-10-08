import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { AlreadyRunningError, startServer } from '@motion-studio/core';
import { parseCliArgs } from './args.ts';
import { alreadyRunningMessage, NOT_RUNNING, runningUrl } from './print-url.ts';

const HELP = `Uso: npx @motion-studio/cli [--port 4317] [--no-open]
       npx @motion-studio/cli --print-url
(se installato: motion-studio [--port 4317] [--no-open])

Avvia Motion Studio in locale e apre il browser.
--print-url mostra l'indirizzo (con il codice di accesso) del Motion Studio già avviato.
Variabili: MOTION_STUDIO_CONFIG_DIR, MOTION_STUDIO_CLAUDE_COMMAND (array JSON)`;

async function main() {
  let args;
  try { args = parseCliArgs(process.argv.slice(2)); }
  catch (e) { console.error((e as Error).message); console.error(HELP); process.exit(1); }
  if (args.help) { console.log(HELP); return; }
  if (args.printUrl) {
    const url = await runningUrl();
    if (!url) { console.error(NOT_RUNNING); process.exit(1); }
    console.log(url);
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = join(here, 'web');
  const mcpServerPath = join(here, 'mcp-studio.mjs');
  try {
    const { appUrl, close } = await startServer({ port: args.port, webDir, mcpServerPath });
    // The address carries the UI access code: printed even with --no-open (it can be shown again with --print-url).
    console.log(`Motion Studio è attivo su ${appUrl}`);
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
        await open(appUrl);
      } catch {
        console.log(`Apri manualmente ${appUrl}`);
      }
    }
  } catch (e) {
    // Another instance already serves this config folder: show its address instead of starting a second core.
    if (e instanceof AlreadyRunningError) {
      const { appUrl } = e.alreadyRunning;
      console.log(alreadyRunningMessage(appUrl));
      if (args.open) await open(appUrl).catch(() => console.log(`Apri manualmente ${appUrl}`));
      process.exit(0);
    }
    const err = e as NodeJS.ErrnoException;
    console.error(err.code === 'EADDRINUSE' ? `La porta ${args.port} è già in uso: riprova con --port <altra>` : err.message);
    process.exit(1);
  }
}

void main();
