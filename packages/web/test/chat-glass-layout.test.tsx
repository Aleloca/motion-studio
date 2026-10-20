/**
 * Decision 1424 (spec §6.4, decision 1420): every chat is the brief panel's floating glass card. The creative's canvas (a single
 * creative with an approval waiting, and the variant group's one chat), the format view and the editor are rendered in jsdom,
 * given the app's real stylesheets and measured in real Chrome at 1440 × 900 and 1024 × 700, light and dark: each chat column
 * keeps its width (canvas 368/340, format view 320/300, editor 320/288) and the screen's middle keeps its own, the card is inset
 * 12 px on every side with a 20 px radius on the glass background, the tabs sit inside it, the agent's bubbles are on
 * --glassField, the composer has no frame of its own, and every composer button is inside the card. No message runs under the
 * dock, scrolled to the end or to the middle, and nothing scrolls sideways. The canvas's Comments and Brief tabs (also while the
 * brief is edited) and the editor's inspector stay inside the card: every control, scrolled into view, lies inside what clips it,
 * and the first and last focusable controls show their focus ring whole. The canvas (panel stacked under it) and the editor are
 * also measured at 700 px, light. Without Chrome the tests are skipped (MS_REQUIRE_CHROME=1 makes a missing browser a failure); MS_LAYOUT_SHOTS=<folder>
 * saves a screenshot of each case.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type ApprovalRequest, type ConversationEntry, type CreativeDetail, type JobSummary, type OutputFileInfo, type VersionEntry } from '@motion-studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import type { Shell } from '../src/shell/ShellContext.tsx';
import { findChrome, launchChrome, type Browser } from '../../composition-runtime/test/support/chrome.ts';
import { ALL_CSS, FONTS } from './support/layoutAssets.ts';
import { detailFor, groupOf, HOST } from './support/variants.ts';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const at = '2026-10-20T10:00:00.000Z';
const VIDEO = 'tiktok-9x16';
const H = 'b'.repeat(64);
const out = (format: string, file: string, durationSec: number | null = null): OutputFileInfo => ({ format, file, width: 1080, height: 1920, durationSec, verified: true, preview: null });
const version = (n: number): VersionEntry => ({
  n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: n === 1 ? 'Dal brief' : 'Titoli più grandi', problems: [], tools: [], renderCommand: null, basedOn: null,
  outputs: [{ ...out(VIDEO, 'tiktok.mp4', 8), sha256: 'd'.repeat(64), fromComposition: H }, out('instagram-post-1x1', 'post.png')],
  compositions: [{ format: VIDEO, dir: `compositions/${VIDEO}`, hash: H }],
});
const single = (slug: string): CreativeDetail => detailFor(slug, [version(1), version(2)], null, { formats: [VIDEO, 'instagram-post-1x1'] });
const grouped = (slug: string): CreativeDetail => {
  const d = detailFor(slug, [version(1), version(2)], groupOf(['a', 'b', 'c']), { formats: [VIDEO, 'instagram-post-1x1'] });
  return { ...d, variants: { ...d.variants!, single: { groupJobKey: `group:creative:/w:acme:${HOST}` } } } as CreativeDetail;
};
/** A conversation long enough to scroll in every column. */
const conversation: ConversationEntry[] = [
  { type: 'user', at, text: 'Un video verticale per il lancio estivo: titolo grande, logo in basso, chiusura sul prezzo.', pins: [], attachments: [], jobId: 'j0' },
  ...Array.from({ length: 5 }, (_, i): ConversationEntry => ({ type: 'agent', at, jobId: 'j0', event: { kind: 'text', text: `Passo ${i + 1}: leggo il brief, scelgo i colori del marchio e preparo la scena ${i + 1} con il titolo e il logo nelle zone sicure.` } })),
  { type: 'version', at, n: 1, status: 'complete' },
  { type: 'user', at, text: 'Titoli più grandi e il logo più visibile in ogni formato, per favore.', pins: [], attachments: [], jobId: 'j1' },
  ...Array.from({ length: 4 }, (_, i): ConversationEntry => ({ type: 'agent', at, jobId: 'j1', event: { kind: 'text', text: `Ingrandisco il titolo del ${20 + i * 5}% e sposto il logo più in alto, lontano dai controlli della piattaforma.` } })),
  { type: 'version', at, n: 2, status: 'complete' },
  { type: 'agent', at, jobId: 'j1', event: { kind: 'result', ok: true, text: 'Fatto: la versione 2 ha i titoli più grandi e il logo ben visibile. Dimmi se va bene così.' } },
];

