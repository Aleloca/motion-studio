import { describe, expect, it } from 'vitest';
import { fullSaveLabels } from '../src/instances.ts';

// Report 55 review: a full brief save sends the labels the user changed in the draft; a label they did not touch is the
// latest one the app has (the agent may have named the format after the draft was taken).
describe('fullSaveLabels', () => {
  it('takes the latest label for untouched keys and the draft for changed ones', () => {
    const baseline = { a: 'Old agent', b: 'Mine' };
    const latest = { a: 'New agent', b: 'Mine', c: 'Named meanwhile' };
    const draft = { a: 'Old agent', b: 'Mine, edited' };
    expect(fullSaveLabels(['a', 'b', 'c', 'd'], draft, baseline, latest)).toEqual({ a: 'New agent', b: 'Mine, edited', c: 'Named meanwhile' });
    // A new format typed in the draft; a format left out keeps no label.
    expect(fullSaveLabels(['a', 'n'], { n: 'Nuovo' }, {}, { a: 'X', z: 'gone' })).toEqual({ a: 'X', n: 'Nuovo' });
    expect(fullSaveLabels(['a'], undefined, undefined, undefined)).toBeUndefined();
  });
});
