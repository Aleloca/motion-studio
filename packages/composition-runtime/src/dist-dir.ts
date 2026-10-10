import { fileURLToPath } from 'node:url';

/** Absolute path of the built runtime (`dist/`, from `pnpm --filter @motion-studio/composition-runtime build`). Node only. */
export const RUNTIME_DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));