let mode: 'single' | 'group' = 'single';
const composition = {
  $schema: 'motion-studio/composition@1', width: 1080, height: 1920, fps: 30, duration: 8, background: '#000000', fonts: [],
  scenes: [{ id: 's1', name: 'Apertura', start: 0, duration: 4 }, { id: 's2', name: 'Chiusura', start: 4, duration: 4 }],
  tracks: [{ id: 't1', name: 'Titoli', kind: 'text', clips: [{
    id: 'c1', name: 'Titolo', type: 'text', start: 0, duration: 8,
    props: { text: 'Lancio estivo', fontFamily: 'Inter', fontSize: 64, color: '#ffffff', x: 100, y: 200, width: 880, height: 200 }, animations: [],
  }] }],
};
const api = {
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  getCreative: vi.fn(async (_s: string, c: string) => (mode === 'group' ? grouped(c) : single(c))),
  getConversation: vi.fn(async () => conversation),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  fileBytes: vi.fn(async () => 12_400_000),
  getUsage: vi.fn(async () => { throw new Error('offline'); }),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: true, interrupt: true, checkedAt: at })),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: at, frames: [] })),
  groupExportPlan: vi.fn(async () => ({ items: [], formats: [] })),
  revokePreview: vi.fn(async () => ({ revoked: true })),
  previewSession: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({
    url: `http://127.0.0.1:61234/tok-${format}-v${n}/runtime/index.html?mode=preview&parentOrigin=x`, token: `tok-${format}-v${n}`, origin: 'http://127.0.0.1:61234',
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), format, hash: H, width: 1080, height: 1920, duration: 8, fps: 30,
  })),
  getEditorComposition: vi.fn(async (_s: string, _c: string, n: number, format: string) => ({ n, format, primaryFormat: format, hash: H, files: [], fonts: [], composition })),
  getStoryboard: vi.fn(async (_s: string, _c: string, _n: number, format: string) => ({ format, hash: H, width: 270, expiresAt: new Date(Date.now() + 600_000).toISOString(), frames: [] })),
  getBrand: vi.fn(async () => ({ kit: { colors: [], fonts: [] } })),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
  listComments: vi.fn(async () => ({ comments: [] })),
};
class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
// The live player is an iframe on another origin: a stand-in reports a ready media (8 s, paused).
vi.mock('../src/components/CompositionPlayer.tsx', async (orig) => {
  const { useEffect } = await import('react');
  const { CompositionMedia } = await orig<typeof import('../src/components/CompositionPlayer.tsx')>();
  const ready = () => { const m = new CompositionMedia(); (m as unknown as { dur: number }).dur = 8; return m; };
  return {
    ...(await orig<object>()),
    CompositionPlayer: ({ onMedia }: { onMedia?: (m: unknown) => void }) => {
      useEffect(() => { onMedia?.(ready()); }, [onMedia]);
      return <div className="ms-cplayer" style={{ position: 'absolute', inset: 0, background: '#222' }} />;
    },
  };
});
const { CreativeCanvas } = await import('../src/screens/CreativeCanvas.tsx');
const { FormatView } = await import('../src/screens/FormatView.tsx');
const { EditorScreen } = await import('../src/screens/editor/EditorScreen.tsx');
const { TopBar } = await import('../src/shell/TopBars.tsx');
const { ShellContext } = await import('../src/shell/ShellContext.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');

