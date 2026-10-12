import type { JobSummary, VersionEntry } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { boardRender, renderKeyOf, renderPct, starRenderPlan } from '../src/screens/renderModel.ts';
import type { FormatState } from '../src/screens/versionModel.ts';

// The render state of v2 boards (Task 8): from the version's records and the live render jobs of that version.

const at = '2026-10-08T10:00:00.000Z';
const KEY = 'creative:/Users/me/Motion Studio:acme:lancio';
const v = (n: number, rendered: string[] = []): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: '', problems: [], tools: [], renderCommand: null, basedOn: null,
  compositions: ['reel', 'post'].map((f) => ({ format: f, dir: `compositions/${f}`, hash: `${n}${f}`.padEnd(64, '0') })),
  outputs: rendered.map((f) => ({ format: f, file: `${f}.mp4`, width: 1, height: 1, durationSec: 1, verified: true, preview: null, sha256: 'a'.repeat(64), fromComposition: `${n}${f}`.padEnd(64, '0') })),
});
const job = (over: Partial<JobSummary>): JobSummary => ({ id: 'r', key: `render:/Users/me/Motion Studio:acme:lancio:v2`, kind: 'render', label: 'R', state: 'running', createdAt: at, ...over });

describe('renderModel', () => {
  it('the render key of a version, from the creative key (a root with ":" too)', () => {
    expect(renderKeyOf(KEY, 2)).toBe('render:/Users/me/Motion Studio:acme:lancio:v2');
    expect(renderKeyOf('creative:C:\\ws:acme:lancio', 4)).toBe('render:C:\\ws:acme:lancio:v4');
    expect(renderKeyOf('brand:/w:acme', 1)).toBeNull();
  });
  it('legacy versions have no render state; v2 ones: none, rendered, queued, rendering, failed', () => {
    const legacy = { ...v(2), compositions: undefined };
    expect(boardRender(legacy, 'reel', [], KEY)).toBeNull();
    expect(boardRender(v(2), 'reel', [], KEY)).toEqual({ kind: 'none' });
    expect(boardRender(v(2, ['reel']), 'reel', [], KEY)).toEqual({ kind: 'rendered' });
    expect(boardRender(v(2), 'reel', [job({ state: 'queued', queuePosition: 3 })], KEY)).toEqual({ kind: 'queued', ahead: 3 });
    expect(boardRender(v(2), 'reel', [job({ formats: ['reel'], progress: { format: 'reel', phase: 'frames', done: 30, total: 60 } })], KEY)).toEqual({ kind: 'rendering', pct: 50 });
    // A job of other formats, or of another version, is not this board's.
    expect(boardRender(v(2), 'post', [job({ formats: ['reel'] })], KEY)).toEqual({ kind: 'none' });
    expect(boardRender(v(2), 'reel', [job({ key: 'render:/Users/me/Motion Studio:acme:lancio:v1' })], KEY)).toEqual({ kind: 'none' });
    expect(boardRender(v(2), 'reel', [job({ state: 'failed', error: 'boom', finishedAt: at })], KEY)).toEqual({ kind: 'failed', error: 'boom' });
    // A later success wins over an earlier failure.
    expect(boardRender(v(2, ['reel']), 'reel', [job({ state: 'failed', finishedAt: at })], KEY)).toEqual({ kind: 'rendered' });
  });
  it('percent per phase: media 0, frames by count (never 100 before finishing), finishing 99, another format 0', () => {
    expect(renderPct(job({ progress: { format: 'reel', phase: 'media', done: 1, total: 2 } }), 'reel')).toBe(0);
    expect(renderPct(job({ progress: { format: 'reel', phase: 'frames', done: 60, total: 60 } }), 'reel')).toBe(99);
    expect(renderPct(job({ progress: { format: 'reel', phase: 'finishing', done: 0, total: 0 } }), 'reel')).toBe(99);
    expect(renderPct(job({ progress: { format: 'post', phase: 'frames', done: 10, total: 60 } }), 'reel')).toBe(0);
  });
  it('Render ★: primaries whose ★ needs a render, grouped by version; followers and rendering ones left out', () => {
    const state = (id: string, star: number | null, follows: string | null = null): FormatState => ({
      id, history: [1, 2], star: { version: follows ? null : star, manual: false, newer: null, follows }, defaultVersion: star, exportVersion: star, starFileMissing: false, linkable: [], follows,
    });
    const versions = [v(1), v(2, ['post'])];
    const states = { reel: state('reel', 2), post: state('post', 2), story: state('story', null, 'reel'), old: state('old', 1) };
    expect([...starRenderPlan(states, versions, [], KEY)]).toEqual([[2, ['reel']]]);
    expect([...starRenderPlan(states, versions, [job({ formats: ['reel'] })], KEY)]).toEqual([]);
    expect([...starRenderPlan({ ...states, post: state('post', 1) }, versions, [], KEY)]).toEqual([[2, ['reel']], [1, ['post']]]);
  });
});
