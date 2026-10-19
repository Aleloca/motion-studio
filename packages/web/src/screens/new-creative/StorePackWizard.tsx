// The "App store pack" wizard (Phase 12, spec §4.1), a dialog opened from the formats list (Phase 14: New creative and the brief). Five steps: the app, the stores and
// devices (the required device of a store is locked on), the screenshots (a count within the bounds of the chosen stores, a
// caption and an app screen from the library each), the preview video, and the review. The draft lives in the wizard, so going
// back and forth between steps (the step list or Back / Next, all reachable with the keyboard) never loses it. The core builds the
// brief from the choices and checks every app screen; its refusal is shown as it is.
import {
  APPSTORE_DEVICES, PLAYSTORE_DEVICES, STORE_CAPTION_MAX, STORE_SCREENSHOTS, storePackFormats, storePackSchema,
  type StoreId, type StorePack,
} from '@motion-studio/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../../api.ts';
import { useT } from '../../i18n.tsx';
import { href } from '../../routes.ts';
import { go } from '../../shell/ShellContext.tsx';
import { Button, ChannelMark, Check, Icon, Input, Modal, NumberField, Segmented, cx, toast } from '../../ui/index.ts';
import { message } from '../common.tsx';
import { ScreenPicker } from './ScreenPicker.tsx';
import './storepack.css';

type AppstoreDevice = (typeof APPSTORE_DEVICES)[number];
type PlaystoreDevice = (typeof PLAYSTORE_DEVICES)[number];
/** `noScreen`: the user chose, explicitly, to have no app screen for this row (Ruling P); `screen` is then null. */
export interface Shot { caption: string; screen: string | null; noScreen?: boolean }
export interface PackDraft {
  name: string;
  tagline: string;
  stores: StoreId[];
  /** The chosen devices of each store (only those of a chosen store go into the pack). */
  devices: { appstore: AppstoreDevice[]; playstore: PlaystoreDevice[] };
  count: number;
  shots: Shot[];
  preview: boolean;
}

const STEPS = ['app', 'stores', 'screens', 'preview', 'review'] as const;
type Step = (typeof STEPS)[number];
const STORES: readonly StoreId[] = ['appstore', 'playstore'];
const REQUIRED = { appstore: 'iphone-69', playstore: 'phone' } as const;
const DEVICE_KEY = { 'iphone-69': 'iphone69', 'ipad-13': 'ipad13', phone: 'phone', tablet: 'tablet', feature: 'feature' } as const;

/** Screenshots a store accepts; with both stores, the narrower range (the core applies the same rule). */
export function storeBounds(stores: readonly StoreId[]): { min: number; max: number } {
  if (stores.length === 0) return { min: 1, max: 10 };
  return {
    min: Math.max(...stores.map((s) => STORE_SCREENSHOTS[s].min)),
    max: Math.min(...stores.map((s) => STORE_SCREENSHOTS[s].max)),
  };
}

const clamp = (n: number, { min, max }: { min: number; max: number }) => Math.min(max, Math.max(min, n));

/** The pack the draft stands for: only the devices of the chosen stores, the first `count` screenshots, trimmed texts. */
export function buildStorePack(d: PackDraft): StorePack {
  const devices: StorePack['devices'] = {};
  if (d.stores.includes('appstore')) devices.appstore = APPSTORE_DEVICES.filter((x) => d.devices.appstore.includes(x));
  if (d.stores.includes('playstore')) devices.playstore = PLAYSTORE_DEVICES.filter((x) => d.devices.playstore.includes(x));
  return {
    app: { name: d.name.trim(), tagline: d.tagline.trim() },
    stores: STORES.filter((s) => d.stores.includes(s)),
    devices,
    screenshots: d.shots.slice(0, d.count).map((s) => ({ caption: s.caption.trim(), screen: s.screen })),
    preview: d.preview,
  };
}

const blankShots = () => Array.from({ length: STORE_SCREENSHOTS.appstore.max }, (): Shot => ({ caption: '', screen: null, noScreen: false }));
const decided = (x: Shot) => x.screen !== null || x.noScreen === true;
const baseName = (path: string) => path.split('/').pop() ?? path;

