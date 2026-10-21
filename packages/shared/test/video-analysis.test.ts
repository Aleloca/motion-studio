import { describe, expect, it } from 'vitest';
import { messages, sidecarHeaderSchema, videoAnalysisJobKey, writeVideoAnalysisSchema, JOB_WAIT_REASONS, usageKindSchema } from '../src/index.ts';

const SHA = 'ab'.repeat(32);
const header = {
  format: 'motion-studio-video-analysis/1', asset: 'assets/clip.mp4', sha256: SHA, bytes: 10, durationSec: 8, width: 640, height: 360,
  fps: 25, hasAudio: true, transcript: 'none-skipped', language: null, generator: 'Motion Studio 1.0 · claude', createdAt: '2026-10-21T10:00:00.000Z', edited: false,
};

describe('writeVideoAnalysisSchema', () => {
  it('accepts a timeline item with a frame', () => {
    expect(writeVideoAnalysisSchema.parse({ timeline: [{ from: 0, to: 2.5, onScreen: 'Logo', frame: 'f-00000000.jpg' }] }))
      .toEqual({ timeline: [{ from: 0, to: 2.5, onScreen: 'Logo', frame: 'f-00000000.jpg' }] });
  });
  it('refuses an empty write, an unknown key, a named colour, 31 tags and a long tag', () => {
    expect(writeVideoAnalysisSchema.safeParse({}).success).toBe(false);
    expect(writeVideoAnalysisSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(writeVideoAnalysisSchema.safeParse({ look: { colours: ['red'], typography: '', framing: '', audio: '' } }).success).toBe(false);
    expect(writeVideoAnalysisSchema.safeParse({ tags: Array.from({ length: 31 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(writeVideoAnalysisSchema.safeParse({ tags: ['x'.repeat(41)] }).success).toBe(false);
    expect(writeVideoAnalysisSchema.safeParse({ tags: ['x'.repeat(40)] }).success).toBe(true);
  });
});

describe('sidecarHeaderSchema', () => {
  it('takes our header and refuses a short hash or an unknown transcript kind', () => {
    expect(sidecarHeaderSchema.parse(header)).toEqual(header);
    expect(sidecarHeaderSchema.safeParse({ ...header, sha256: 'abc' }).success).toBe(false);
    expect(sidecarHeaderSchema.safeParse({ ...header, transcript: 'whisper' }).success).toBe(false);
    expect(sidecarHeaderSchema.safeParse({ ...header, asset: 'creatives/x.mp4' }).success).toBe(false);
    expect(sidecarHeaderSchema.safeParse({ ...header, more: 1 }).success).toBe(false);
  });
});

describe('video analysis job and copy', () => {
  it('keys a job by root, project and content', () => {
    expect(videoAnalysisJobKey('/w', 'acme', SHA)).toBe(`video-analysis:/w:acme:${SHA}`);
  });
  it('adds the wait reasons, the usage kind and the copy in both languages', () => {
    expect(JOB_WAIT_REASONS).toContain('video-long');
    expect(usageKindSchema.parse('video-analysis')).toBe('video-analysis');
    expect(messages('it').videoAnalysis.waiting({ files: 'clip.mp4' })).toBe('Analisi del video in corso (clip.mp4)…');
    expect(messages('it').videoAnalysis.states).toEqual({ none: 'Non analizzato', queued: 'In coda', running: 'In corso', waiting: 'In attesa', ready: 'Pronta', stale: 'Non aggiornata', error: 'Errore' });
    expect(messages('en').jobs.videoAnalysisLabel({ file: 'clip.mp4' })).toBe('Video analysis · clip.mp4');
  });
});
