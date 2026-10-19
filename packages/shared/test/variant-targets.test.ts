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

describe('bareCount (re-review 3)', () => {
  it('reads an answer that is only a number', async () => {
    const { bareCount } = await import('../src/variants.ts');
    for (const [text, n] of [['3', 3], ['Tre', 3], ['Quante? Due', 2], ['two.', 2], ['tre varianti', null], ['Ciao', null], ['B', null]] as const) expect(bareCount(text), text).toBe(n);
  });
});

describe('askedNewVariants (review M3)', () => {
  it('reads a request for new variants and how many, in Italian and English (default one)', async () => {
    const { askedNewVariants } = await import('../src/variants.ts');
    const cases: Array<[string, number]> = [
      ['Crea una nuova variante notturna', 1],
      ['Aggiungi una variante più calda', 1],
      ['Fammi altre due varianti', 2],
      ['crea 3 nuove varianti', 3],
      ['Vorrei un\'altra variante', 1],
      ['Ancora una variante, minimale', 1],
      ['Due varianti nuove: una al neon e una pastello', 2],
      ['Add a new variant with a neon look', 1],
      ['make 4 more variants', 4],
      ['another variant please', 1],
      ['Create two new variants', 2],
      ['Tutte le varianti più luminose', 0],
      ['Ciao, come va?', 0],
      ['Fai la variante B più chiara', 0],
      ['Nella variante nuova il titolo è troppo piccolo', 0],
      ['make all variants brighter', 0],
      // Re-review: phrases about the EXISTING variants ask for none.
      ['Applica lo stesso cambio alle altre varianti', 0],
      ['Fai lo stesso nelle altre due varianti', 0],
      ['Rendi le altre varianti più calde', 0],
      ['Nelle altre varianti togli il logo', 0],
      ['apply it to the other variants too', 0],
      ['make the more variants look alike', 0],
      ['fammi una variante B più scura', 0],
      ['make a variant of the logo bigger in B', 0],
      ['Ancora una variante del titolo: più grande', 0],
      ['crea una variante AA più chiara', 0],
      // ...and the requests stay requests.
      ['altre 2 nuove varianti', 2],
      ['Mi fai un\'altra variante?', 1],
      ['Fammi altre tre varianti', 3],
      ['crea una variante al neon', 1],
    ];
    for (const [text, n] of cases) expect(askedNewVariants(text), text).toBe(n);
  });
});
