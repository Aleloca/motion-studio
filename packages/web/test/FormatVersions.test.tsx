// A format's version menu (user notes 29–30, decisions 972, 974, 1061–1064): one row per content (a version kept unchanged
// in later versions is one row "v1–v2", in the state of the latest of them), the ★ inside its row, one pick label, a
// thumbnail in the format's own proportions, Compare only with two rows, no Render, Reset to Auto only for a manual pick.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OutputFileInfo, VersionEntry } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import type { FormatState } from '../src/screens/versionModel.ts';

const api = {
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  getStoryboard: vi.fn(async (_s: string, _c: string, n: number, f: string) => ({ format: f, hash: 'a'.repeat(64), width: 270, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    frames: [{ t: 3, kind: 'poster', url: `/sb/v${n}/${f}.jpg`, width: 270, height: 480 }] })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { FormatBadge } = await import('../src/screens/FormatVersions.tsx');
import type { VersionActions } from '../src/screens/FormatVersions.tsx';

const at = '2026-10-18T10:00:00.000Z';
const YT = 'youtube-16x9';
const h = (c: string) => c.repeat(64);
const ver = (n: number, hash: string, o: { problems?: string[]; outputs?: OutputFileInfo[]; request?: string } = {}): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: o.problems?.length ? 'incomplete' : 'complete', createdAt: at, request: o.request ?? `richiesta ${n}`,
  outputs: o.outputs ?? [], problems: o.problems ?? [], tools: [], renderCommand: null, basedOn: n > 1 ? n - 1 : null,
  compositions: [{ format: YT, dir: `compositions/${YT}`, hash: h(hash), problems: o.problems ?? [] }],
});
const state = (history: number[], over: Omit<Partial<FormatState>, 'star'> & { star?: Partial<FormatState['star']> } = {}): FormatState => {
  const { star, ...rest } = over;
  return {
    id: YT, history, defaultVersion: history.at(-1) ?? null, exportVersion: history.at(-1) ?? null, starFileMissing: false, linkable: [], follows: null,
    ...rest,
    star: { version: history.at(-1) ?? null, manual: false, newer: null, follows: null, ...star },
  };
};
const actions = (): VersionActions => ({
  star: vi.fn(), resetStar: vi.fn(), pending: () => false, link: vi.fn(), unlink: vi.fn(), restart: vi.fn(), reveal: vi.fn(),
});

function mount(versions: VersionEntry[], s: FormatState, extra: Partial<Parameters<typeof FormatBadge>[0]> = {}) {
  const a = actions();
  render(
    <I18nProvider locale="it">
      <FormatBadge slug="acme" creative="lancio" label="YouTube" state={s} versions={versions} shown={s.star.version} resumeFrom={null}
        labelOf={(id) => id} actions={a} onView={vi.fn()} onCompare={vi.fn()} {...extra} />
    </I18nProvider>,
  );
  return a;
}
const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: /^YouTube: si esporta la v/ }));
  return screen.findByRole('dialog', { name: 'Versioni di YouTube' });
};
const rows = (pop: HTMLElement) => [...pop.querySelectorAll<HTMLElement>('[data-row]')];