const running: JobSummary = { id: 'j1', key: `creative:/w:acme:${HOST}`, kind: 'creative', label: 'Lancio', state: 'running', createdAt: at, startedAt: at };
const approval: ApprovalRequest = {
  id: 'ap1', jobId: 'j1', projectSlug: 'acme', creativeSlug: HOST, kind: 'tool', title: 'Eseguire un comando', detail: 'ffprobe -v error -show_entries format=duration assets/musica-di-sottofondo.mp3',
  toolName: 'Bash', alwaysRule: 'Bash(ffprobe:*)', explanation: null, agentReason: 'Controllo la durata della musica', createdAt: at, expiresAt: '2026-10-20T10:10:00.000Z',
};
const liveOf = (withApproval: boolean) => ({ approvals: withApproval ? { ap1: approval } : {}, jobs: withApproval ? { j1: running } : {}, events: {}, creativeTicks: {}, projectTicks: {} }) as unknown as EventsState;

type Screen = 'canvas' | 'group' | 'format' | 'editor';
const ROOT: Record<Screen, string> = { canvas: '.ms-cv', group: '.ms-cv', format: '.ms-fv', editor: '.ms-ed' };
/** The chat column of each screen, and the screen's middle (which must keep main's width). */
const COL: Record<Screen, string> = { canvas: '.ms-cv-panel', group: '.ms-cv-panel', format: '.ms-fv-panel', editor: '.ms-ed-right' };
const MID: Record<Screen, string> = { canvas: '.ms-cv-main', group: '.ms-cv-main', format: '.ms-fv-main', editor: '.ms-ed-main' };
type Width = 1440 | 1024 | 700;
/** main's column widths (canvas.css, format.css, editor.css), at 1440 and 1024 px, and at 700 px for the canvas (the panel
 * stacked under the canvas, the whole width) and the editor (its grid stays). */
const WIDTH: Record<Screen, Partial<Record<Width, number>>> = { canvas: { 1440: 368, 1024: 340, 700: 700 }, group: { 1440: 368, 1024: 340 }, format: { 1440: 320, 1024: 300 }, editor: { 1440: 320, 1024: 288, 700: 288 } };
/** The middle's width on main: the window less the side columns (the format view of an image has no scenes column). */
const MIDDLE: Record<Screen, Partial<Record<Width, number>>> = {
  canvas: { 1440: 1440 - 252 - 368, 1024: 1024 - 200 - 340, 700: 700 }, group: { 1440: 1440 - 252 - 368, 1024: 1024 - 200 - 340 },
  format: { 1440: 1440 - 320, 1024: 1024 - 300 }, editor: { 1440: 1440 - 224 - 320, 1024: 1024 - 224 - 288, 700: 700 - 224 - 288 },
};
/** The cases measured: both themes at 1440 and 1024; light at 700 for the canvas and the editor. */
const CASES = (screen: Screen): Array<{ theme: 'light' | 'dark'; width: Width }> => [
  ...(['light', 'dark'] as const).flatMap((theme) => ([1440, 1024] as const).map((width) => ({ theme, width }))),
  ...(screen === 'canvas' || screen === 'editor' ? [{ theme: 'light' as const, width: 700 as const }] : []),
];

/** The screen's markup: the chat tab; on the canvas also the Comments and Brief tabs and the brief being edited; in the editor
 * also the inspector of the title clip. */
