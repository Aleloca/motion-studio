import { afterEach, beforeEach, vi, type MockInstance } from 'vitest';

let spy: MockInstance | null = null;

// Existing assertions use the Italian texts. Outside a provider (and before the first snapshot) the UI follows the
// browser's languages, so tests run in an Italian browser; tests of other languages wrap the component in
// <I18nProvider locale="en"> or call `browserLanguages(['en-US'])`.
export function browserLanguages(languages: string[]): void {
  spy?.mockRestore();
  spy = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
}
beforeEach(() => browserLanguages(['it-IT']));
afterEach(() => { spy?.mockRestore(); spy = null; });
