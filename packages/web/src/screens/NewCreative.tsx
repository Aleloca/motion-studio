import { canFollow, channelName, statedDurationSec, formatLabel, formatName, type BriefField, type BriefForm, type StorePack, type AssetEntry, type FollowCheck, type IdentityBrief, type Locale, type BrandKit, type BriefServices, type FormatPreset, type LinkedCodebase } from '@motion-studio/shared';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api.ts';
import { CodebaseList } from '../components/CodebaseList.tsx';
import { ServicesSelector, useConfiguredProviders, useKeyChecks } from '../components/ServicesSelector.tsx';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { anim, D, E, flash, glow, isSubmitChord, recede, tileIn, useEnter, usePageShortcut } from '../motion/index.ts';
import type { EventsState } from '../eventsReducer.ts';
import { href, routeKey } from '../routes.ts';
import { createPortal } from 'react-dom';
import { useBarClaim } from '../shell/barSlots.ts';
import { setFrameOrigin } from '../shell/intents.ts';
import { useNewCreativeAssetsIntent } from '../shell/intents.ts';
import { go, ShellContext } from '../shell/ShellContext.tsx';
import { isMac } from '../platform.ts';
import { Button, ChannelMark, Chip, Empty, Icon, Input, Pill, Segmented, cx, initials, toast } from '../ui/index.ts';
import { channelOf } from './creativeState.ts';
import './newcreative.css';
import { message as errText } from './common.tsx';
import { IdentityStart, identityForBrief, primaryLogoOf, resolveIdentity } from './identity/IdentityStart.tsx';
import { StorePackWizard } from './new-creative/StorePackWizard.tsx';
import { packParts } from './new-creative/storePackModel.ts';
import { VariantsField } from './variants/VariantsField.tsx';
import { defaultVariantCount, directionsFor } from './variants/variantModel.ts';
import { BRIEF_TEXT_MAX, variantIdAt } from '@motion-studio/shared';
import './new-creative/storepack.css';
import { LENGTHS, formSnapshot, lengthOf, mergeView, type LengthChoice } from './new-creative/briefSessionModel.ts';
import { useBriefSession } from './new-creative/useBriefSession.ts';
import { BriefSessionPanel } from './new-creative/BriefSessionPanel.tsx';
import { ResumeBriefDialog } from './new-creative/ResumeBriefDialog.tsx';
import { AssetFace, LibraryPicker } from './new-creative/LibraryPicker.tsx';


/** Brief length shown under the field (decisions log 1220: the shared safety cap, no longer 2000). */
const GOAL_MAX = BRIEF_TEXT_MAX;
const TITLE_MAX = 60;
type Kind = 'all' | 'video' | 'image';
/** Channels open on arrival (prototype): the rest sit behind "More channels" until asked for, searched or selected. */
const PRIMARY = ['Instagram', 'TikTok', 'YouTube'];
/** The channels whose group starts with the "Store pack" tile (decision 1222). */
const PACK_CHANNELS = ['App Store', 'Play Store'];
const SUGGESTIONS = ['teaser', 'feature', 'screenshots'] as const;
/** The "App Store screenshots" suggestion also picks this format when the catalog has it. */
const SCREENSHOT_FORMAT = 'appstore-iphone-69';
/** Selected formats drawn in the summary bar. */
const SUMMARY_FRAMES = 5;
/** Format tiles per row on a wide board (newcreative.css). */
const TILE_COLUMNS = 6;

/**
 * Creative title from the brief: its first sentence, at most 60 characters cut on a word boundary, without trailing
 * punctuation, first letter capitalised; `fallback` when nothing is left. The title can be renamed in the canvas.
 */