async function markup(screen: Screen): Promise<Record<string, string>> {
  mode = screen === 'group' ? 'group' : 'single';
  const hashBefore = location.hash;
  const creative = screen === 'group' ? `${HOST}~b` : HOST;
  location.hash = screen === 'canvas' || screen === 'group' ? `#/p/acme/c/${creative}` : `#/p/acme/c/${HOST}/f/${screen === 'format' ? 'instagram-post-1x1' : VIDEO}`;
  const live = liveOf(screen === 'canvas');
  const shell = {
    route: screen === 'canvas' || screen === 'group' ? { name: 'creative', slug: 'acme', creative } : { name: 'format', slug: 'acme', creative: HOST, format: VIDEO }, live,
    catalog: { projects: [{ slug: 'acme', name: 'Acme' }], creatives: {}, refresh: () => {} },
    activity: { open: false, tab: null, seq: 0, show: () => {}, hide: () => {}, toggle: () => {} }, openPalette: () => {},
  } as unknown as Shell;
  const page = screen === 'format' ? <FormatView slug="acme" creative={HOST} format="instagram-post-1x1" live={live} />
    : screen === 'editor' ? <EditorScreen slug="acme" creative={HOST} format={VIDEO} live={live} />
      : <CreativeCanvas slug="acme" creative={creative} live={live} />;
  try {
    const { container } = render(<I18nProvider locale="it"><ShellContext.Provider value={shell}><header className="ms-topbar"><TopBar /></header>{page}</ShellContext.Provider></I18nProvider>);
    const col = () => container.querySelector(COL[screen]) as HTMLElement | null;
    await waitFor(() => expect(col()?.querySelector('form.ms-composer')).toBeTruthy());
    await waitFor(() => expect(col()!.querySelectorAll('.ms-convo-list .ms-msg').length).toBeGreaterThan(8));
    if (screen === 'canvas') await waitFor(() => expect(col()!.querySelector('.ms-approval')).toBeTruthy());
    if (screen === 'group') await waitFor(() => expect(col()!.querySelector('.ms-composer-group')).toBeTruthy());
    if (screen === 'editor') await waitFor(() => expect(container.querySelector('.ms-tl')).toBeTruthy());
    const root = () => (container.querySelector(ROOT[screen]) as HTMLElement).outerHTML;
    const html: Record<string, string> = { chat: root() };
    if (screen === 'canvas') {
      await userEvent.click(within(col()!).getByRole('tab', { name: /Commenti/ }));
      html.comments = root();
      await userEvent.click(within(col()!).getByRole('tab', { name: /Brief/ }));
      await waitFor(() => expect(col()!.querySelector('.ms-cv-brief-wrap:not([hidden]) *')).toBeTruthy());
      html.brief = root();
      await userEvent.click(within(col()!).getByRole('button', { name: /Modifica il brief/ }));
      await waitFor(() => expect(col()!.querySelector('.ms-cv-brief-edit')).toBeTruthy());
      html.briefEdit = root();
    }
    if (screen === 'editor') {
      fireEvent.keyDown(container.querySelector('[data-clip="c1"]')!, { key: 'Enter' });
      await waitFor(() => expect(col()!.querySelector('.ms-insp')).toBeTruthy());
      html.inspector = root();
    }
    return html;
  } finally { cleanup(); location.hash = hashBefore; }
}

