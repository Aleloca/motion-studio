import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { AlreadyRunningError, AppConfigStore, defaultConfigDir, detectSystemLocales, resolveLocale, setLocale, startServer, t } from '@motion-studio/core';
import { parseCliArgs } from './args.ts';
import { alreadyRunningMessage, notRunningMessage, runningUrl } from './print-url.ts';

const help = () => t().cli.help;

/** The language of every message, fixed before anything is printed: the saved setting, else the system language. */
async function applyLocale() {
  const language = await new AppConfigStore(defaultConfigDir()).read().then((c) => c.language, () => 'system' as const);
  setLocale(resolveLocale(language, detectSystemLocales()));
}

async function main() {
  await applyLocale();
  let args;
  try { args = parseCliArgs(process.argv.slice(2)); }
  catch (e) { console.error((e as Error).message); console.error(help()); process.exit(1); }
  if (args.help) { console.log(help()); return; }
  if (args.printUrl) {
    const url = await runningUrl();
    if (!url) { console.error(notRunningMessage()); process.exit(1); }
    console.log(url);
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = join(here, 'web');
  const mcpServerPath = join(here, 'mcp-studio.mjs');
  try {
    const { appUrl, close } = await startServer({ port: args.port, webDir, mcpServerPath, systemLocales: detectSystemLocales() });
    // The address carries the UI access code: printed even with --no-open (it can be shown again with --print-url).
    console.log(t().cli.running({ url: appUrl }));
    // Registered before opening the browser so a stop is always handled.
    let closing = false;
    const stop = () => {
      if (closing) process.exit(1); // second signal while closing: force quit
      closing = true;
      close().then(() => process.exit(0), (err: unknown) => {
        console.error(t().cli.closeFailed({ detail: err instanceof Error ? err.message : String(err) }));
        process.exit(1);
      });
    };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, stop);
    if (args.open) {
      try {
        await open(appUrl);
      } catch {
        console.log(t().cli.openManually({ url: appUrl }));
      }
    }
  } catch (e) {
    // Another instance already serves this config folder: show its address instead of starting a second core.
    if (e instanceof AlreadyRunningError) {
      const { appUrl } = e.alreadyRunning;
      console.log(alreadyRunningMessage(appUrl));
      if (args.open) await open(appUrl).catch(() => console.log(t().cli.openManually({ url: appUrl })));
      process.exit(0);
    }
    const err = e as NodeJS.ErrnoException;
    console.error(err.code === 'EADDRINUSE' ? t().cli.portInUse({ port: args.port }) : err.message);
    process.exit(1);
  }
}

void main();