export function titleFromBrief(brief: string, fallback: string): string {
  const first = brief.trim().split(/\n|(?<=[.!?…])\s/)[0] ?? '';
  let t = first.replace(/\s+/g, ' ').trim();
  if (t.length > TITLE_MAX) {
    const cut = t.slice(0, TITLE_MAX);
    // The 60th character ends a word when the next one is not a letter or digit; otherwise back to the last space.
    const space = /[\p{L}\p{N}]/u.test(t[TITLE_MAX]!) ? cut.lastIndexOf(' ') : TITLE_MAX;
    t = space > 0 ? cut.slice(0, space) : cut;
  }
  t = t.replace(/[\s.,;:!?…\-–—"'“”«»()]+$/u, '');
  return t ? t.charAt(0).toLocaleUpperCase() + t.slice(1) : fallback;
}

/** Maximum length of a format: whole minutes from 2 min up, seconds below ("≤ 90 s", "≤ 3 min"). */
export function maxLengthNote(sec: number): string {
  return sec >= 120 && sec % 60 === 0 ? `≤ ${sec / 60} min` : `≤ ${sec} s`;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const NAMED: Array<[number, number]> = [[1, 1], [4, 5], [5, 4], [9, 16], [16, 9], [2, 3], [3, 2], [3, 4], [4, 3], [4, 1], [1, 4]];
/** `9:16` for the usual proportions (exact, or within 1.5%), the pixel size otherwise (`728×90`). */
export function ratioLabel(w: number, h: number): string {
  const d = gcd(w, h);
  if (w / d <= 21 && h / d <= 21) return `${w / d}:${h / d}`;
  const near = NAMED.find(([a, b]) => Math.abs(w / h / (a / b) - 1) < 0.015);
  return near ? `${near[0]}:${near[1]}` : `${w}×${h}`;
}

/** Linear-interpolated percentile (0–1) of sorted values. */
function percentile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** First generations needed before the estimate is shown (spec §5.4). */
const MIN_HISTORY = 3;

/**
 * "15–25k": the 25th–75th percentile of first-generation token totals, in thousands (one decimal under 10k, plain
 * numbers under 1000, a single figure when both ends round alike); null with fewer than 3 values.
 */
export function similarRange(tokens: number[], locale: Locale): string | null {
  if (tokens.length < MIN_HISTORY) return null;
  const sorted = [...tokens].sort((a, b) => a - b);
  const lo = percentile(sorted, 0.25);
  const hi = percentile(sorted, 0.75);
  const k = hi >= 1000;
  const digits = k && hi < 10_000 ? 1 : 0;
  const f = (n: number) => formatNumber(locale, k ? n / 1000 : n, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const a = f(lo);
  const b = f(hi);
  return `${a === b ? a : `${a}–${b}`}${k ? 'k' : ''}`;
}

/**
 * The links of a new brief (spec §2.3), follower → primary, as the core's `defaultLinks` makes them, in the order the
 * formats were chosen: each format follows the first earlier primary it can follow, unless the user switched that link off
 * (`off`); otherwise it is a primary. `candidates`: every format that can follow, with its primary (its toggle);
 * `blocked`: a format of the same size as an earlier primary that cannot follow it, with the reason (said on its tile).
 * `durationSec`: the brief's video length when known (undefined skips the duration check, re-done on the real file).
 */
export function planLinks(chosen: FormatPreset[], off: ReadonlySet<string>, durationSec: number | undefined): {
  links: Record<string, string>; candidates: Record<string, string>; blocked: Record<string, { primary: string; reason: Extract<FollowCheck, { ok: false }>['reason'] }>;
} {
  const links: Record<string, string> = {};
  const candidates: Record<string, string> = {};
  const blocked: Record<string, { primary: string; reason: Extract<FollowCheck, { ok: false }>['reason'] }> = {};
  const primaries: FormatPreset[] = [];
  for (const f of chosen) {
    const primary = primaries.find((p) => canFollow(p, f, durationSec).ok);
    if (primary) {
      candidates[f.id] = primary.id;
      if (!off.has(f.id)) { links[f.id] = primary.id; continue; }
    } else {
      const near = primaries.find((p) => p.width === f.width && p.height === f.height);
      const check = near ? canFollow(near, f, durationSec) : null;
      if (near && check && !check.ok) blocked[f.id] = { primary: near.id, reason: check.reason };
    }
    primaries.push(f);
  }
  return { links, candidates, blocked };
}
const baseName = (path: string) => path.split('/').pop() ?? path;
/** Brief paths are project paths; the library lists files inside `assets/`. */
const assetPath = (file: string) => `assets/${file}`;

interface Loaded<T> { value: T | null; error: string | null }

/**
 * New creative (spec §6.2 #5), ported from the prototype's NewCreativePage / Tile and the NewCreative boards: brief with
 * suggestions, key message, video length, asset picker from the library, brand, the format board from the real catalog
 * (channels, kind, drawn proportion, maximum length, filter, search, more channels), and the summary bar with Generate.
 */
export function NewCreative({ slug, live }: { slug: string; /** The app's live state (the shell's when absent). */ live?: EventsState }) {
  const t = useT();
  const n = t.web.newCreative;
  const locale = useLocale();
  const shell = useContext(ShellContext);
  // Decisions 1421–1422: the project's brief session; the form below is the one its agent fills.
  const brief = useBriefSession(slug, live ?? shell?.live);
  const projectName = shell?.catalog.projects?.find((p) => p.slug === slug)?.name ?? slug;

  const [goal, setGoal] = useState('');
  const [message, setMessage] = useState('');
  const [length, setLength] = useState<LengthChoice>('6');
  const [customSec, setCustomSec] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [kind, setKind] = useState<Kind>('all');
  const [query, setQuery] = useState('');
  const [more, setMore] = useState<Set<string>>(() => new Set());
  const [picked, setPicked] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [codebases, setCodebases] = useState<LinkedCodebase[]>([]);
  // Untouched (undefined): the brief has no services (all auto), like a brief from before they existed.
  const [services, setServices] = useState<BriefServices | undefined>(undefined);
  const configured = useConfiguredProviders();
  const keyChecks = useKeyChecks();
  const [options, setOptions] = useState(false);
  const [busy, setBusy] = useState<'generate' | 'draft' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goalError, setGoalError] = useState(false);
  const [formatError, setFormatError] = useState(false);
  const [lengthError, setLengthError] = useState(false);

  const [catalog, setCatalog] = useState<Loaded<FormatPreset[]> & { warning: string | null }>({ value: null, error: null, warning: null });
  const [catalogNonce, setCatalogNonce] = useState(0);
  const [library, setLibrary] = useState<Loaded<AssetEntry[]>>({ value: null, error: null });
  const [libraryNonce, setLibraryNonce] = useState(0);
  const [brand, setBrand] = useState<Loaded<BrandKit>>({ value: null, error: null });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [packOpen, setPackOpen] = useState(false);
  // The store pack of the new creative (Phase 14): an entry of the formats list, set from the wizard in a dialog.
  const [pack, setPack] = useState<StorePack | null>(null);
  // "Partenza" of the identity formats (Phase 14): untouched (undefined) follows the brand: from its logo when it has one.
  const [identity, setIdentity] = useState<IdentityBrief | undefined>(undefined);
  // Variants (Phase 15): untouched (undefined) follows the formats (3 for a logo from scratch, else 1); the directions are optional.
  const [variantsChoice, setVariantsChoice] = useState<number | undefined>(undefined);
  const [directions, setDirections] = useState<string[]>([]);
  // Token totals of the workspace's earlier first generations: the estimate line, absent until there are 3.
  const [history, setHistory] = useState<number[]>([]);
  // Decision 1422: the fields the user changed by hand since the agent's last write (the agent never changes them), and the
  // fields the agent wrote (marked "Agente" until the user edits them).
  const [userEdited, setUserEdited] = useState<ReadonlySet<BriefField>>(() => new Set());
  const [agentFields, setAgentFields] = useState<ReadonlySet<BriefField>>(() => new Set());
  // Whether the open session is this form's (null until the first load says): a session left from before waits for Riprendi.
  const [attached, setAttached] = useState<boolean | null>(null);
  // Decisions 1410–1411: "Compila tu" (the form alone, the default) or "Con l'agente" (the session's panel at the left).
  const [mode, setMode] = useState<'you' | 'agent'>('you');
  // The composer's draft from "Fallo compilare all'agente" (decision 1422: the goal's text moves there, never sent by itself).
  const [draft, setDraft] = useState<{ text: string; nonce: number } | undefined>(undefined);
  const formArea = useRef<HTMLDivElement>(null);
  const panelEl = useRef<HTMLElement>(null);
  const ownKey = routeKey({ name: 'new-creative', slug });
  const bar = useBarClaim(ownKey, !shell?.route || routeKey(shell.route) === ownKey);

  const goalRef = useRef<HTMLTextAreaElement>(null);
  const goalBox = useRef<HTMLDivElement>(null);
  const boardHead = useRef<HTMLDivElement>(null);
  const pickerAnchor = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getFormats())
      .then((c) => { if (alive) setCatalog({ value: c.presets, error: null, warning: c.error }); })
      .catch((e: unknown) => { if (alive) setCatalog({ value: null, error: errText(e), warning: null }); });
    return () => { alive = false; };
  }, [catalogNonce]);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.listAssets(slug))
      .then((r) => { if (alive) setLibrary({ value: r.assets, error: r.error }); })
      .catch((e: unknown) => { if (alive) setLibrary({ value: null, error: errText(e) }); });
    return () => { alive = false; };
  }, [slug, libraryNonce]);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getBrand(slug))
      .then((b) => { if (alive) setBrand({ value: b.kit, error: b.kitError }); })
      .catch((e: unknown) => { if (alive) setBrand({ value: null, error: errText(e) }); });
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => {
    let alive = true;
    // A failure only leaves the line out: the estimate is a hint, never a blocker.
    Promise.resolve().then(() => api.getFirstGenerations())
      .then((r) => { if (alive && Array.isArray(r?.tokens)) setHistory(r.tokens.filter((x) => Number.isFinite(x) && x > 0)); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const similar = similarRange(history, locale);

  // "Use in a creative" from Assets.
  useNewCreativeAssetsIntent(slug, useCallback((paths: string[]) => { setPicked((p) => [...p, ...paths.filter((x) => !p.includes(x))]); editedRef.current('assets'); }, []));

  const presets = catalog.value ?? [];
  const chosen = useMemo(() => selected.flatMap((id) => presets.filter((p) => p.id === id)), [selected, presets]);
  const videos = chosen.filter((p) => p.kind === 'video');

  const durationSec = length === 'custom' ? Number(customSec) : Number(length);
  const durationValid = Number.isInteger(durationSec) && durationSec >= 1 && durationSec <= 600;
  // Linked formats (spec §2.3): on by default for every format that can share an earlier one's file; a toggle on its tile.
  const [linkOff, setLinkOff] = useState<ReadonlySet<string>>(() => new Set());
  const plan = useMemo(() => planLinks(chosen, linkOff, durationValid ? durationSec : undefined), [chosen, linkOff, durationValid, durationSec]);
  const toggleLink = (id: string) => setLinkOff((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const presetLabel = (id: string) => { const p = presets.find((x) => x.id === id); return p ? formatLabel(p, locale) : id; };
  const tooLong = videos.find((p) => p.maxDurationSec !== undefined && durationValid && durationSec > p.maxDurationSec) ?? null;
  // User note 6: the brief's text states another duration than the field (a pasted "60-second" brief kept the default 6 s).
  const stated = useMemo(() => statedDurationSec([goal, message, notes].join('\n')), [goal, message, notes]);
  const statedOther = videos.length > 0 && stated !== null && (!durationValid || stated !== durationSec) ? stated : null;
  const applyStated = (n: number) => {
    edited('durationSec');
    const preset = LENGTHS.find((v) => v !== 'custom' && Number(v) === n);
    if (preset) setLength(preset);
    else { setLength('custom'); setCustomSec(String(n)); }
    setLengthError(false);
  };
  const title = titleFromBrief(goal, n.untitled);

  // Board: channel groups in catalog order.
  const q = query.trim().toLocaleLowerCase();
  const shown = (p: FormatPreset) => (kind === 'all' || p.kind === kind)
    && (!q || `${channelName(p.channel, locale)} ${formatName(p, locale)} ${p.channel} ${p.name}`.toLocaleLowerCase().includes(q));
  const groups = useMemo(() => [...new Set(presets.map((p) => p.channel))], [presets]);
  const primary = groups.some((g) => PRIMARY.includes(g)) ? groups.filter((g) => PRIMARY.includes(g)) : groups.slice(0, 3);
  // The "Store pack" entry is the first tile of the App Store and Play Store groups (decision 1222: no longer a row on top);
  // a set pack keeps them open, and a search by its name shows them with it.
  const packShown = (!q || `${t.web.storePack.entryTitle} ${t.web.storePack.entryHint} ${t.web.storePack.title}`.toLocaleLowerCase().includes(q));
  const packIn = (g: string) => PACK_CHANNELS.includes(g) && packShown;
  const open = (g: string) => q !== '' || primary.includes(g) || more.has(g) || presets.some((p) => p.channel === g && selected.includes(p.id)) || (pack !== null && PACK_CHANNELS.includes(g));
  const visibleGroups = groups.map((g) => ({ g, items: presets.filter((p) => p.channel === g && shown(p)) })).filter(({ g, items }) => open(g) && (items.length > 0 || packIn(g)));
  const hiddenGroups = q ? [] : groups.filter((g) => !open(g));

  const root = useEnter<HTMLDivElement>([catalog.value !== null]);

  const toggle = (id: string) => {
    edited('formats');
    setFormatError(false);
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  const suggest = (k: (typeof SUGGESTIONS)[number]) => {
    edited('goal');
    setGoal(n.suggestions[k].text);
    setGoalError(false);
    if (k === 'screenshots') {
      const shot = presets.find((p) => p.id === SCREENSHOT_FORMAT);
      if (shot) { edited('formats'); setSelected([shot.id]); setMore((m) => new Set([...m, shot.channel])); setFormatError(false); }
    }
    void flash(goalBox.current);
  };
  const togglePicked = (path: string) => { edited('assets'); setPicked((p) => (p.includes(path) ? p.filter((x) => x !== path) : [...p, path])); };
  const openPicker = (el: HTMLElement) => { pickerAnchor.current = el; setPickerOpen(true); };

  // One creative per Generate: set before the request and cleared only on failure, so a second press (while the
  // request runs, or while the page is leaving after success) never creates a duplicate and starts a second agent.
  const inFlight = useRef(false);
  const submit = async (generate: boolean) => {
    if (inFlight.current || briefBusy) return;
    // The start mode defaults to the brand's logo when it has one: wait for the brand before sending an identity brief.
    if (identityPending) return;
    if (!goal.trim()) {
      setGoalError(true);
      goalRef.current?.focus();
      void flash(goalBox.current);
      return;
    }
    if (chosen.length === 0 && !pack) {
      setFormatError(true);
      void flash(boardHead.current);
      return;
    }
    if (videos.length > 0 && !durationValid) { setLengthError(true); return; }
    inFlight.current = true;
    setBusy(generate ? 'generate' : 'draft');
    setError(null);
    try {
      // Phase 15: with Varianti >= 2 the creative is made first (nothing starts), then its group; a logo from scratch is grouped by
      // the core itself (decision 845). Typed directions go in before anything starts. A start is one fan-out, never a single turn.
      const dirs = directionsFor(variantCount, directions);
      const typed = dirs.some((d) => d !== null);
      const grouped = variantCount > 1;
      const created = await api.createCreative(slug, {
        title,
        brief: {
          goal: goal.trim(), message: message.trim(),
          // Identity concepts are variants of the group the core creates (`identity.concepts`), never `identity-logo@k` instances.
          formats: [...handIds, ...parts.formats],
          durationSec: videos.length > 0 ? durationSec : parts.durationSec, assets: [...picked, ...parts.assets.filter((a) => !picked.includes(a))], notes: notes.trim(), links: plan.links,
          ...(Object.keys(parts.formatLabels).length > 0 ? { formatLabels: parts.formatLabels } : {}),
          ...(pack ? { storePack: parts.pack! } : {}),
          ...(services ? { services } : {}),
          ...(identityOn ? { identity: { ...identityForBrief(identity, hasBrandLogo), concepts: variantCount } } : {}),
        },
        generate: generate && (!grouped || (coreGroup && !typed)),
        linkedCodebases: codebases,
        // Decision 1423: the brief session goes into the creative (its chat, and its agent's memory for the first turn).
        ...(sessionOpen && brief.session ? { briefSession: { id: brief.session.id, group: variantCount > 1 } } : {}),
      });
      if (created.briefError) { toast.show(created.briefError, { tone: 'neutral' }); void brief.refresh(); }
      let problem: string | null = created.groupError ? vg.groupFailed({ detail: created.groupError }) : created.startError ? vg.startFailed({ detail: created.startError }) : null;
      // Residual fix (decisions log 867): no group was made, so nothing is set or started here and the toast says why.
      if (grouped && !(coreGroup && !typed) && !created.groupError) {
        try {
          if (coreGroup) {
            // The core made the group; the typed directions are set before the first generation.
            for (const [i, d] of dirs.entries()) if (d !== null) await api.setVariantDirection(slug, created.slug, variantIdAt(i), d);
          } else {
            await api.addVariants(slug, created.slug, { count: variantCount, directions: dirs });
          }
          if (generate) await api.runVariants(slug, created.slug, { targets: 'all-active', request: null }).catch((e: unknown) => { problem = vg.startFailed({ detail: errText(e) }); });
        } catch (e) {
          problem = vg.groupFailed({ detail: errText(e) });
        }
      }
      if (problem) toast.show(problem, { tone: 'neutral' });
      if (generate) {
        // Decision 1419: with the panel open the chat moves to the canvas's panel (shared element); the form recedes.
        if (mode === 'agent' && panelEl.current) {
          setFrameOrigin(`brief-panel:${slug}/${created.slug}`, panelEl.current.getBoundingClientRect());
          void recede(formArea.current, D.m);
        }
        go(href.creative(slug, created.slug));
      }
      else {
        toast.show(n.draftSaved({ title }), { tone: 'ok', action: { label: n.open, run: () => go(href.creative(slug, created.slug)) } });
        go(href.project(slug));
      }
      // Success: stay busy; the page is leaving.
    } catch (e) {
      inFlight.current = false;
      setBusy(null);
      // The session is gone or half moved (decision 1423): read again, and say what can be done beside the error.
      brief.report(e);
      setError(errText(e));
    }
  };
  usePageShortcut(root, isSubmitChord, () => { void submit(true); });

  const kit = brand.value;
  const hasBrandLogo = (kit?.logos.length ?? 0) > 0;
  const identityOn = chosen.some((p) => p.identity);
  const identityPending = identityOn && identity === undefined && brand.value === null && brand.error === null;
  const identityNow = resolveIdentity(identity, hasBrandLogo);
  // The pack never takes a picked tile over (Phase 14): its instances take the next free ids beside the chosen ones.
  const handPicked = chosen;
  const handIds = handPicked.map((p) => p.id);
  const parts = packParts(pack, presets, handIds);
  const packExtra = parts.formats.length;
  // Variants: a logo from scratch asks the count inside "Partenza" and the core makes that group; any other creative has the field here.
  const coreGroup = identityOn && identityNow.start === 'scratch';
  const variantCount = variantsChoice ?? defaultVariantCount([...handIds, ...parts.formats], coreGroup);
  const vg = t.web.variantGroup;
  const allVideos = handPicked.filter((p) => p.kind === 'video').length + parts.videos;
  const allImages = handPicked.filter((p) => p.kind === 'image').length + parts.images;
  const hasBrand = !!kit && (kit.colors.length > 0 || kit.fonts.length > 0 || kit.logos.length > 0 || kit.tone !== null);
  // The brand in one line, as on the board: heading font · main colour · tone.
  const brandLine = kit ? [kit.fonts[0]?.family, kit.colors[0]?.name, kit.tone?.text].filter(Boolean).join(' · ') : '';
  const entryOf = (path: string) => library.value?.find((a) => assetPath(a.file) === path) ?? null;

  // ---- Decision 1422: the brief session and the form ----
  const snapshot = formSnapshot({ goal, message, length, customSec, picked, codebases, notes, selected, variantCount });
  const snap = useRef(snapshot);
  snap.current = snapshot;
  const owned = useRef(userEdited);
  owned.current = userEdited;
  // The session's revision this form is based on: adopted only with the form of the view it came with (contract).
  const revision = useRef(0);
  // The edits the session has not answered yet: changed by hand since the last save went out (`dirty`), or in the save still out
  // (`sent`). Only these keep the user's text over a view of the session (briefSessionModel.mergeView).
  const dirty = useRef(new Set<BriefField>());
  const sent = useRef(new Set<BriefField>());
  const pendingEdits = () => new Set([...dirty.current, ...sent.current]);
  const saveBody = useCallback(() => {
    sent.current = new Set([...sent.current, ...dirty.current]);
    dirty.current = new Set();
    return { form: snap.current, userEdited: [...owned.current], baseRevision: revision.current };
  }, []);
  const settleSave = useCallback((ok: boolean) => {
    // A refused save keeps its edits pending (the next save carries them); a taken one is answered.
    if (!ok) dirty.current = new Set([...dirty.current, ...sent.current]);
    sent.current = new Set();
  }, []);
  const sessionOpen = brief.session !== null && attached === true;
  /** A change by hand: the field is the user's (the agent keeps off it) and loses its "Agente" mark; the form is saved. */
  const edited = (f: BriefField) => {
    dirty.current.add(f);
    setUserEdited((s) => (s.has(f) ? s : new Set(s).add(f)));
    setAgentFields((s) => { if (!s.has(f)) return s; const next = new Set(s); next.delete(f); return next; });
    if (sessionOpen) brief.saveForm(saveBody, settleSave);
  };
  const editedRef = useRef(edited);
  editedRef.current = edited;

  // The first load says whose the open session is: none, or one without messages, is this form's; one the agent is working
  // on reopens at once; an idle one with messages waits for the user's choice (Riprendi / Inizia da capo).
  useEffect(() => {
    // A first read that failed decides nothing (the resume question must not be skipped): it is said, with Riprova.
    if (attached !== null || brief.status === 'loading' || brief.status === 'failed') return;
    const s = brief.session;
    const asked = brief.entries.some((e) => e.type === 'user');
    if (!s || !asked || brief.job?.state === 'running' || brief.job?.state === 'queued') setAttached(true);
    else setAttached(false);
  }, [attached, brief.status, brief.session, brief.entries, brief.job]);

  // Every view of the session (a refetch, a save's answer, a fill) merges into the form (briefSessionModel.mergeView).
  const appliedFill = useRef(0);
  const [marks, setMarks] = useState<{ seq: number; glow: BriefField[]; assets: string[]; formats: string[] } | null>(null);
  useEffect(() => {
    const s = brief.session;
    if (!s || attached !== true) return;
    const fill = brief.lastFill && brief.lastFill.seq > appliedFill.current ? brief.lastFill : null;
    if (fill) appliedFill.current = fill.seq;
    const before = snap.current;
    const m = mergeView({ form: before, userEdited: owned.current, agentFields, pending: pendingEdits() }, s, fill?.reclaimed ?? []);
    for (const f of fill?.reclaimed ?? []) dirty.current.delete(f);
    applyForm(m.form, m.changed);
    setUserEdited(m.userEdited);
    setAgentFields(m.agentFields);
    revision.current = s.revision;
    if (fill) {
      const lit = [...fill.written, ...fill.reclaimed].filter((f) => m.taken.includes(f));
      setMarks({
        seq: fill.seq, glow: lit.filter((f) => f !== 'assets' && f !== 'formats'),
        assets: lit.includes('assets') ? m.form.assets.filter((a) => !before.assets.includes(a)) : [],
        formats: lit.includes('formats') ? m.form.formats.filter((x) => !before.formats.includes(x)) : [],
      });
    }
  }, [brief.session, attached]); // eslint-disable-line react-hooks/exhaustive-deps -- a new view (with its fill) is the trigger

  /** Puts the session's values of `fields` into the form's own controls. */
  function applyForm(f: BriefForm, fields: readonly BriefField[]) {
    for (const k of fields) {
      if (k === 'goal') setGoal(f.goal);
      else if (k === 'message') setMessage(f.message);
      else if (k === 'notes') { setNotes(f.notes); if (f.notes) setOptions(true); }
      else if (k === 'durationSec') { const l = lengthOf(f.durationSec); setLength(l.length); setCustomSec(l.customSec); setLengthError(false); }
      else if (k === 'assets') setPicked(f.assets);
      else if (k === 'linkedCodebases') { setCodebases(f.linkedCodebases); if (f.linkedCodebases.length) setOptions(true); }
      else if (k === 'formats') { setSelected(f.formats); if (f.formats.length) setFormatError(false); }
      else if (k === 'variants') setVariantsChoice(f.variants);
    }
    if (fields.includes('goal') && f.goal.trim()) setGoalError(false);
  }

  // The fill's marks, once the fields are on screen: the glow on what the agent wrote, the tile spring on new tiles (90 ms apart).
  useEffect(() => {
    if (!marks || !root.current) return;
    const at = root.current;
    const box: Partial<Record<BriefField, Element | null>> = {
      goal: goalBox.current, message: at.querySelector('#ms-nc-msg'), durationSec: at.querySelector('.ms-nc-len'), notes: at.querySelector('#ms-nc-notes'),
      linkedCodebases: at.querySelector('[data-brief-field="linkedCodebases"]'), variants: at.querySelector('.ms-nc-variants'),
    };
    for (const f of marks.glow) void glow(box[f] ?? null);
    const byData = (attr: 'asset' | 'format', v: string) => [...at.querySelectorAll<HTMLElement>(`[data-${attr}]`)].find((el) => el.dataset[attr] === v) ?? null;
    const tiles = [...marks.assets.map((a) => byData('asset', a)), ...marks.formats.map((id) => byData('format', id))];
    tiles.forEach((el, i) => void tileIn(el, i * 90));
  }, [marks]); // eslint-disable-line react-hooks/exhaustive-deps

  const briefBusy = brief.job?.state === 'queued' || brief.job?.state === 'running';
  // A session the agent is working on reopens in "Con l'agente" (decision 1422).
  const reopened = useRef(false);
  useEffect(() => {
    if (attached === true && !reopened.current && brief.session && briefBusy) { reopened.current = true; setMode('agent'); }
  }, [attached, brief.session, briefBusy]);
  /** "Fallo compilare all'agente": opens the panel; the goal's text moves into the composer (decision 1422), not owned. */
  const toAgent = () => {
    setMode('agent');
    if (!goal.trim()) { focusComposer(); return; }
    setDraft((d) => ({ text: goal.trim(), nonce: (d?.nonce ?? 0) + 1 }));
    setGoal('');
    dirty.current.delete('goal');
    setUserEdited((s) => { if (!s.has('goal')) return s; const next = new Set(s); next.delete('goal'); return next; });
    focusComposer();
    void clearGoal();
  };
  /**
   * The emptied goal is saved, not owned (decision 1422), so the next view of the session does not bring the old text back. The
   * core takes a value only for a field it knows as the user's: a goal the agent owns is first saved as the user's (empty), then
   * handed back.
   */
  const clearGoal = async () => {
    const s = brief.session;
    if (!s || attached !== true || !s.form.goal) return;
    const without = () => [...owned.current].filter((f) => f !== 'goal');
    let base = revision.current;
    if (!s.userEdited.includes('goal')) {
      const first = await brief.saveNow(() => ({ form: { ...snap.current, goal: '' }, userEdited: [...without(), 'goal'], baseRevision: base }));
      if (!first) return;
      base = first.revision;
    }
    await brief.saveNow(() => ({ form: { ...snap.current, goal: '' }, userEdited: without(), baseRevision: base }));
  };
  /** The composer of the panel takes the focus once the panel is open (it is inert while closed). */
  const focusComposer = () => { setTimeout(() => panelEl.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus(), 0); };
  const resume = () => { setAttached(true); setMode('agent'); };
  const startOver = async () => {
    try { await brief.discard(); } catch (e) { setError(errText(e)); return; }
    setAttached(true);
    setMode('you');
  };
  const panelSnapshot = useCallback(() => ({ form: snap.current, userEdited: [...owned.current], baseRevision: revision.current }), []);

  /** "Agente" beside a field's label while the field is the agent's. */
  const agentMark = (f: BriefField) => (agentFields.has(f) ? <Pill tone="accent" className="ms-nc-agentmark">{t.web.briefSession.agentMark}</Pill> : null);

  return (
    <div className={cx('ms-nc', mode === 'agent' && 'ms-nc-agent')} ref={root}>
      {bar?.end ? createPortal(
        <Segmented className="ms-nc-mode" label={t.web.briefSession.modeLabel} value={mode} onChange={(v) => (v === 'agent' ? setMode('agent') : setMode('you'))}
          options={[{ value: 'you', label: t.web.briefSession.modeYou }, { value: 'agent', label: t.web.briefSession.modeAgent, icon: 'sparkle' }]} />,
        bar.end,
      ) : null}
      <BriefSessionPanel slug={slug} projectName={projectName} brief={brief} live={live ?? shell?.live} snapshot={panelSnapshot} draft={draft}
        library={library} onRetryLibrary={() => { setLibrary({ value: null, error: null }); setLibraryNonce((x) => x + 1); }} onLibraryChanged={() => setLibraryNonce((x) => x + 1)}
        hidden={mode !== 'agent'} panelRef={panelEl} className="ms-nc-panel" onOpenCreative={(c) => go(href.creative(slug, c))} />
      <div className="ms-nc-form" ref={formArea}>
      <div className="ms-nc-body">
        <div className="ms-nc-left">
          <section className="ms-nc-sec ms-nc-brief" data-enter>
            <div className="ms-nc-qrow"><label htmlFor="ms-nc-goal" className="ms-nc-q">{n.goalQuestion}</label>{agentMark('goal')}</div>
            <div ref={goalBox} className={cx('ms-nc-goalbox', goalError && 'ms-invalid')}>
              <textarea
                id="ms-nc-goal" ref={goalRef} rows={4} maxLength={GOAL_MAX} value={goal} placeholder={n.goalPlaceholder}
                aria-invalid={goalError || undefined} aria-describedby={goalError ? 'ms-nc-goal-err' : undefined}
                onChange={(e) => { edited('goal'); setGoal(e.target.value); if (e.target.value.trim()) setGoalError(false); }}
              />
              <div className="ms-nc-goalbar">
                {hasBrand ? <Chip className="ms-nc-kit"><span className="ms-nc-mono" aria-hidden="true">{initials(projectName)}</span>{n.brandKit}</Chip> : null}
                {picked.length > 0 ? (
                  <Chip className="ms-nc-kit">
                    <AssetFace slug={slug} path={picked[0]!} entry={entryOf(picked[0]!)} small />
                    {n.assetCount({ count: picked.length })}
                  </Chip>
                ) : null}
                <Button size="sm" variant="ghost" icon aria-label={n.addAssets} title={n.addAssets} onClick={(e) => openPicker(e.currentTarget)}><Icon name="plus" size={14} /></Button>
                {mode === 'you' ? (
                  <button type="button" className="ms-chip ms-nc-cta" onClick={toAgent}><Icon name="sparkle" size={13} fill />{t.web.briefSession.cta}</button>
                ) : null}
                <span className="ms-nc-count">{n.goalCount({ n: goal.length, max: GOAL_MAX })}</span>
              </div>
            </div>
            {goalError ? <p id="ms-nc-goal-err" className="ms-nc-err"><Icon name="warn" size={13} />{n.goalRequired}</p> : null}
            {goal.trim() ? (
              <p className="ms-nc-title"><span>{n.title}:</span> <b>{title}</b> <span className="ms-nc-faint">· {n.titleHint}</span></p>
            ) : null}
            <div className="ms-nc-try">
              <span className="ms-nc-faint">{n.tryLabel}</span>
              {SUGGESTIONS.map((k) => <Chip key={k} onClick={() => suggest(k)}>{n.suggestions[k].label}</Chip>)}
            </div>
          </section>

          <section className="ms-nc-sec" data-enter>
            <div className="ms-nc-qrow"><label className="ms-nc-lbl" htmlFor="ms-nc-msg">{n.keyMessage} <span className="ms-nc-faint">{n.keyMessageHint}</span></label>{agentMark('message')}</div>
            <Input id="ms-nc-msg" className="ms-nc-msg" value={message} onChange={(e) => { edited('message'); setMessage(e.target.value); }} />
          </section>

          <div className={cx('ms-nc-sec', videos.length === 0 && 'ms-nc-off')} data-enter>
            <div className="ms-nc-row">
              <span className="ms-nc-qrow"><span className="ms-nc-lbl">{n.videoLength}</span>{agentMark('durationSec')}</span>
              <span id="ms-nc-len-why" className="ms-nc-faint ms-nc-small">{videos.length ? n.lengthFor({ count: videos.length }) : n.noVideo}</span>
            </div>
            <Segmented
              className="ms-nc-len"
              label={n.videoLength}
              disabled={videos.length === 0}
              describedBy="ms-nc-len-why"
              value={length}
              onChange={(v) => { edited('durationSec'); setLength(v); setLengthError(false); }}
              options={LENGTHS.map((v) => ({ value: v, label: v === 'custom' ? n.custom : n.secondsShort({ n: Number(v) }) }))}
            />
            {length === 'custom' && videos.length > 0 ? (
              <Input
                className="ms-nc-custom" inputMode="numeric" aria-label={n.customSeconds} placeholder={n.customSeconds} value={customSec}
                aria-invalid={lengthError || undefined}
                onChange={(e) => { edited('durationSec'); setCustomSec(e.target.value.replace(/\D/g, '').slice(0, 3)); setLengthError(false); }}
              />
            ) : null}
            {lengthError ? <p className="ms-nc-err"><Icon name="warn" size={13} />{n.customInvalid}</p> : null}
            {statedOther !== null ? (
              <p className="ms-nc-note ms-nc-stated" role="status">
                <Icon name="clock" size={13} />
                <span>{durationValid ? n.durationMismatch({ stated: statedOther, current: durationSec }) : n.durationMismatchUnset({ stated: statedOther })}</span>
                <Button size="sm" variant="outline" onClick={() => applyStated(statedOther)}>{n.durationUse({ n: statedOther })}</Button>
              </p>
            ) : null}
            {tooLong && tooLong.maxDurationSec ? (
              <p className="ms-nc-note"><Icon name="clock" size={13} />{n.overMax({ label: formatLabel(tooLong, locale), max: maxLengthNote(tooLong.maxDurationSec) })}</p>
            ) : null}
          </div>

          <section className="ms-nc-sec" data-enter>
            <div className="ms-nc-row">
              <span className="ms-nc-qrow"><span className="ms-nc-lbl" id="ms-nc-assets-lbl">{n.assetsToUse}</span>{agentMark('assets')}</span>
              <Button size="sm" variant="ghost" className="ms-nc-browse" onClick={(e) => openPicker(e.currentTarget)}>{n.browse}</Button>
            </div>
            <div className="ms-nc-assets" role="list" aria-labelledby="ms-nc-assets-lbl">
              {picked.map((path) => (
                <div role="listitem" key={path} className="ms-nc-asset-item" data-asset={path}>
                  <button type="button" className="ms-nc-asset ms-on" aria-label={n.removeAsset({ name: baseName(path) })} title={n.removeAsset({ name: baseName(path) })} onClick={() => togglePicked(path)}>
                    <AssetFace slug={slug} path={path} entry={entryOf(path)} />
                    <span className="ms-nc-tick" aria-hidden="true"><Icon name="check" size={10} strokeWidth={2.4} /></span>
                  </button>
                </div>
              ))}
              <div role="listitem" className="ms-nc-asset-item">
                <button type="button" className="ms-nc-asset ms-nc-add" aria-label={n.addAssets} onClick={(e) => openPicker(e.currentTarget)}><Icon name="plus" size={16} /></button>
              </div>
            </div>
            <span className="ms-nc-faint ms-nc-small">{n.brandAuto}</span>
          </section>

          <section className="ms-nc-sec" data-enter>
            {brand.value === null && brand.error === null ? null : hasBrand && kit ? (
              <div className="ms-nc-brand">
                <div className="ms-nc-swatches" aria-hidden="true">
                  {kit.colors.slice(0, 4).map((c) => <span key={c.id} style={{ background: c.hex }} />)}
                </div>
                <div className="ms-nc-brand-text">
                  <b>{n.followsBrand({ project: projectName })}</b>
                  {brandLine ? <span className="ms-nc-ell" title={brandLine}>{brandLine}</span> : null}
                </div>
                {/* Information only: the brief has no brand field, so there is no switch (it returns when there is). */}
                <a className="ms-link ms-nc-editbrand" href={href.project(slug, 'brand')}>{n.editBrand}</a>
              </div>
            ) : (
              <div className="ms-nc-brand ms-nc-nobrand">
                <span className="ms-nc-brand-icon" aria-hidden="true"><Icon name="drop" size={14} /></span>
                <div className="ms-nc-brand-text">
                  <b>{brand.error ? n.brandFailed({ detail: brand.error }) : n.noBrand}</b>
                  <span className="ms-nc-wrap">{n.noBrandBody}</span>
                </div>
                <Button size="sm" variant="outline" onClick={() => go(href.project(slug, 'brand'))}>{n.setUpBrand}</Button>
              </div>
            )}
          </section>

          {identityOn ? (
            <section className="ms-nc-sec" data-enter>
              <IdentityStart value={{ ...identityNow, concepts: variantCount }} onChange={(v) => { setIdentity(v); if (v.concepts !== undefined && v.concepts !== variantCount) { edited('variants'); setVariantsChoice(v.concepts); } }} hasBrandLogo={hasBrandLogo} fromCodebase={primaryLogoOf(kit?.logos ?? [])?.source.kind === 'codebase'}
                withConcepts />
            </section>
          ) : null}

          {coreGroup ? (variantCount >= 2 ? (
            <section className="ms-nc-sec" data-enter><VariantsField count={variantCount} directions={directions} onDirections={setDirections} /></section>
          ) : null) : (
            <section className="ms-nc-sec" data-enter><VariantsField count={variantCount} onCount={(v) => { edited('variants'); setVariantsChoice(v); }} directions={directions} onDirections={setDirections} /></section>
          )}

          <section className="ms-nc-sec ms-nc-options" data-enter>
            <button type="button" className="ms-nc-disclose" aria-expanded={options} aria-controls="ms-nc-options" onClick={() => setOptions((o) => !o)}>
              <Icon name={options ? 'chevron' : 'forward'} size={13} />{n.moreOptions}
            </button>
            {options ? (
              <div id="ms-nc-options" className="ms-nc-options-body">
                <div className="ms-nc-qrow"><label className="ms-nc-lbl" htmlFor="ms-nc-notes">{n.notesForAgent} <span className="ms-nc-faint">{n.optional}</span></label>{agentMark('notes')}</div>
                <Input id="ms-nc-notes" value={notes} onChange={(e) => { edited('notes'); setNotes(e.target.value); }} />
                <div className="ms-nc-qrow"><span className="ms-nc-lbl">{n.codebases} <span className="ms-nc-faint">{n.codebasesHint}</span></span>{agentMark('linkedCodebases')}</div>
                <div data-brief-field="linkedCodebases"><CodebaseList value={codebases} onChange={(v) => { edited('linkedCodebases'); setCodebases(v); }} /></div>
                <span className="ms-nc-lbl">{t.web.services.title} <span className="ms-nc-faint">{t.web.services.hint}</span></span>
                <ServicesSelector value={services} configured={configured} checks={keyChecks} onChange={setServices} />
              </div>
            ) : null}
          </section>
        </div>

        <div className="ms-nc-right">
          <div className="ms-nc-boardhead" ref={boardHead}>
            <div className="ms-nc-qrow ms-nc-boardtitle"><h2>{n.whereTo}</h2>{agentMark('formats')}</div>
            <div className="ms-grow" />
            <Segmented
              className="ms-nc-kind"
              label={n.formatKind}
              value={kind}
              onChange={setKind}
              options={[
                { value: 'all', label: n.kindAll },
                { value: 'video', label: n.kindVideo, icon: 'video' },
                { value: 'image', label: n.kindImage, icon: 'image' },
              ]}
            />
            <label className="ms-nc-search">
              <Icon name="search" size={14} />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={n.searchFormats} aria-label={n.searchFormats} />
            </label>
          </div>

          {catalog.warning ? <p className="ms-nc-alert" role="status"><Icon name="warn" size={14} /><span>{catalog.warning}</span></p> : null}
          {catalog.error ? (
            <div className="ms-nc-alert" role="alert">
              <Icon name="warn" size={14} /><span>{n.formatsFailed({ detail: catalog.error })}</span>
              <Button size="sm" variant="outline" onClick={() => { setCatalog({ value: null, error: null, warning: null }); setCatalogNonce((x) => x + 1); }}>{n.tryAgain}</Button>
            </div>
          ) : null}
          {catalog.value === null && !catalog.error ? (
            <div className="ms-nc-group" aria-busy="true">
              <span className="ms-sr" role="status">{n.formatsLoading}</span>
              <div className="ms-nc-tiles">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="ms-nc-tile ms-nc-skel" aria-hidden="true" />)}</div>
            </div>
          ) : null}

          {catalog.value !== null && visibleGroups.length === 0 ? (
            <Empty icon="search" title={n.noMatch} sub={n.noMatchBody} action={<Button size="sm" variant="outline" onClick={() => { setQuery(''); setKind('all'); }}>{n.showAllFormats}</Button>} />
          ) : null}

          {/* Channel groups flow on one six-column grid (as on the board): a short group shares its row with the next. */}
          {visibleGroups.length ? <div className="ms-nc-groups">{visibleGroups.map(({ g, items }) => {
            const count = items.filter((p) => selected.includes(p.id)).length;
            const name = channelName(g, locale);
            return (
              <div key={g} className="ms-nc-group" role="group" aria-label={name} data-enter style={{ '--cols': Math.min(items.length + (packIn(g) ? 1 : 0), TILE_COLUMNS) } as CSSProperties}>
                <div className="ms-nc-ghead">
                  <ChannelMark channel={channelOf(g)} size={20} />
                  <b className="ms-nc-ell">{name}</b>
                  {count ? <span className="ms-nc-faint ms-nc-small">{n.selectedCount({ n: count })}</span> : null}
                </div>
                <div className="ms-nc-tiles">
                  {packIn(g) ? <PackTile pack={pack} onOpen={() => setPackOpen(true)} onRemove={() => setPack(null)} /> : null}
                  {items.map((p) => (
                    <Tile key={p.id} preset={p} on={selected.includes(p.id)} onClick={() => toggle(p.id)}
                      link={selected.includes(p.id) && plan.candidates[p.id] ? { primary: presetLabel(plan.candidates[p.id]!), on: !linkOff.has(p.id), onToggle: () => toggleLink(p.id) } : null}
                      blocked={selected.includes(p.id) && plan.blocked[p.id] ? { primary: presetLabel(plan.blocked[p.id]!.primary), reason: t.errors.followReason[plan.blocked[p.id]!.reason] } : null} />
                  ))}
                </div>
              </div>
            );
          })}</div> : null}

          {catalog.value !== null && hiddenGroups.length > 0 ? (
            <div className="ms-nc-more" data-enter>
              <span className="ms-nc-lbl ms-nc-muted">{n.moreChannels}</span>
              <div className="ms-nc-more-list">
                {hiddenGroups.map((g) => (
                  <Button key={g} variant="outline" className="ms-nc-chbtn" onClick={() => setMore((m) => new Set([...m, g]))}>
                    <ChannelMark channel={channelOf(g)} size={20} />
                    <span className="ms-nc-ell">{channelName(g, locale)}</span>
                    <span className="ms-nc-faint ms-nc-small">{presets.filter((p) => p.channel === g).length}</span>
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Above the bar, not inside it: a long error keeps its remedy in full. */}
      <div className="ms-nc-errbar">
        {error ? (
          <div className="ms-nc-ferr" role="alert">
            <Icon name="warn" size={14} /><span>{n.createFailed({ detail: error })}</span>
            {brief.conflict?.code === 'brief-session-handed-off' ? <ConflictActions brief={brief} onOpen={(c) => go(href.creative(slug, c))} onDone={() => setError(null)} /> : null}
          </div>
        ) : null}
        {brief.status === 'failed' ? (
          <div className="ms-nc-ferr" role="alert">
            <Icon name="warn" size={14} /><span>{t.web.briefSession.loadFailed({ detail: brief.error ?? '' })}</span>
            <Button size="sm" variant="outline" onClick={() => void brief.refresh()}>{n.tryAgain}</Button>
          </div>
        ) : null}
      </div>
      <footer className="ms-nc-foot">
        <div className="ms-nc-frames" aria-hidden="true">
          {chosen.slice(0, SUMMARY_FRAMES).map((p) => {
            const h = 40;
            const w = Math.max(14, Math.min(64, Math.round((h * p.width) / p.height)));
            return <span key={p.id} style={{ width: w, height: Math.min(h, Math.round((w * p.height) / p.width)) }} />;
          })}
        </div>
        <div className="ms-nc-sum">
          {chosen.length + packExtra ? (
            <b>{n.summary({ formats: handPicked.length + packExtra, videos: allVideos, images: allImages })}</b>
          ) : (
            <b className={cx(formatError && 'ms-nc-warn')}>{n.pickFormat}</b>
          )}
          <span className="ms-nc-muted ms-nc-small">{n.summaryHint}</span>
          {similar ? <span className="ms-nc-muted ms-nc-small ms-nc-estimate">{n.similar({ range: similar })}</span> : null}
        </div>
        <div className="ms-grow" />
        <Button size="lg" variant="ghost" loading={busy === 'draft'} disabled={busy !== null || identityPending || briefBusy} title={briefBusy ? t.web.briefSession.agentWorking : undefined} onClick={() => void submit(false)}>{n.saveDraft}</Button>
        <Button size="lg" variant="accent" aria-label={n.generate} loading={busy === 'generate'} disabled={busy !== null || identityPending || briefBusy} title={briefBusy ? t.web.briefSession.agentWorking : undefined} onClick={() => void submit(true)}>
          <Icon name="sparkle" size={14} />{n.generate}<kbd className="ms-nc-kbd" aria-hidden="true">{isMac() ? '⌘↵' : 'Ctrl ↵'}</kbd>
        </Button>
      </footer>
      </div>

      <ResumeBriefDialog open={attached === false} onResume={resume} onStartOver={() => void startOver()} />

      <StorePackWizard open={packOpen} onClose={() => setPackOpen(false)} slug={slug} {...(pack ? { initial: pack } : {})} onConfirm={(p) => { setPack(p); setFormatError(false); }} />

      <LibraryPicker slug={slug} projectName={projectName} open={pickerOpen} onClose={() => setPickerOpen(false)} anchor={pickerAnchor} library={library}
        onRetry={() => { setLibrary({ value: null, error: null }); setLibraryNonce((x) => x + 1); }} chosen={picked} onToggle={togglePicked} />
    </div>
  );
}

/**
 * Decision 1423: a session half moved into a creative (`brief-session-handed-off`, with or without the creative's name): open
 * that creative when the core names it, or discard the session.
 */
export function ConflictActions({ brief, onOpen, onDone }: { brief: ReturnType<typeof useBriefSession>; onOpen(creative: string): void; onDone?(): void }) {
  const b = useT().web.briefSession;
  const to = brief.session?.handedOffTo;
  return (
    <span className="ms-nc-conflict">
      {to ? <Button size="sm" variant="outline" onClick={() => onOpen(to)}>{b.openCreative}</Button> : null}
      <Button size="sm" variant="ghost" onClick={() => void brief.discard().then(() => onDone?.(), () => {})}>{b.discard}</Button>
    </span>
  );
}

/**
 * The store pack as an entry of the board (Phase 14): a tile that opens the wizard in a dialog; once set it is selected, a click
 * edits it, and a sibling button takes it out.
 */
function PackTile({ pack, onOpen, onRemove }: { pack: StorePack | null; onOpen(): void; onRemove(): void }) {
  const s = useT().web.storePack;
  const text = pack ? s.entryOn({ count: pack.screenshots.length }) : s.entryHint;
  return (
    <div className="ms-nc-tile-wrap">
      <button type="button" className={cx('ms-nc-tile', pack && 'ms-on')} aria-pressed={pack !== null} title={text}
        aria-label={pack ? s.entryAria({ count: pack.screenshots.length }) : s.entryAdd} onClick={onOpen}>
        <span className="ms-nc-tile-top">
          <span className="ms-nc-frame" aria-hidden="true"><Icon name="image" size={12} /></span>
        </span>
        <span className="ms-nc-tile-text">
          <b className="ms-nc-ell">{s.entryTitle}</b>
          <span className="ms-nc-tile-meta ms-nc-ell">{text}</span>
        </span>
        {pack ? <span className="ms-nc-tick" aria-hidden="true"><Icon name="check" size={10} strokeWidth={2.4} /></span> : null}
      </button>
      {pack ? (
        <button type="button" className="ms-nc-link ms-nc-pack-remove" aria-label={s.entryRemoveAria} title={s.entryRemoveAria} onClick={onRemove}><Icon name="close" size={13} /></button>
      ) : null}
    </div>
  );
}

/**
 * One format of the board (prototype Tile): drawn proportion with the kind icon, name, ratio and maximum length. A chosen
 * format that can share an earlier one's file has a link toggle (`link`, a sibling of the tile button, never inside it);
 * one of the same size that cannot says why (`blocked`).
 */
function Tile({ preset: p, on, onClick, link, blocked }: {
  preset: FormatPreset; on: boolean; onClick(): void;
  link: { primary: string; on: boolean; onToggle(): void } | null;
  blocked: { primary: string; reason: string } | null;
}) {
  const t = useT();
  const n = t.web.newCreative;
  const locale = useLocale();
  const ref = useRef<HTMLButtonElement>(null);
  const first = useRef(true);
  // T13: the tile answers the click with a small spring.
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    void anim(ref.current, [{ transform: 'scale(.96)' }, { transform: 'scale(1)' }], 260, E.spring);
  }, [on]);
  const h = 48;
  const w = Math.max(18, Math.min(56, Math.round((h * p.width) / p.height)));
  const fh = Math.min(h, Math.round((w * p.height) / p.width));
  const video = p.kind === 'video';
  const note = p.maxDurationSec !== undefined ? maxLengthNote(p.maxDurationSec) : video ? t.web.formatUi.video : t.web.formatUi.image;
  const label = formatLabel(p, locale);
  const why = blocked ? n.notLinkable(blocked) : null;
  return (
    <div className="ms-nc-tile-wrap" data-format={p.id}>
      <button ref={ref} type="button" className={cx('ms-nc-tile', on && 'ms-on')} aria-pressed={on} onClick={onClick} title={`${p.width}×${p.height}`}>
        <span className="ms-nc-tile-top">
          <span className="ms-nc-frame" style={{ width: w, height: fh }} aria-hidden="true">
            <Icon name={video ? 'play' : 'image'} size={video ? 10 : 12} fill={video} />
          </span>
        </span>
        <span className="ms-nc-tile-text">
          <b className="ms-nc-ell">{formatName(p, locale)}</b>
          <span className="ms-nc-tile-meta ms-nc-ell">{ratioLabel(p.width, p.height)} · {note}</span>
        </span>
        {on ? <span className="ms-nc-tick" aria-hidden="true"><Icon name="check" size={10} strokeWidth={2.4} /></span> : null}
      </button>
      {link ? (
        <button type="button" className={cx('ms-nc-link', link.on && 'ms-on')} aria-pressed={link.on}
          aria-label={n.linkToggle({ label, primary: link.primary })} title={link.on ? n.linkOn({ primary: link.primary }) : n.linkOff({ primary: link.primary })}
          onClick={link.onToggle}>
          <Icon name="link" size={13} />
        </button>
      ) : why ? (
        <span className="ms-nc-link ms-nc-link-no" role="img" aria-label={why} title={why}><Icon name="link" size={13} /></span>
      ) : null}
    </div>
  );
}
