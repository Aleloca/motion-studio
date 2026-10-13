import '../zod-jitless.ts'; // first: before the schema is built (see zod-jitless.ts)
import { parseDraft } from '../draft.ts';
import { DRAFT_PARSER_KEY } from '../preview-bridge.ts';

// dist/preview.js: the draft validation (zod and the composition schema), loaded by runtime.js in preview mode only, so a
// render page never carries it.
Object.defineProperty(window, DRAFT_PARSER_KEY, { value: Object.freeze({ parseDraft }), writable: false, configurable: false });
