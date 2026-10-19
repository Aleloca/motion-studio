import { describe, expect, it } from 'vitest';
import { agentNameLabel, agentNamedLabel, briefSchema, briefWriteSchema, isUserNamed, keptAgentLabels, storePackFormats, withAgentNames, type Brief, type StorePack } from '../src/index.ts';

// Report 55: the agent names every format it makes; a name the user gave is never the agent's to change.
const base: Brief = { goal: 'g', message: '', formats: ['youtube-16x9', 'instagram-post-1x1'], durationSec: 10, assets: [], notes: '' };
const pack: StorePack = {
  app: { name: 'Conti', tagline: '' }, stores: ['appstore'], devices: { appstore: ['iphone-69'] },
  screenshots: [{ caption: '', screen: null }, { caption: 'Le fatture in un clic', screen: null }, { caption: '', screen: null }], preview: false,
};
const packBrief = (): Brief => {
  const f = storePackFormats(pack);
  return { ...base, formats: f.formats, formatLabels: f.formatLabels, storePack: { ...pack, instances: f.formats } };
};

describe('format names (report 55)', () => {
  it('an existing label is the user\'s; one the agent gave (same text in agentFormatLabels) is not', () => {
    const b: Brief = { ...base, formatLabels: { 'youtube-16x9': 'Promo', 'instagram-post-1x1': 'Teaser' }, agentFormatLabels: { 'instagram-post-1x1': 'Teaser' } };
    expect(isUserNamed(b, 'youtube-16x9')).toBe(true);
    expect(isUserNamed(b, 'instagram-post-1x1')).toBe(false);
    expect(agentNamedLabel(b, 'instagram-post-1x1')).toBe('Teaser');
    expect(agentNamedLabel(b, 'youtube-16x9')).toBeNull();
    // An agent's name the user then changed (another text) is the user's.
    expect(isUserNamed({ ...b, formatLabels: { ...b.formatLabels, 'instagram-post-1x1': 'Mio' } }, 'instagram-post-1x1')).toBe(true);
    // No label: nobody's.
    expect(isUserNamed(base, 'youtube-16x9')).toBe(false);
  });

  it('a store screenshot: the wizard caption is the user\'s, the bare number is not', () => {
    const b = packBrief();
    expect(b.formatLabels!['appstore-iphone-69']).toBe('1');
    expect(isUserNamed(b, 'appstore-iphone-69')).toBe(false);
    expect(isUserNamed(b, 'appstore-iphone-69@2')).toBe(true);
    expect(isUserNamed(b, 'appstore-iphone-69@3')).toBe(false);
  });

  it('withAgentNames names what it may, composes the screenshot number and refuses the user\'s names and unknown formats', () => {
    const b: Brief = { ...packBrief(), formats: [...packBrief().formats, 'youtube-16x9'], formatLabels: { ...packBrief().formatLabels, 'youtube-16x9': 'Mio video' } };
    const r = withAgentNames(b, {
      'appstore-iphone-69': '  Tutti i clienti,\n una casella ', 'appstore-iphone-69@2': 'Fatture', 'appstore-iphone-69@3': 'Promemoria',
      'youtube-16x9': 'Altro', 'tiktok-9x16': 'Nope',
    });
    expect(r.named).toEqual(['appstore-iphone-69', 'appstore-iphone-69@3']);
    expect(r.refused).toEqual([{ format: 'appstore-iphone-69@2', reason: 'user-named' }, { format: 'youtube-16x9', reason: 'user-named' }, { format: 'tiktok-9x16', reason: 'not-in-brief' }]);
    expect(r.brief.formatLabels).toMatchObject({ 'appstore-iphone-69': '1 · Tutti i clienti, una casella', 'appstore-iphone-69@2': '2 · Le fatture in un clic', 'appstore-iphone-69@3': '3 · Promemoria', 'youtube-16x9': 'Mio video' });
    expect(r.brief.agentFormatLabels).toEqual({ 'appstore-iphone-69': '1 · Tutti i clienti, una casella', 'appstore-iphone-69@3': '3 · Promemoria' });
    // The agent may rename what it named; the name it reads back has no number.
    const again = withAgentNames(r.brief, { 'appstore-iphone-69': 'Un solo posto' });
    expect(again.brief.formatLabels!['appstore-iphone-69']).toBe('1 · Un solo posto');
    expect(agentNamedLabel(again.brief, 'appstore-iphone-69')).toBe('Un solo posto');
  });

  it('report 55 review: a number the agent wrote in front of a screenshot\'s name goes; an unchanged name is not named again', () => {
    const b = packBrief();
    const r = withAgentNames(b, { 'appstore-iphone-69': '1 · Tutti i clienti', 'appstore-iphone-69@3': '3 - Promemoria' });
    expect(r.brief.formatLabels).toMatchObject({ 'appstore-iphone-69': '1 · Tutti i clienti', 'appstore-iphone-69@3': '3 · Promemoria' });
    expect(withAgentNames(b, { 'appstore-iphone-69': '1 · ' }).refused).toEqual([{ format: 'appstore-iphone-69', reason: 'empty' }]);
    const again = withAgentNames(r.brief, { 'appstore-iphone-69': 'Tutti i clienti', 'appstore-iphone-69@3': 'Altro' });
    expect(again.unchanged).toEqual(['appstore-iphone-69']);
    expect(again.named).toEqual(['appstore-iphone-69@3']);
  });

  it('report 55 review: onlyUnnamed (a variant\'s own turn) names only formats with no name yet', () => {
    const b = withAgentNames(base, { 'youtube-16x9': 'Lancio' }).brief;
    const r = withAgentNames(b, { 'youtube-16x9': 'Altro', 'instagram-post-1x1': 'Post' }, { onlyUnnamed: true });
    expect(r.named).toEqual(['instagram-post-1x1']);
    expect(r.refused).toEqual([{ format: 'youtube-16x9', reason: 'named' }]);
    // The same name again is unchanged, not refused.
    expect(withAgentNames(b, { 'youtube-16x9': 'Lancio' }, { onlyUnnamed: true }).unchanged).toEqual(['youtube-16x9']);
  });

  it('a name is one line of at most 60 characters', () => {
    const r = withAgentNames(base, { 'youtube-16x9': 'x'.repeat(80) });
    expect(r.brief.formatLabels!['youtube-16x9']!.length).toBeLessThanOrEqual(60);
    expect(agentNameLabel('😀'.repeat(40)).length).toBeLessThanOrEqual(60);
    expect(agentNameLabel(' Seconda\nriga ')).toBe('Seconda riga');
    expect(withAgentNames(base, { 'youtube-16x9': ' \n ' }).refused).toEqual([{ format: 'youtube-16x9', reason: 'empty' }]);
  });

  it('keptAgentLabels drops entries whose label is gone or is no longer the agent\'s text', () => {
    expect(keptAgentLabels({ a: 'X', b: 'Y', c: 'Z' }, { a: 'X', b: 'other' })).toEqual({ a: 'X' });
    expect(keptAgentLabels({ a: 'X' }, undefined)).toBeUndefined();
  });

  it('old briefs read as before; a client cannot write agentFormatLabels', () => {
    expect(briefSchema.parse(base).agentFormatLabels).toBeUndefined();
    const sent = { ...base, formatLabels: { 'youtube-16x9': 'A' }, agentFormatLabels: { 'youtube-16x9': 'A' } };
    expect(briefSchema.parse(sent).agentFormatLabels).toEqual({ 'youtube-16x9': 'A' });
    expect((briefWriteSchema.parse(sent) as Brief).agentFormatLabels).toBeUndefined();
  });
});
