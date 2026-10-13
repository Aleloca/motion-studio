import { z } from 'zod';

// Imported first by entry/preview.ts, so it runs before the composition schema is built: zod reads `jitless` and probes
// `new Function` when an object schema is constructed, and the composition CSP (no 'unsafe-eval') reports that probe as a
// `securitypolicyviolation` even though zod catches the error. Jitless, zod never probes.
z.config({ jitless: true });
