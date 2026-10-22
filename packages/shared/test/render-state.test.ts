import { describe, expect, it } from 'vitest';
import { outputFileInfoSchema, manifestV2Schema, renderState, versionEntrySchema, type VersionEntry } from '../src/index.ts';

const H1 = '1'.repeat(64);
const S1 = 'a'.repeat(64);
const S2 = 'b'.repeat(64);

const version = (subtitles?: { lang: 'it' | 'en'; hash: string }): VersionEntry => ({
  n: 1, commit: null, sessionId: null, status: 'complete', createdAt: '2026-10-22T10:00:00.000Z', request: 'r', problems: [], tools: [],
  renderCommand: null, basedOn: null,
  compositions: [{ format: 'reel', dir: 'compositions/reel', hash: H1 }],
  outputs: [{ format: 'reel', file: 'reel.mp4', width: 1080, height: 1920, durationSec: 5, verified: true, preview: null, sha256: 'c'.repeat(64),
    fromComposition: H1, ...(subtitles ? { subtitles } : {}) }],
});

describe('renderState with the subtitle sets (subtitles Task 18)', () => {
  it('a render drawn with a set is stale once that set\'s hash changed, rendered while it is the same', () => {
    const v = version({ lang: 'it', hash: S1 });
    expect(renderState(v, 'reel', { it: S1 })).toBe('rendered');
    expect(renderState(v, 'reel', { it: S2 })).toBe('stale');
    // The set is gone: what the render shows is no longer the creative's subtitles.
    expect(renderState(v, 'reel', {})).toBe('stale');
    // Another language changing does not touch it.
    expect(renderState(v, 'reel', { it: S1, en: S2 })).toBe('rendered');
  });

  it('without the map: today\'s rule (the composition hash only)', () => {
    expect(renderState(version({ lang: 'it', hash: S1 }), 'reel')).toBe('rendered');
  });

  it('a render without subtitles ignores the map', () => {
    expect(renderState(version(), 'reel', { it: S2 })).toBe('rendered');
    expect(renderState(version(), 'reel', {})).toBe('rendered');
  });

  it('a render drawn from another composition stays stale whatever the subtitles', () => {
    const v = version({ lang: 'it', hash: S1 });
    v.compositions![0]!.hash = '2'.repeat(64);
    expect(renderState(v, 'reel', { it: S1 })).toBe('stale');
  });

  it('the records keep the set a render was drawn with (outputs, the localized row\'s render, the manifest)', () => {
    const out = outputFileInfoSchema.parse(version({ lang: 'it', hash: S1 }).outputs[0]);
    expect(out.subtitles).toEqual({ lang: 'it', hash: S1 });
    expect(outputFileInfoSchema.safeParse({ ...out, subtitles: { lang: 'xx', hash: S1 } }).success).toBe(false);
    expect(outputFileInfoSchema.safeParse({ ...out, subtitles: { lang: 'it', hash: 'nope' } }).success).toBe(false);
    const row = {
      locale: 'de', instanceId: 'reel', hash: S1, voice: 'none', stale: [], texts: 0,
      render: { file: 'reel.de.mp4', width: 1080, height: 1920, durationSec: 5, sha256: S1, fromComposition: H1, overlayHash: S1, forced: false, stale: [],
        renderedAt: '2026-10-22T10:00:00.000Z', subtitles: { lang: 'de', hash: S2 } },
    };
    const parsedRow = versionEntrySchema.shape.localizations.unwrap().element.shape.render.unwrap().parse(row.render);
    expect(parsedRow.subtitles).toEqual({ lang: 'de', hash: S2 });
    const m = manifestV2Schema.parse({ schemaVersion: 2, compositions: [], renders: [{ format: 'reel', file: 'reel.mp4', width: 1, height: 1, durationSec: 5, sha256: S1,
      renderedAt: '2026-10-22T10:00:00.000Z', subtitles: { lang: 'it', hash: S2 } }] });
    expect(m.renders[0]!.subtitles).toEqual({ lang: 'it', hash: S2 });
  });
});
