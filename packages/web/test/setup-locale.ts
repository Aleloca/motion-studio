import { beforeEach } from 'vitest';
import { setFallbackLocale } from '../src/i18n.tsx';

// Existing assertions use the Italian texts: components rendered without a provider start in `it`.
// Tests of other languages wrap the component in <I18nProvider locale="en">.
beforeEach(() => setFallbackLocale('it'));
setFallbackLocale('it');