describe('a format\'s version menu', () => {
  it('a version that kept the content is one row "v1–v2", in the state of the latest of them, with the explanation', async () => {
    // v1 incomplete (duration off the brief), v2 the same composition after a brief-only turn: complete.
    const versions = [ver(1, 'a', { problems: ['durata'], request: 'Genera' }), ver(2, 'a', { request: 'Cambia il brief' })];
    mount(versions, state([1], { defaultVersion: 1 }));
    const pop = await open();
    expect(rows(pop)).toHaveLength(1);
    const row = rows(pop)[0]!;
    expect(row.textContent).toContain('v1–v2');
    expect(within(row).getByRole('button', { name: /^Guarda la v1 .*invariata fino alla v2/ })).toBeTruthy();
    expect(row.textContent).not.toContain('Incompleta');
    expect(within(pop).getByText('Qui vedi solo le versioni che hanno cambiato questo formato.')).toBeTruthy();
  });

  it('report 45: a version never rendered shows a still of its composition; a rendered one its file', async () => {
    const file: OutputFileInfo = { format: YT, file: `${YT}.png`, width: 1920, height: 1080, durationSec: null, verified: true, preview: null, sha256: h('f'), fromComposition: h('b') };
    mount([ver(1, 'a'), ver(2, 'b', { outputs: [file] })], state([1, 2]));
    const pop = await open();
    const [r2, r1] = rows(pop);
    await waitFor(() => expect(r1!.querySelector('.ms-vmenu-thumb img')?.getAttribute('src')).toBe(`/sb/v1/${YT}.jpg`));
    expect(r2!.querySelector('.ms-vmenu-thumb img')?.getAttribute('src')).toBe(`/f/acme/lancio/outputs/v2/${YT}.png`);
    expect(api.getStoryboard).not.toHaveBeenCalledWith('acme', 'lancio', 2, YT);
  });

  it('Task 22: a render that drew a subtitle set since corrected shows a still (stale), with the creative\'s subtitle hashes', async () => {
    const file: OutputFileInfo = { format: YT, file: `${YT}.mp4`, width: 1920, height: 1080, durationSec: 6, verified: true, preview: null, sha256: h('f'), fromComposition: h('b'), subtitles: { lang: 'it', hash: h('1') } };
    mount([ver(1, 'b', { outputs: [file] })], state([1]), { subtitleHashes: { it: h('2') } });
    const pop = await open();
    await waitFor(() => expect(rows(pop)[0]!.querySelector('.ms-vmenu-thumb img')?.getAttribute('src')).toBe(`/sb/v1/${YT}.jpg`));
  });

  it('an entry still broken in its latest version says so', async () => {
    mount([ver(1, 'a', { problems: ['durata'] })], state([1]));
    expect(rows(await open())[0]!.textContent).toContain('Incompleta');
  });

  it('the ★ is inside its row, and the row says the pick once: "Automatica" or "Scelta da te", never both', async () => {
    const versions = [ver(1, 'a'), ver(2, 'b'), ver(3, 'c')];
    mount(versions, state([1, 2, 3], { defaultVersion: 3, star: { version: 1, manual: true, newer: 3 } }));
    const pop = await open();
    const [r3, , r1] = rows(pop);
    expect(within(r1!).getByRole('button', { name: 'Si esporta la v1' }).getAttribute('aria-pressed')).toBe('true');
    expect(r1!.textContent).toContain('Scelta da te');
    expect(r1!.textContent).not.toContain('Automatica');
    expect(r3!.textContent).toContain('Automatica');
    expect(within(pop).getByRole('button', { name: 'Torna ad Auto' })).toBeTruthy();
  });

  it('a manual pick on the version the rule would pick shows one label', async () => {
    mount([ver(1, 'a')], state([1], { star: { version: 1, manual: true } }));
    const row = rows(await open())[0]!;
    expect(row.textContent).toContain('Scelta da te');
    expect(row.textContent).not.toContain('Automatica');
  });

  it('one version: no Compare, no Render, no Reset to Auto', async () => {
    mount([ver(1, 'a')], state([1]), { render: { n: 1, run: vi.fn() } });
    const pop = await open();
    expect(within(pop).queryByRole('button', { name: 'Confronta' })).toBeNull();
    expect(within(pop).queryByRole('button', { name: /^Render v/ })).toBeNull();
    expect(within(pop).queryByRole('button', { name: 'Torna ad Auto' })).toBeNull();
    expect(rows(pop)[0]!.textContent).toContain('Automatica');
  });

  it('two versions: Compare', async () => {
    mount([ver(1, 'a'), ver(2, 'b')], state([1, 2]));
    expect(within(await open()).getByRole('button', { name: 'Confronta' })).toBeTruthy();
  });

  it('the thumbnail keeps the format\'s proportions (contained, never cropped)', async () => {
    const out: OutputFileInfo = { format: YT, file: 'yt.png', width: 1920, height: 1080, durationSec: null, verified: true, preview: null, sha256: h('f'), fromComposition: h('a') };
    mount([ver(1, 'a', { outputs: [out] })], state([1]));
    const thumb = rows(await open())[0]!.querySelector<HTMLElement>('.ms-vmenu-thumb')!;
    expect(thumb.classList.contains('ms-fit')).toBe(true);
    expect(thumb.style.aspectRatio).toBe('1920 / 1080');
  });

  it('the badge: "★ v1" alone; in a variant group (a group ★ beside it) just "v1", picked or not', async () => {
    mount([ver(1, 'a')], state([1]));
    expect(screen.getByRole('button', { name: /^YouTube: si esporta la v1/ }).textContent).toBe('★ v1');
  });
  it('in a variant group the badge never repeats the group\'s ★', async () => {
    mount([ver(1, 'a')], state([1], { star: { version: 1, manual: true } }), { unstarred: true });
    expect(screen.getByRole('button', { name: /^YouTube: si esporta la v1/ }).textContent).toBe('v1');
  });
});