/** The draft a pack stands for (the inverse of `buildStorePack`): a pack to edit fills the wizard with its values. */
export function draftOfPack(p: StorePack): PackDraft {
  const shots = blankShots().map((blank, i): Shot => {
    const x = p.screenshots[i];
    return x ? { caption: x.caption, screen: x.screen, noScreen: x.screen === null } : blank;
  });
  return {
    name: p.app.name, tagline: p.app.tagline, stores: [...p.stores],
    devices: { appstore: [...(p.devices.appstore ?? ['iphone-69'])], playstore: [...(p.devices.playstore ?? ['phone'])] },
    count: p.screenshots.length, shots, preview: p.preview,
  };
}

export interface StorePackWizardProps {
  open: boolean; onClose(): void; slug: string;
  /** A pack to edit: the wizard starts with its values (Phase 14). */
  initial?: StorePack;
  /**
   * Phase 14: the pack is handed over (to add to a formats list or to update the creative's) instead of creating a creative
   * with it. The wizard stays open, busy, until the promise settles; a refusal is shown in the dialog.
   */
  onConfirm?(pack: StorePack): void | Promise<void>;
}

export function StorePackWizard(p: StorePackWizardProps) {
  const t = useT();
  const s = t.web.storePack;
  // Closing with something typed asks first (Esc, the scrim, Close and Cancel all come here); the draft lives in Body.
  const dirty = useRef(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (!p.open) setConfirm(false); }, [p.open]);
  const request = () => { if (dirty.current) setConfirm(true); else p.onClose(); };
  return (
    <>
      <Modal open={p.open} onClose={request} label={s.title} width={760}>
        {p.open ? <Body slug={p.slug} onClose={request} onDone={p.onClose} dirty={dirty} {...(p.initial ? { initial: p.initial } : {})} {...(p.onConfirm ? { onConfirm: p.onConfirm } : {})} /> : null}
      </Modal>
      <Modal open={p.open && confirm} onClose={() => setConfirm(false)} label={s.closeTitle} width={420}>
        <div className="ms-spw-close">
          <h2>{s.closeTitle}</h2>
          <p>{s.closeBody}</p>
          <div className="ms-spw-close-actions">
            <Button variant="outline" onClick={() => setConfirm(false)}>{s.keepEditing}</Button>
            <Button variant="ink" onClick={() => { setConfirm(false); p.onClose(); }}>{s.discard}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function Body({ onClose, onDone, slug, dirty, initial, onConfirm }: { onClose(): void; onDone(): void; slug: string; dirty: { current: boolean }; initial?: StorePack; onConfirm?: StorePackWizardProps['onConfirm'] }) {
  const t = useT();
  const s = t.web.storePack;
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<PackDraft>(() => (initial ? draftOfPack(initial) : {
    name: '', tagline: '', stores: ['appstore'], devices: { appstore: ['iphone-69'], playstore: ['phone'] }, count: 3, shots: blankShots(), preview: false,
  }));
  const [picking, setPicking] = useState<number | null>(null);
  const [busy, setBusy] = useState<'generate' | 'draft' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const inFlight = useRef(false);
  const nameId = useId();
  const taglineId = useId();
  const hintId = useId();

  // Editing a pack: closing asks only if something changed from it.
  dirty.current = initial
    ? JSON.stringify(buildStorePack({ ...draft, count: clamp(draft.count, storeBounds(draft.stores)) })) !== JSON.stringify(initial)
    : draft.name.trim() !== '' || draft.tagline.trim() !== '' || draft.shots.some((x) => x.caption.trim() !== '' || decided(x));
  const set = (patch: Partial<PackDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const bounds = storeBounds(draft.stores);
  const count = clamp(draft.count, bounds);
  const shots = draft.shots.slice(0, count);
  const storeName = (id: StoreId) => (id === 'appstore' ? t.variants.storePack.appStore : t.variants.storePack.googlePlay);

  const valid: Record<Step, boolean> = {
    app: draft.name.trim() !== '',
    stores: draft.stores.length > 0,
    screens: shots.every((x) => decided(x)),
    preview: true,
    review: true,
  };
  // A step can be opened when every step before it is done.
  const undecided = shots.flatMap((x, i) => (decided(x) ? [] : [i + 1]));
  const reachable = (i: number) => STEPS.slice(0, i).every((k) => valid[k]);
  const goTo = (i: number) => { if (reachable(i)) setStep(i); };
  const current = STEPS[step]!;

  // After a step change the heading takes focus, so the keyboard continues from the new step (not on arrival).
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    heading.current?.focus();
  }, [step]);

  const toggleStore = (id: StoreId, on: boolean) => set({ stores: on ? STORES.filter((x) => x === id || draft.stores.includes(x)) : draft.stores.filter((x) => x !== id) });
  const toggleDevice = (store: StoreId, device: string, on: boolean) => {
    if (store === 'appstore') {
      const d = device as AppstoreDevice;
      set({ devices: { ...draft.devices, appstore: on ? [...draft.devices.appstore, d] : draft.devices.appstore.filter((x) => x !== d) } });
    } else {
      const d = device as PlaystoreDevice;
      set({ devices: { ...draft.devices, playstore: on ? [...draft.devices.playstore, d] : draft.devices.playstore.filter((x) => x !== d) } });
    }
  };
  const setShot = (i: number, patch: Partial<Shot>) => set({ shots: draft.shots.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  const pack = buildStorePack({ ...draft, count });
  const title = s.creativeTitle({ name: pack.app.name });
  const submit = async (generate: boolean) => {
    if (inFlight.current) return;
    const parsed = storePackSchema.safeParse(pack);
    if (!parsed.success) { setError(s.createFailed({ detail: parsed.error.issues.map((i) => i.message).join('; ') })); return; }
    inFlight.current = true;
    setBusy(generate ? 'generate' : 'draft');
    setError(null);
    try {
      if (onConfirm) {
        // The pack goes to the caller (the formats list); no creative is made here.
        await onConfirm(parsed.data);
        onDone();
        return;
      }
      const created = await api.createStorePack(slug, { title, storePack: parsed.data, generate });
      if (generate) go(href.creative(slug, created.slug));
      else {
        toast.show(s.draftSaved({ title }), { tone: 'ok', action: { label: t.web.newCreative.open, run: () => go(href.creative(slug, created.slug)) } });
        go(href.project(slug));
      }
      onDone();
      // Success: stay busy; the page is leaving.
    } catch (e) {
      inFlight.current = false;
      setBusy(null);
      setError(onConfirm ? s.saveFailed({ detail: message(e) }) : s.createFailed({ detail: message(e) }));
    }
  };

  const devicesOf = (store: StoreId): readonly string[] => (store === 'appstore' ? APPSTORE_DEVICES : PLAYSTORE_DEVICES);
  const chosenOf = (store: StoreId): readonly string[] => (store === 'appstore' ? draft.devices.appstore : draft.devices.playstore);

  return (
    <div className="ms-spw">
      <header className="ms-spw-head">
        <div className="ms-spw-titles">
          <h2>{s.title}</h2>
          <span className="ms-spw-sub">{s.stepOf({ n: step + 1, total: STEPS.length, name: s.steps[current] })}</span>
        </div>
        <Button variant="ghost" icon aria-label={t.common.close} disabled={busy !== null} onClick={onClose}><Icon name="close" size={13} strokeWidth={1.6} /></Button>
      </header>
      <ol className="ms-spw-steps" aria-label={s.stepsLabel}>
        {STEPS.map((k, i) => (
          <li key={k}>
            <button type="button" className={cx('ms-spw-step', i === step && 'ms-on', i < step && 'ms-done')} aria-current={i === step ? 'step' : undefined}
              disabled={busy !== null || !reachable(i)} onClick={() => goTo(i)}>
              <span className="ms-spw-num" aria-hidden="true">{i < step && valid[k] ? <Icon name="check" size={10} strokeWidth={2.4} /> : i + 1}</span>
              <span>{s.steps[k]}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="ms-spw-body">
        <h3 className="ms-spw-h" ref={heading} tabIndex={-1}>{s.steps[current]}</h3>

        {current === 'app' ? (
          <div className="ms-spw-fields">
            <label className="ms-spw-lbl" htmlFor={nameId}>{s.appName}</label>
            <Input id={nameId} value={draft.name} maxLength={60} onChange={(e) => set({ name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' && valid.app) { e.preventDefault(); setStep(1); } }} />
            <label className="ms-spw-lbl" htmlFor={taglineId}>{s.tagline} <span className="ms-spw-faint">{s.taglineHint}</span></label>
            <Input id={taglineId} value={draft.tagline} maxLength={120} onChange={(e) => set({ tagline: e.target.value })} />
          </div>
        ) : null}

        {current === 'stores' ? (
          <div className="ms-spw-stores">
            <div role="group" aria-label={s.stores} className="ms-spw-storelist">
              {STORES.map((id) => (
                <label key={id} className="ms-spw-store">
                  <Check on={draft.stores.includes(id)} label={storeName(id)} onChange={(v) => toggleStore(id, v)} />
                  <ChannelMark channel={id === 'appstore' ? 'appstore' : 'googleplay'} size={20} />
                  <span>{storeName(id)}</span>
                </label>
              ))}
            </div>
            {draft.stores.length === 0 ? <p className="ms-spw-err" id={hintId}><Icon name="warn" size={13} />{s.oneStore}</p> : null}
            {STORES.filter((id) => draft.stores.includes(id)).map((id) => (
              <div key={id} role="group" aria-label={s.devicesFor({ store: storeName(id) })} className="ms-spw-devices">
                <span className="ms-spw-cap">{s.devicesFor({ store: storeName(id) })}</span>
                {devicesOf(id).map((dev) => {
                  const required = dev === REQUIRED[id];
                  const name = s.devices[DEVICE_KEY[dev as keyof typeof DEVICE_KEY]];
                  return (
                    <label key={dev} className="ms-spw-device">
                      <Check on={required || chosenOf(id).includes(dev)} label={name} disabled={required} onChange={(v) => toggleDevice(id, dev, v)} />
                      <span>{name}</span>
                      <span className="ms-spw-faint">{required ? s.required : s.optional}</span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        ) : null}

        {current === 'screens' ? (
          <div className="ms-spw-screens">
            <div className="ms-spw-count">
              <NumberField label={s.count} value={count} min={bounds.min} max={bounds.max} decimals={0} onChange={(n) => set({ count: n })} />
              <span className="ms-spw-faint">{s.countRange(bounds)}</span>
            </div>
            <p className="ms-spw-faint">{s.captionHint}</p>
            {undecided.length > 0 ? <p className="ms-spw-err" role="status"><Icon name="warn" size={13} />{s.screenMissing({ list: undecided.join(', ') })}</p> : null}
            <ol className="ms-spw-shots">
              {shots.map((shot, i) => (
                <li key={i} className={cx('ms-spw-shot', shot.noScreen && 'ms-nos')}>
                  <span className="ms-spw-n" aria-hidden="true">{i + 1}</span>
                  <Input aria-label={s.captionOf({ n: i + 1 })} placeholder={s.caption} value={shot.caption} maxLength={STORE_CAPTION_MAX}
                    title={shot.caption || undefined} onChange={(e) => setShot(i, { caption: e.target.value })} />
                  <div className="ms-spw-screen">
                    {shot.screen ? (
                      <>
                        <img className="ms-spw-thumb" src={api.projectFileUrl(slug, shot.screen)} alt="" />
                        <span className="ms-spw-file" title={shot.screen}>{baseName(shot.screen)}</span>
                        <Button size="sm" variant="outline" aria-label={s.chooseScreen({ n: i + 1 })} onClick={() => setPicking(i)}>{s.changeScreen}</Button>
                        <Button size="sm" variant="ghost" icon aria-label={s.removeScreen({ n: i + 1 })} onClick={() => setShot(i, { screen: null })}><Icon name="close" size={12} /></Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" aria-label={s.chooseScreen({ n: i + 1 })} onClick={() => setPicking(i)}><Icon name="image" size={13} />{s.screen}</Button>
                    )}
                    <Button size="sm" variant={shot.noScreen ? 'ink' : 'ghost'} aria-pressed={shot.noScreen === true} aria-label={s.noScreenOf({ n: i + 1 })}
                      onClick={() => setShot(i, shot.noScreen ? { noScreen: false } : { noScreen: true, screen: null })}>{s.noScreenChoice}</Button>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {current === 'preview' ? (
          <div className="ms-spw-fields">
            <span className="ms-spw-lbl" id={hintId}>{s.previewQuestion}</span>
            <Segmented label={s.previewQuestion} value={draft.preview ? 'yes' : 'no'} onChange={(v) => set({ preview: v === 'yes' })}
              options={[{ value: 'yes', label: s.previewYes }, { value: 'no', label: s.previewNo }]} />
            <p className="ms-spw-faint">{s.previewHint}</p>
          </div>
        ) : null}

        {current === 'review' ? (
          <dl className="ms-spw-review">
            <dt>{s.reviewApp}</dt>
            <dd><b>{pack.app.name}</b>{pack.app.tagline ? <span className="ms-spw-faint"> · {pack.app.tagline}</span> : null}</dd>
            <dt>{s.reviewStores}</dt>
            <dd className="ms-spw-marks">{pack.stores.map((id) => <span key={id}><ChannelMark channel={id === 'appstore' ? 'appstore' : 'googleplay'} />{storeName(id)}</span>)}</dd>
            <dt>{s.reviewDevices}</dt>
            <dd>
              {pack.stores.map((id) => (
                <div key={id}>{storeName(id)}: {(pack.devices[id] ?? []).map((dev) => s.devices[DEVICE_KEY[dev as keyof typeof DEVICE_KEY]]).join(', ')}</div>
              ))}
            </dd>
            <dt>{s.reviewShots}</dt>
            <dd>
              <ol className="ms-spw-rshots">
                {pack.screenshots.map((x, i) => (
                  <li key={i}><span>{i + 1} · {x.caption || s.reviewFromBrief}</span> <span className="ms-spw-faint">{x.screen ? baseName(x.screen) : s.reviewNoScreen}</span></li>
                ))}
              </ol>
            </dd>
            {pack.screenshots.some((x) => x.screen === null) ? (
              <>
                <dt>{s.noScreenChoice}</dt>
                <dd>{s.reviewNoScreenRows({ list: pack.screenshots.flatMap((x, i) => (x.screen === null ? [i + 1] : [])).join(', ') })}</dd>
              </>
            ) : null}
            <dt>{s.reviewPreview}</dt>
            <dd>{pack.preview ? s.yes : s.no}</dd>
          </dl>
        ) : null}
      </div>

      <footer className="ms-spw-foot">
        {current === 'review' ? <b className="ms-spw-count-line">{s.reviewFormats({ count: storePackFormats(pack).formats.length })}</b> : <span />}
        <div className="ms-spw-actions">
          <Button variant="ghost" disabled={busy !== null} onClick={onClose}>{t.common.cancel}</Button>
          {step > 0 ? <Button variant="outline" disabled={busy !== null} onClick={() => setStep(step - 1)}>{s.back}</Button> : null}
          {current === 'review' && onConfirm ? (
            <Button variant="accent" loading={busy !== null} disabled={busy !== null} onClick={() => void submit(true)}>{initial ? s.confirmUpdate : s.confirmAdd}</Button>
          ) : current === 'review' ? (
            <>
              <Button variant="outline" loading={busy === 'draft'} disabled={busy !== null} onClick={() => void submit(false)}>{s.saveDraft}</Button>
              <Button variant="accent" loading={busy === 'generate'} disabled={busy !== null} onClick={() => void submit(true)}><Icon name="sparkle" size={14} />{s.generate}</Button>
            </>
          ) : (
            <Button variant="ink" disabled={!valid[current]} onClick={() => setStep(step + 1)}>{s.next}</Button>
          )}
        </div>
        {error ? <p className="ms-spw-ferr" role="alert"><Icon name="warn" size={14} /><span>{error}</span></p> : null}
      </footer>

      <ScreenPicker open={picking !== null} onClose={() => setPicking(null)} slug={slug}
        onPick={(path) => { if (picking !== null) setShot(picking, { screen: path, noScreen: false }); setPicking(null); }} />
    </div>
  );
}