const MEASURE = (col: string, mid: string, tab: string) => `(async () => {
await document.fonts.ready;
const col = document.querySelector(${JSON.stringify(col)});
const card = col.querySelector(':scope > .ms-chat-card');
if (!card) return { missing: true };
const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
const c = r(col), k = r(card);
const cs = getComputedStyle(card);
// Tokens resolved where the card is (light or dark).
const probe = (v) => { const p = document.createElement('i'); p.style.background = 'var(' + v + ')'; card.appendChild(p); const out = getComputedStyle(p).backgroundColor; p.remove(); return out; };
const inside = (el, box) => { const b = el.getBoundingClientRect(); return b.width === 0 || (b.left >= box.left - 0.5 && b.right <= box.right + 0.5 && b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5); };
const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.ms-sr');
const tabs = card.querySelector('.ms-tabs');
const out = { missing: false, col: c, card: k, radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, glass: probe('--glass'), glassField: probe('--glassField'), glassLine: probe('--glassLine'),
  glassSolid: probe('--glassSolid'), backdrop: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
  tabsIn: !!tabs && inside(tabs, k), tabsLine: tabs ? getComputedStyle(tabs).borderBottomColor : null,
  mid: r(document.querySelector(${JSON.stringify(mid)})).width, scroll: document.documentElement.scrollWidth, inner: innerWidth, cardScroll: card.scrollWidth - card.clientWidth,
  outside: [...card.querySelectorAll('*')].filter((el) => vis(el) && getComputedStyle(el).position !== 'fixed' && !inside(el, k) && !el.closest('.ms-convo-list, .ms-cv-brief-wrap, .ms-comments, [role=tabpanel]'))
    .map((el) => (el.getAttribute('aria-label') || el.textContent || el.className).toString().slice(0, 40)) };
if (${JSON.stringify(tab)} === 'chat') {
  const list = card.querySelector('.ms-convo-list');
  const dock = card.querySelector('.ms-convo-dock').getBoundingClientRect();
  const form = card.querySelector('form.ms-composer');
  const under = [];
  out.scrollable = list.scrollHeight > list.clientHeight + 4;
  out.listRight = list.getBoundingClientRect().right <= k.right + 0.5;
  for (const at of ['end', 'middle']) {
    list.scrollTop = at === 'end' ? list.scrollHeight : (list.scrollHeight - list.clientHeight) / 2;
    const lr = list.getBoundingClientRect();
    for (const li of list.children) {
      const b = li.getBoundingClientRect();
      const top = Math.max(b.top, lr.top), bottom = Math.min(b.bottom, lr.bottom);
      if (bottom - top <= 0.5) continue;
      if (bottom > dock.top + 0.5 && top < dock.bottom - 0.5) under.push(at + ': ' + (li.textContent || '').slice(0, 30));
    }
  }
  out.under = under;
  out.dockIn = dock.bottom <= k.bottom + 0.5;
  const bubble = card.querySelector('.ms-msg:not(.ms-you):not(.ms-summary) .ms-msg-bubble');
  out.bubble = bubble ? getComputedStyle(bubble).backgroundColor : null;
  out.bubbleText = bubble ? getComputedStyle(bubble).color : null;
  const fieldBox = form.querySelector('.ms-composer-box');
  out.composerBox = fieldBox ? getComputedStyle(fieldBox).backgroundColor : null;
  const field = form.querySelector('textarea');
  out.composerText = field ? getComputedStyle(field).color : null;
  out.composerShadow = getComputedStyle(form).boxShadow;
  out.composerBg = getComputedStyle(form).backgroundColor;
  const fr = form.getBoundingClientRect();
  out.composerGap = k.bottom - fr.bottom;
  out.buttons = [...form.querySelectorAll('button')].filter(vis).map((b) => ({ name: (b.getAttribute('aria-label') || b.textContent || '').slice(0, 30), in: inside(b, fr) && inside(b, k) }));
  out.send = !!form.querySelector('.ms-composer-send, .ms-composer-act');
  const note = card.querySelector('.ms-composer-group');
  out.note = note ? { clipped: note.scrollWidth > note.clientWidth + 1, in: inside(note, k) } : null;
  const ap = card.querySelector('.ms-approval');
  out.approval = ap ? { in: ap.getBoundingClientRect().right <= k.right + 0.5 && ap.getBoundingClientRect().left >= k.left - 0.5, overflow: ap.scrollWidth - ap.clientWidth } : null;
} else {
  const panel = [...card.children].find((el) => !el.classList.contains('ms-tabs') && vis(el));
  out.panelIn = !!panel && panel.getBoundingClientRect().left >= k.left - 0.5 && panel.getBoundingClientRect().right <= k.right + 0.5;
  out.panelScroll = panel ? panel.scrollWidth - panel.clientWidth : -1;
  // Every control, scrolled into view, lies inside what clips it (its scrolling panel and the card); the focus rings of the
  // first and the last control too. The card itself never scrolls to show one.
  const clipOf = (el) => {
    let box = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
    for (let p = el.parentElement; p && p !== col; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const b = p.getBoundingClientRect();
      box = { left: Math.max(box.left, b.left + p.clientLeft), top: Math.max(box.top, b.top + p.clientTop), right: Math.min(box.right, b.left + p.clientLeft + p.clientWidth), bottom: Math.min(box.bottom, b.top + p.clientTop + p.clientHeight) };
    }
    return box;
  };
  const ring = (el) => {
    const s = getComputedStyle(el);
    let ext = s.outlineStyle !== 'none' ? parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset) : 0;
    for (const sh of s.boxShadow === 'none' ? [] : s.boxShadow.split(/,(?![^(]*\\))/)) {
      if (sh.includes('inset')) continue;
      const n = (sh.match(/-?[\\d.]+px/g) || []).map(parseFloat);
      ext = Math.max(ext, (n[3] || 0) + Math.max(Math.abs(n[0] || 0), Math.abs(n[1] || 0)));
    }
    return ext;
  };
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.className || el.tagName).toString().trim().slice(0, 30);
  const controls = [...card.querySelectorAll('button, input:not([type=hidden]), select, textarea, a[href], [role=switch], [role=slider], [role=tab]')].filter(vis)
    .filter((el) => el.getBoundingClientRect().width > 1 && getComputedStyle(el).opacity !== '0');
  out.controls = controls.length;
  out.clipped = [];
  for (const el of controls) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const b = el.getBoundingClientRect(), x = clipOf(el);
    if (b.left < x.left - 0.5 || b.right > x.right + 0.5 || b.top < x.top - 0.5 || b.bottom > x.bottom + 0.5) out.clipped.push(name(el) + ' [' + [b.left - x.left, x.right - b.right, b.top - x.top, x.bottom - b.bottom].map(Math.round) + ']');
  }
  const focusable = controls.filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.tabIndex >= 0);
  for (const el of [focusable[0], focusable[focusable.length - 1]].filter(Boolean)) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    el.focus();
    const e = ring(el), b = el.getBoundingClientRect(), x = clipOf(el);
    if (document.activeElement !== el) { out.clipped.push('not focusable: ' + name(el)); continue; }
    if (e <= 0) out.clipped.push('no focus ring: ' + name(el) + ' <' + el.tagName + ' ' + el.className + ' ' + (el.getAttribute('role') || '') + '>');
    if (b.left - e < x.left - 0.5 || b.right + e > x.right + 0.5 || b.top - e < x.top - 0.5 || b.bottom + e > x.bottom + 0.5) out.clipped.push('focus ring clipped: ' + name(el) + ' (' + e + ' px; room ' + [b.left - x.left, x.right - b.right, b.top - x.top, x.bottom - b.bottom].map(Math.round) + ')');
    el.blur();
  }
  if (card.scrollTop || card.scrollLeft) out.clipped.push('the card scrolled to show a control');
}
return out;
})()`;

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Measure = {
  missing: boolean; col: Box; card: Box; radius: string; bg: string; glass: string; glassField: string; glassLine: string; glassSolid: string; backdrop: string; tabsIn: boolean; tabsLine: string | null; mid: number;
  scroll: number; inner: number; cardScroll: number; outside: string[]; scrollable?: boolean; listRight?: boolean; under?: string[]; dockIn?: boolean; bubble?: string | null; bubbleText?: string | null; composerBox?: string | null; composerText?: string | null;
  composerShadow?: string; composerBg?: string; composerGap?: number; buttons?: Array<{ name: string; in: boolean }>; send?: boolean; note?: { clipped: boolean; in: boolean } | null;
  approval?: { in: boolean; overflow: number } | null; panelIn?: boolean; panelScroll?: number; controls?: number; clipped?: string[];
};

