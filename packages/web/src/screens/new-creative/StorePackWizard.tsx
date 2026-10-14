// The "App store pack" wizard (Phase 12, spec §4.1), opened from the New creative screen. Five steps: the app, the stores and
// devices (the required device of a store is locked on), the screenshots (a count within the bounds of the chosen stores, a
// caption and an app screen from the library each), the preview video, and the review. The draft lives in the wizard, so going
// back and forth between steps (the step list or Back / Next, all reachable with the keyboard) never loses it. The core builds the
// brief from the choices and checks every app screen; its refusal is shown as it is.
import {
  APPSTORE_DEVICES, PLAYSTORE_DEVICES, STORE_SCREENSHOTS, storePackFormats, storePackSchema,
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
export interface Shot { caption: string; screen: string | null }
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

const blankShots = () => Array.from({ length: STORE_SCREENSHOTS.appstore.max }, (): Shot => ({ caption: '', screen: null }));
const baseName = (path: string) => path.split('/').pop() ?? path;

export interface StorePackWizardProps { open: boolean; onClose(): void; slug: string }

export function StorePackWizard(p: StorePackWizardProps) {
  const t = useT();
  return (
    <Modal open={p.open} onClose={p.onClose} label={t.web.storePack.title} width={760}>
      {p.open ? <Body {...p} /> : null}
    </Modal>
  );
}

function Body({ onClose, slug }: StorePackWizardProps) {
  const t = useT();
  const s = t.web.storePack;
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<PackDraft>({
    name: '', tagline: '', stores: ['appstore'], devices: { appstore: ['iphone-69'], playstore: ['phone'] }, count: 3, shots: blankShots(), preview: false,
  });
  const [picking, setPicking] = useState<number | null>(null);
  const [busy, setBusy] = useState<'generate' | 'draft' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const inFlight = useRef(false);
  const nameId = useId();
  const taglineId = useId();
  const hintId = useId();

  const set = (patch: Partial<PackDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const bounds = storeBounds(draft.stores);
  const count = clamp(draft.count, bounds);
  const shots = draft.shots.slice(0, count);
  const storeName = (id: StoreId) => (id === 'appstore' ? t.variants.storePack.appStore : t.variants.storePack.googlePlay);

  const valid: Record<Step, boolean> = {
    app: draft.name.trim() !== '',
    stores: draft.stores.length > 0,
    screens: shots.every((x) => x.caption.trim() !== ''),
    preview: true,
    review: true,
  };
  // A step can be opened when every step before it is done.
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
      const created = await api.createStorePack(slug, { title, storePack: parsed.data, generate });
      if (generate) go(href.creative(slug, created.slug));
      else {
        toast.show(s.draftSaved({ title }), { tone: 'ok', action: { label: t.web.newCreative.open, run: () => go(href.creative(slug, created.slug)) } });
        go(href.project(slug));
      }
      onClose();
      // Success: stay busy; the page is leaving.
    } catch (e) {
      inFlight.current = false;
      setBusy(null);
      setError(s.createFailed({ detail: message(e) }));
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
            {!valid.screens ? <p className="ms-spw-err"><Icon name="warn" size={13} />{s.captionRequired}</p> : null}
            <ol className="ms-spw-shots">
              {shots.map((shot, i) => (
                <li key={i} className="ms-spw-shot">
                  <span className="ms-spw-n" aria-hidden="true">{i + 1}</span>
                  <Input aria-label={s.captionOf({ n: i + 1 })} placeholder={s.caption} value={shot.caption} maxLength={80}
                    aria-invalid={shot.caption.trim() === '' || undefined} onChange={(e) => setShot(i, { caption: e.target.value })} />
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
                  <li key={i}><span>{i + 1} · {x.caption}</span> <span className="ms-spw-faint">{x.screen ? baseName(x.screen) : s.reviewNoScreen}</span></li>
                ))}
              </ol>
            </dd>
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
          {current === 'review' ? (
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
        onPick={(path) => { if (picking !== null) setShot(picking, { screen: path }); setPicking(null); }} />
    </div>
  );
}
