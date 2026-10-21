import { describe, expect, it } from 'vitest';
import { parseAnalysisBody, parseClock, type SidecarHeader } from '@motion-studio/shared';
import { mergeTranscript, renderBody } from '../src/analysis/sidecar.ts';

const header: SidecarHeader = {
  format: 'motion-studio-video-analysis/1', asset: 'assets/clip.mp4', sha256: 'a'.repeat(64), bytes: 1234, durationSec: 4000, width: 640, height: 360,
  fps: 25, hasAudio: true, transcript: 'whisper-small', language: 'it', generator: 'Motion Studio · x', createdAt: '2026-10-21T10:00:00.000Z', edited: false,
};

// The library reads back what the core writes (Task 19): the web's parser against the core's own renderer.
describe('parseAnalysisBody reads renderBody', () => {
  it('summary, timeline with on-screen text, frame and speech, usable moments, transcript, tags', () => {
    const transcript = [{ from: 13.2, to: 13.9, text: 'Ciao "a tutti"' }, { from: 3725.5, to: 3727, text: 'Fine' }];
    const body = renderBody(header, {
      summary: 'A product demo.\nClean white background.',
      timeline: mergeTranscript([
        { from: 0, to: 12, onScreen: 'Intro', onScreenText: [] },
        { from: 12, to: 18, onScreen: 'Logo on white', onScreenText: ['ACME', 'Since 1990'], frame: 'f-00012000.jpg' },
        { from: 3600, to: 3730, onScreen: 'Outro', onScreenText: [] },
      ], transcript),
      usableMoments: [{ from: 12, to: 18, why: 'Clean logo reveal' }],
      look: { colours: ['#FFFFFF'], typography: 'Sans', framing: 'Product', audio: 'Voice' },
      transcript,
      tags: ['demo', 'logo'],
    });
    const p = parseAnalysisBody(body)!;
    expect(p.summary).toBe('A product demo.\nClean white background.');
    expect(p.timeline.map((s) => [s.from, s.to, s.onScreen])).toEqual([[0, 12, 'Intro'], [12, 18, 'Logo on white'], [3600, 3730, 'Outro']]);
    expect(p.timeline[1]!.onScreenText).toEqual(['ACME', 'Since 1990']);
    expect(p.timeline[1]!.frame).toMatch(/f-00012000\.jpg$/);
    expect(p.timeline[1]!.speech).toEqual([{ at: 13.2, text: 'Ciao \'a tutti\'' }]);
    expect(p.timeline[2]!.speech).toEqual([{ at: 3725.5, text: 'Fine' }]);
    expect(p.usableMoments).toEqual([{ from: 12, to: 18, why: 'Clean logo reveal' }]);
    expect(p.transcript).toEqual([{ from: 13.2, to: 13.9, text: 'Ciao "a tutti"' }, { from: 3725.5, to: 3727, text: 'Fine' }]);
    expect(p.tags).toEqual(['demo', 'logo']);
  });

  it('an empty analysis and a body without a timeline', () => {
    const p = parseAnalysisBody(renderBody({ ...header, transcript: 'none-no-speech' }, { summary: '', timeline: [], usableMoments: [], look: null, transcript: [], tags: [] }))!;
    expect(p).toEqual({ summary: '', timeline: [], usableMoments: [], transcript: [], tags: [] });
    expect(parseAnalysisBody('Note mie sul video.\n## Altro\n- x')).toBeNull();
  });

  it('parseClock', () => {
    expect(parseClock('01:15')).toBe(75);
    expect(parseClock('01:02:03.4')).toBeCloseTo(3723.4);
    expect(parseClock('soon')).toBeNull();
  });
});
