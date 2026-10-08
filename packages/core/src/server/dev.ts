import { startServer } from './main.ts';

startServer({ port: Number(process.env.PORT ?? 4317) })
  .then(({ url, appUrl }) => {
    const fragment = appUrl.slice(appUrl.indexOf('#'));
    console.log(`Motion Studio core su ${url}`);
    console.log(`Apri ${appUrl} (con Vite: http://localhost:5173/${fragment})`);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
