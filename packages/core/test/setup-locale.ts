import { beforeEach } from 'vitest';
import { setLocale } from '../src/i18n.ts';

// Existing assertions use the Italian texts: every test file starts in `it`.
beforeEach(() => setLocale('it'));
setLocale('it');
