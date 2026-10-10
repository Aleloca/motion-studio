// Writes src/composition/composition.schema.json from the zod schema (`compositionJsonSchema`).
// Run: pnpm --filter @motion-studio/shared gen:composition-schema. A test fails when the checked-in file is stale.
import { writeFileSync } from 'node:fs';
import { compositionJsonSchema } from '../src/composition/schema.ts';

const target = new URL('../src/composition/composition.schema.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(compositionJsonSchema(), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