// WCAG contrast of a text colour over a background that may be translucent, laid over an opaque base.
type Rgba = [number, number, number, number];
const rgba = (c: string): Rgba => { const n = (c.match(/[\d.]+/g) ?? []).map(Number); return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1]; };
const over = (top: Rgba, base: Rgba): Rgba => [0, 1, 2].map((i) => top[i]! * top[3] + base[i]! * (1 - top[3])).concat(1) as Rgba;
const lum = ([r, g, b]: Rgba) => [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (text: string, bg: string, base: string) => {
  const b = over(rgba(bg), rgba(base)), t = over(rgba(text), b);
  const [hi, lo] = [lum(t), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const required = process.env.MS_REQUIRE_CHROME === '1';
const chrome = required || process.env.MS_LAYOUT_CHROME === '1' ? findChrome() : null;
const shots = process.env.MS_LAYOUT_SHOTS ?? null;
const run = chrome ? describe : describe.skip;
if (!chrome && required) it('Chrome is required (MS_REQUIRE_CHROME=1)', () => { throw new Error('missing Chrome (set CHROME_PATH)'); });

run('every chat is the glass card: real Chrome layout', () => {
  let dir = '';
  let browser: Browser;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'ms-chat-glass-')); browser = await launchChrome(chrome!); });
  afterAll(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); });

  async function measure(screen: Screen, tab: string, html: string, width: Width, theme: 'light' | 'dark', transparency: 'no-preference' | 'reduce' = 'no-preference'): Promise<Measure> {
    const height = width === 1440 ? 900 : 700;
    const page = `<!doctype html><html lang="it" data-theme="${theme}"><head><meta charset="utf-8"><style>${FONTS()}\n${ALL_CSS()}
      html,body{margin:0;height:100%;background:var(--bg)} #page{height:100vh}
      /* Focus rings are read at once, not half way through their transition. */ *,*::before,*::after{transition:none !important}</style></head><body><div id="page">${html}</div></body></html>`;
    const reduced = transparency === 'reduce' ? '-reduced-transparency' : '';
    const file = join(dir, `${screen}-${tab}-${theme}-${width}${reduced}.html`);
    writeFileSync(file, page);
    const t = await browser.newPage(width, height);
    try {
      // Never the machine's setting (the macOS CI runner has Reduce Transparency on): the glass is asserted with transparency
      // allowed, the opaque card when the case asks for `reduce`.
      await t.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: transparency }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await t.goto(`file://${file}`);
      const r = await t.eval<Measure>(MEASURE(COL[screen], MID[screen], tab), 30_000);
      if (shots) writeFileSync(join(shots, `${screen}-${tab}-${theme}-${width}x${height}${reduced}.png`), await t.screenshot());
      return r;
    } finally { await t.close(); }
  }

  for (const screen of ['canvas', 'group', 'format', 'editor'] as const) {
    it(`${screen}: the chat is the glass card in its column, light and dark, 1440 × 900 and 1024 × 700${screen === 'canvas' || screen === 'editor' ? ', light at 700 × 700' : ''}`, async () => {
      const html = await markup(screen);
      const failures: string[] = [];
      for (const { theme, width } of CASES(screen)) for (const [tab, markupOf] of Object.entries(html)) {
        const r = await measure(screen, tab, markupOf, width, theme);
        const at = `${screen} ${tab} ${theme} @${width}`;
        const check = (ok: boolean, what: string) => { if (!ok) failures.push(`${at}: ${what}`); };
        if (r.missing) { failures.push(`${at}: no .ms-chat-card in the column`); continue; }
        const colW = WIDTH[screen][width]!, midW = MIDDLE[screen][width]!;
        check(Math.abs(r.col.width - colW) < 0.5, `column ${r.col.width}, main ${colW}`);
        check(Math.abs(r.mid - midW) < 0.5, `middle ${r.mid}, main ${midW}`);
        for (const side of ['left', 'top'] as const) check(Math.abs(r.card[side] - r.col[side] - 12) < 0.5, `card ${side} inset ${r.card[side] - r.col[side]}`);
        for (const side of ['right', 'bottom'] as const) check(Math.abs(r.col[side] - r.card[side] - 12) < 0.5, `card ${side} inset ${r.col[side] - r.card[side]}`);
        check(r.radius === '20px', `radius ${r.radius}`);
        check(r.bg === r.glass, `card background ${r.bg}, glass ${r.glass}`);
        check(r.backdrop.includes('blur('), `card backdrop filter ${r.backdrop}`);
        check(r.tabsIn, 'tabs inside the card');
        check(r.tabsLine === null || r.tabsLine === r.glassLine || screen === 'editor', `tabs line ${r.tabsLine}`);
        check(r.scroll <= r.inner, `page scrolls sideways ${r.scroll}`);
        check(r.cardScroll <= 0, `card scrolls sideways ${r.cardScroll}`);
        check(r.outside.length === 0, `outside the card: ${r.outside.join(' | ')}`);
        if (tab === 'chat') {
          // Stacked under the canvas (700 px), the panel's list may grow with the page instead of scrolling.
          check(r.scrollable === true || (screen === 'canvas' && width === 700), 'the list scrolls (the dock check is not vacuous)');
          check(r.under!.length === 0, `under the dock: ${r.under!.join(' | ')}`);
          check(r.dockIn === true, 'dock inside the card');
          check(r.listRight === true, 'list inside the card');
          check(r.bubble === r.glassField, `agent bubble ${r.bubble}, glassField ${r.glassField}`);
          check(r.composerShadow === 'none', `composer shadow ${r.composerShadow}`);
          check(r.composerBg === 'rgba(0, 0, 0, 0)', `composer background ${r.composerBg}`);
          check(r.composerGap! >= 10 && r.composerGap! <= 16, `composer gap to the card's bottom ${r.composerGap}`);
          check(r.send === true && r.buttons!.length > 0, 'composer buttons rendered');
          for (const b of r.buttons!) check(b.in, `composer button outside: ${b.name}`);
          if (screen === 'group') check(!!r.note && !r.note.clipped && r.note.in, `group note ${JSON.stringify(r.note)}`);
          if (screen === 'canvas') check(!!r.approval && r.approval.in && r.approval.overflow <= 0, `approval card ${JSON.stringify(r.approval)}`);
        } else {
          check(r.panelIn === true, `${tab} panel inside the card`);
          check(r.panelScroll! <= 0, `${tab} panel scrolls sideways ${r.panelScroll}`);
          check(r.controls! > (tab === 'comments' ? 0 : 3), `${tab}: only ${r.controls} controls (the check is not vacuous)`);
          check(r.clipped!.length === 0, `${tab}: clipped by the card: ${r.clipped!.join(' | ')}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('with reduced transparency every chat card is the opaque --glassSolid, its composer on it, and the text stays readable', async () => {
    const failures: string[] = [];
    for (const screen of ['canvas', 'group', 'format', 'editor'] as const) {
      const { chat } = await markup(screen);
      for (const theme of ['light', 'dark'] as const) {
        const r = await measure(screen, 'chat', chat!, 1440, theme, 'reduce');
        const at = `${screen} ${theme} reduced transparency`;
        const check = (ok: boolean, what: string) => { if (!ok) failures.push(`${at}: ${what}`); };
        if (r.missing) { failures.push(`${at}: no .ms-chat-card in the column`); continue; }
        check(r.bg === r.glassSolid && rgba(r.bg)[3] === 1, `card background ${r.bg}, glassSolid ${r.glassSolid}`);
        check(r.backdrop === 'none', `card backdrop filter ${r.backdrop}`);
        // The composer has no background of its own: it shows the opaque card.
        check(r.composerBg === 'rgba(0, 0, 0, 0)', `composer background ${r.composerBg}`);
        const text = contrast(r.bubbleText!, r.bubble!, r.bg), field = contrast(r.composerText!, r.composerBox!, r.bg);
        check(text >= 4.5, `agent bubble text contrast ${text.toFixed(2)}`);
        check(field >= 4.5, `composer text contrast ${field.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
