import { startServer } from './main.ts';

startServer({ port: Number(process.env.PORT ?? 4317) })
  .then(({ url }) => console.log(`Motion Studio core su ${url}`))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
