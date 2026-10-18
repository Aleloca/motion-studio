import { describe, expect, it } from 'vitest';
import { answeredVariants, namedVariants } from '../src/variants.ts';

/**
 * Phase 3 of the single agent (spec §7, decision 979): the variants a user's text names, for the core's ask guard. It is a
 * safety net, never the decision: a miss only makes the agent ask, so the parser stays conservative (never a guess).
 */
const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
const named = (text: string, known = ids) => [...namedVariants(text, known)].sort();

describe('namedVariants', () => {
  it('reads letters after "variante/variant", lists and ranges', () => {
    expect(named('Nella variante B il titolo più grande')).toEqual(['b']);
    expect(named('varianti B e C più luce')).toEqual(['b', 'c']);
    expect(named('variants b, c and d: bigger logo')).toEqual(['b', 'c', 'd']);
    expect(named('Fai la B-D più calde')).toEqual(['b', 'c', 'd']);
    expect(named('la variante a destra')).toEqual(['a']);
  });

  it('reads bare upper-case ids that exist, not the sentence-initial words A, E, I, O', () => {
    expect(named('Titolo più grande in B')).toEqual(['b']);
    expect(named('B: titolo più grande')).toEqual(['b']);
    expect(named('B e C con più contrasto')).toEqual(['b', 'c']);
    expect(named('A destra metti il logo')).toEqual([]);
    expect(named('E il logo? Più grande.')).toEqual([]);
    expect(named('Va bene. A me piace così')).toEqual([]);
    expect(named('CTA più grande, OK?')).toEqual([]);
    // A letter that is no variant of the group is not one.
    expect(named('Prova in Z')).toEqual([]);
  });

  it('reads "all" only about the variants, or as the whole answer', () => {
    expect(named('Tutte le varianti più luminose')).toEqual(ids);
    expect(named('in tutte e sei le varianti')).toEqual(ids);
    expect(named('all variants: brighter')).toEqual(ids);
    expect(named('Tutte')).toEqual(ids);
    expect(named('tutti i colori più caldi')).toEqual([]);
    expect(named('make all the texts bigger')).toEqual([]);
  });

  it('reads ids of two letters', () => {
    expect(named('variante AA', ['a', 'b', 'aa'])).toEqual(['aa']);
    expect(named('in AA e B', ['a', 'b', 'aa'])).toEqual(['aa', 'b']);
  });
});

describe('answeredVariants', () => {
  it('reads the labels of the variant options and "all"', () => {
    expect([...answeredVariants('B · Calma', ids)]).toEqual(['b']);
    expect([...answeredVariants('B · Calma, D · Retro', ids)].sort()).toEqual(['b', 'd']);
    expect([...answeredVariants('Tutte', ids)].sort()).toEqual(ids);
    expect([...answeredVariants('All', ids)].sort()).toEqual(ids);
    // The "Other" text is read like a message.
    expect([...answeredVariants('solo la variante C', ids)]).toEqual(['c']);
    expect([...answeredVariants('nessuna', ids)]).toEqual([]);
  });
});
