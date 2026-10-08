// Brand page sections that edit the visual kit: colors, typography and logos.
import type { BrandColor, BrandFont, BrandLogo } from '@motion-studio/shared';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../api.ts';
import { useT } from '../i18n.tsx';
import { enter } from '../motion/index.ts';
import { Button, Chip, cx, Field, Icon, Input, Popover, Segmented, Select, Spinner, Tag, toast } from '../ui/index.ts';
import { specimenFamily, useFontPreview } from './brandFonts.ts';
import { hasLogoFor, MANUAL, nextId, normalizeFamily, normalizeHex, parseWeights, ratioText, stageColor, swatchText } from './brandModel.ts';
import { TYPING_MS } from './brandSave.ts';
import { useBrand, useAppear, removeWithUndo } from './brandContext.tsx';
/* ---------- colors ---------- */

const COLOR_ROLES: Array<BrandColor['role']> = ['primary', 'secondary', 'accent', 'background', 'text', 'other'];

export function Colors() {
  const t = useT();
  const b = t.web.brand;
  const { kit, locked, saver } = useBrand();
  const [fresh, setFresh] = useState<string | null>(null);
  const add = () => {
    const id = nextId('color', kit.colors.map((c) => c.id));
    saver.edit((k) => ({ ...k, colors: [...k.colors, { id, name: b.colors.newName, hex: '#A3A3A3', role: 'other', source: MANUAL }] })); // color-data: neutral grey for a new swatch
    setFresh(id);
  };
  return (
    <section data-sec="colors" className="ms-bsection" aria-labelledby="ms-bcolors" data-enter>
      <div className="ms-bsection-head">
        <h2 id="ms-bcolors">{b.nav.colors}</h2>
        {kit.colors.length ? <span className="ms-faint">{b.colors.hint}</span> : null}
        <Button variant="ghost" size="sm" className="ms-blink" disabled={locked} onClick={add}>{b.colors.add}</Button>
      </div>
      {kit.colors.length ? (
        <div className="ms-bswatches">
          {kit.colors.map((c) => <Swatch key={c.id} c={c} autoOpen={fresh === c.id} />)}
        </div>
      ) : <p className="ms-bempty-line">{b.colors.empty}</p>}
    </section>
  );
}

function Swatch({ c, autoOpen }: { c: BrandColor; autoOpen: boolean }) {
  const t = useT();
  const b = t.web.brand;
  const { kit, locked, saver } = useBrand();
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(autoOpen);
  const [name, setName] = useState(c.name);
  const [hex, setHex] = useState(c.hex.slice(1));
  useAppear(wrap);
  // Keep the fields in step with the kit while closed (an Undo, a reload).
  useEffect(() => { if (!open) { setName(c.name); setHex(c.hex.slice(1)); } }, [c.name, c.hex, open]);
  const text = swatchText(c.hex, kit.colors);
  const update = (patch: Partial<BrandColor>, wait = 0) =>
    saver.edit((k) => ({ ...k, colors: k.colors.map((x) => (x.id === c.id ? { ...x, ...patch, source: MANUAL } : x)) }), wait);
  const close = () => { setOpen(false); saver.flush(); };
  const hexOk = normalizeHex(hex) !== null;
  const remove = () => {
    setOpen(false);
    const index = kit.colors.findIndex((x) => x.id === c.id);
    void removeWithUndo(wrap.current, () => {
      saver.edit((k) => ({ ...k, colors: k.colors.filter((x) => x.id !== c.id) }));
      toast.show(b.colors.removed({ name: c.name }), {
        action: { label: b.undo, run: () => saver.edit((k) => (k.colors.some((x) => x.id === c.id) ? k : { ...k, colors: [...k.colors.slice(0, index), c, ...k.colors.slice(index)] })) },
      });
    });
  };
  return (
    <div className="ms-bswatch-wrap" ref={wrap}>
      <button ref={btn} type="button" className={cx('ms-bswatch', open && 'ms-on')} aria-label={b.colors.edit({ name: c.name })} aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <span className="ms-bswatch-color" style={{ background: c.hex }}>
          <span className="ms-bswatch-aa" style={{ color: text.color }} title={b.colors.contrast({ ratio: ratioText(text.ratio), name: text.name ?? text.color })}>{`Aa ${ratioText(text.ratio)}`}</span>
        </span>
        <span className="ms-bswatch-meta">
          <b>{c.name}</b>
          <span className="ms-mono">{c.hex.slice(1)}</span>
          <span className="ms-faint">{t.web.labels.colorRoles[c.role]}</span>
        </span>
      </button>
      <Popover open={open} onClose={close} anchor={btn} width={250}>
        <div className="ms-bpop">
          <span className="ms-cap">{b.colors.popTitle}</span>
          <label className="ms-bpop-field">
            <span>{b.colors.name}</span>
            <Input value={name} disabled={locked} aria-label={b.colors.name} aria-invalid={!name.trim() || undefined}
              onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) update({ name: e.target.value.trim() }, TYPING_MS); }} />
          </label>
          <div className="ms-bpop-field">
            <span>{b.colors.hex}</span>
            <div className="ms-bhex">
              <span className="ms-bhex-chip" style={{ background: normalizeHex(hex) ?? c.hex }} aria-hidden="true" />
              <Field prefix="#" className="ms-grow">
                <input value={hex} maxLength={7} disabled={locked} aria-label={b.colors.hex} aria-invalid={!hexOk || undefined} spellCheck={false}
                  onChange={(e) => { const v = e.target.value.replace(/[^0-9a-fA-F#]/g, '').replace(/^#/, '').toUpperCase(); setHex(v); const n = normalizeHex(v); if (n) update({ hex: n }, TYPING_MS); }} />
              </Field>
            </div>
            {!hexOk ? <small className="ms-bwarn">{b.colors.hexInvalid}</small> : null}
          </div>
          <div className="ms-bpop-field">
            <span>{b.colors.role}</span>
            <div className="ms-bchips">
              {COLOR_ROLES.map((r) => <Chip key={r} on={c.role === r} onClick={locked ? undefined : () => update({ role: r })}>{t.web.labels.colorRoles[r]}</Chip>)}
            </div>
          </div>
          <Button variant="danger" size="sm" disabled={locked} onClick={remove}><Icon name="trash" size={13} />{b.colors.remove}</Button>
        </div>
      </Popover>
    </div>
  );
}

/* ---------- typography ---------- */

export function Typography() {
  const t = useT();
  const b = t.web.brand;
  const { kit, locked, saver } = useBrand();
  const [fresh, setFresh] = useState<string | null>(null);
  const add = () => {
    const id = nextId('font', kit.fonts.map((f) => f.id));
    saver.edit((k) => ({ ...k, fonts: [...k.fonts, { id, family: b.fonts.newFamily, role: 'body', weights: [400], file: null, source: MANUAL }] }));
    setFresh(id);
  };
  return (
    <section data-sec="type" className="ms-bsection" aria-labelledby="ms-btype" data-enter>
      <div className="ms-bsection-head">
        <h2 id="ms-btype">{b.nav.type}</h2>
        <span className="ms-faint">{b.fonts.hint}</span>
        <Button variant="ghost" size="sm" className="ms-blink" disabled={locked} onClick={add}>{b.fonts.add}</Button>
      </div>
      {kit.fonts.length ? (
        <div className="ms-bfonts">{kit.fonts.map((f) => <FontCard key={f.id} f={f} autoOpen={fresh === f.id} />)}</div>
      ) : <p className="ms-bempty-line">{b.fonts.empty}</p>}
    </section>
  );
}

function FontCard({ f, autoOpen }: { f: BrandFont; autoOpen: boolean }) {
  const t = useT();
  const b = t.web.brand;
  const { slug } = useBrand();
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(autoOpen);
  useAppear(wrap);
  const preview = useFontPreview(f.file ? api.projectFileUrl(slug, f.file) : null);
  const family = specimenFamily(preview);
  return (
    <div className="ms-card ms-bfont" ref={wrap}>
      <div className="ms-bfont-top">
        <Tag>{t.web.labels.fontRoles[f.role]}</Tag>
        {f.file ? <span className="ms-bok">{b.fonts.inProject}</span> : <span className="ms-bwarn">{b.fonts.noFile}</span>}
      </div>
      <span className="ms-bfont-specimen" style={{ fontFamily: family }}>{b.fonts.specimen}</span>
      <span className="ms-bfont-sample" style={{ fontFamily: family }}>{b.fonts.sample}</span>
      {preview.state === 'none' ? <span className="ms-bnote">{b.fonts.noPreview}</span> : null}
      {preview.state === 'failed' ? <span className="ms-bnote">{b.fonts.loadFailed}</span> : null}
      <div className="ms-bfont-foot">
        <b className="ms-ell">{f.family}</b>
        <span className="ms-mono ms-muted">{f.weights.join(' · ')}</span>
        <button ref={btn} type="button" className="ms-blink-btn" aria-label={b.fonts.edit({ family: f.family })} aria-expanded={open} onClick={() => setOpen(!open)}>{t.web.brand.voice.edit}</button>
      </div>
      <FontEditor f={f} open={open} onClose={() => setOpen(false)} anchor={btn} wrap={wrap} />
    </div>
  );
}

function FontEditor({ f, open, onClose, anchor, wrap }: { f: BrandFont; open: boolean; onClose(): void; anchor: RefObject<HTMLButtonElement | null>; wrap: RefObject<HTMLDivElement | null> }) {
  const t = useT();
  const b = t.web.brand;
  const { kit, locked, saver, assets } = useBrand();
  const [family, setFamily] = useState(f.family);
  const [weights, setWeights] = useState(f.weights.join(', '));
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (!open) { setFamily(f.family); setWeights(f.weights.join(', ')); setNote(null); } }, [open, f.family, f.weights]);
  const update = (patch: Partial<BrandFont>) => saver.edit((k) => ({ ...k, fonts: k.fonts.map((x) => (x.id === f.id ? { ...x, ...patch, source: MANUAL } : x)) }));
  // Point 15: a pasted CSS stack keeps only its first family, and says so.
  const commitFamily = () => {
    const raw = family.trim();
    const first = normalizeFamily(raw);
    if (!first) return;
    setNote(first !== raw ? b.fonts.familyNormalized({ family: first }) : null);
    setFamily(first);
    if (first !== f.family) update({ family: first });
  };
  const commitWeights = () => {
    const w = parseWeights(weights);
    if (w && w.join() !== f.weights.join()) update({ weights: w });
    setWeights((w ?? f.weights).join(', '));
  };
  const close = () => { commitFamily(); commitWeights(); onClose(); };
  const fontAssets = assets.filter((a) => a.kind === 'font');
  const fileOptions = [{ value: '', label: b.fonts.noFileOption }, ...fontAssets.map((a) => ({ value: `assets/${a.file}`, label: a.file }))];
  if (f.file && !fileOptions.some((o) => o.value === f.file)) fileOptions.push({ value: f.file, label: f.file });
  const remove = () => {
    onClose();
    const index = kit.fonts.findIndex((x) => x.id === f.id);
    void removeWithUndo(wrap.current, () => {
      saver.edit((k) => ({ ...k, fonts: k.fonts.filter((x) => x.id !== f.id) }));
      toast.show(b.fonts.removed({ family: f.family }), {
        action: { label: b.undo, run: () => saver.edit((k) => (k.fonts.some((x) => x.id === f.id) ? k : { ...k, fonts: [...k.fonts.slice(0, index), f, ...k.fonts.slice(index)] })) },
      });
    });
  };
  return (
    <Popover open={open} onClose={close} anchor={anchor} width={280} placement="bottom-end">
      <form className="ms-bpop" onSubmit={(e) => { e.preventDefault(); commitFamily(); commitWeights(); }}>
        <span className="ms-cap">{b.fonts.popTitle}</span>
        <label className="ms-bpop-field">
          <span>{b.fonts.family}</span>
          <Input value={family} disabled={locked} aria-label={b.fonts.family} aria-invalid={!family.trim() || undefined} onChange={(e) => { setFamily(e.target.value); setNote(null); }} onBlur={commitFamily} />
          {!family.trim() ? <small className="ms-bwarn">{b.fonts.familyRequired}</small> : note ? <small className="ms-bnote" role="status">{note}</small> : null}
        </label>
        <div className="ms-bpop-field">
          <span>{b.fonts.role}</span>
          <Select disabled={locked} value={f.role} label={b.fonts.role} onChange={(role) => update({ role })} options={(Object.keys(t.web.labels.fontRoles) as Array<BrandFont['role']>).map((r) => ({ value: r, label: t.web.labels.fontRoles[r] }))} />
        </div>
        <label className="ms-bpop-field">
          <span>{b.fonts.weights}</span>
          <Input value={weights} disabled={locked} aria-label={b.fonts.weights} placeholder={b.fonts.weightsHint} onChange={(e) => setWeights(e.target.value)} onBlur={commitWeights} />
        </label>
        <div className="ms-bpop-field">
          <span>{b.fonts.file}</span>
          <Select disabled={locked} value={f.file ?? ''} label={b.fonts.file} onChange={(file) => update({ file: file || null })} options={fileOptions} />
          {!fontAssets.length ? <small className="ms-bnote">{b.fonts.noFontAssets}</small> : null}
        </div>
        <Button variant="danger" size="sm" disabled={locked} onClick={remove}><Icon name="trash" size={13} />{b.fonts.remove}</Button>
      </form>
    </Popover>
  );
}

/* ---------- logos ---------- */

export function Logos({ uploading }: { uploading: boolean }) {
  const t = useT();
  const b = t.web.brand;
  const { kit, locked, upload } = useBrand();
  const addBtn = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const missing: Array<'light' | 'dark'> = (['light', 'dark'] as const).filter((bg) => !hasLogoFor(kit, bg));
  return (
    <section data-sec="logos" className="ms-bsection" aria-labelledby="ms-blogos" data-enter>
      <div className="ms-bsection-head">
        <h2 id="ms-blogos">{b.nav.logos}</h2>
        {uploading ? <span className="ms-faint ms-brow"><Spinner decorative size={12} />{b.logos.uploading}</span> : null}
        <Button ref={addBtn} variant="ghost" size="sm" className="ms-blink" disabled={locked} aria-expanded={adding} onClick={() => setAdding(!adding)}>{b.logos.add}</Button>
        <AssetPicker open={adding} onClose={() => setAdding(false)} anchor={addBtn} background="any" />
      </div>
      <div className="ms-blogos">
        {kit.logos.map((l) => <LogoCard key={l.id} l={l} />)}
        {missing.map((bg) => <MissingLogo key={bg} bg={bg} disabled={locked || uploading} onUpload={() => upload(bg)} />)}
      </div>
    </section>
  );
}

function MissingLogo({ bg, disabled, onUpload }: { bg: 'light' | 'dark'; disabled: boolean; onUpload(): void }) {
  const t = useT();
  const b = t.web.brand;
  const pick = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  return (
    <div className="ms-blogo-missing">
      <b>{bg === 'light' ? b.logos.missingLight : b.logos.missingDark}</b>
      <span>{bg === 'light' ? b.logos.missingLightSub : b.logos.missingDarkSub}</span>
      <span className="ms-brow">
        {/* The API has no way to ask the brand agent for one: the action is the upload (ruling). */}
        <Button size="sm" variant="outline" disabled={disabled} onClick={onUpload}><Icon name="upload" size={13} />{b.logos.uploadLogo}</Button>
        <Button ref={pick} size="sm" variant="ghost" disabled={disabled} aria-expanded={picking} onClick={() => setPicking(!picking)}>{b.logos.fromAssets}</Button>
      </span>
      <AssetPicker open={picking} onClose={() => setPicking(false)} anchor={pick} background={bg} />
    </div>
  );
}

/** "+ Add logo" / "From Assets": upload a file or pick an image already in Assets. */
function AssetPicker({ open, onClose, anchor, background }: { open: boolean; onClose(): void; anchor: RefObject<HTMLButtonElement | null>; background: BrandLogo['background'] }) {
  const t = useT();
  const b = t.web.brand;
  const { slug, kit, assets, upload, addLogoFromAsset } = useBrand();
  const images = assets.filter((a) => (a.kind === 'image' || a.kind === 'svg') && !kit.logos.some((l) => l.file === `assets/${a.file}`));
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} width={280} placement="bottom-end">
      <div className="ms-bpop ms-bpicker">
        <button type="button" className="ms-bmenu-row" data-row onClick={() => { onClose(); upload(background); }}><Icon name="upload" size={14} />{b.logos.upload}</button>
        <span className="ms-cap">{b.logos.fromAssets}</span>
        {images.length ? (
          <div className="ms-bpicker-list">
            {images.map((a) => (
              <button key={a.file} type="button" className="ms-bmenu-row" data-row onClick={() => { onClose(); addLogoFromAsset(`assets/${a.file}`, background); }}>
                <img src={api.projectFileUrl(slug, `assets/${a.file}`)} alt="" />
                <span className="ms-ell">{a.file}</span>
              </button>
            ))}
          </div>
        ) : <span className="ms-bnote">{b.logos.noAssets}</span>}
      </div>
    </Popover>
  );
}

function LogoCard({ l }: { l: BrandLogo }) {
  const t = useT();
  const b = t.web.brand;
  const { slug, kit, locked, saver } = useBrand();
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useAppear(wrap);
  const stage = stageColor(l.background === 'dark' ? 'dark' : 'light', kit.colors);
  const update = (patch: Partial<BrandLogo>) => saver.edit((k) => ({ ...k, logos: k.logos.map((x) => (x.id === l.id ? { ...x, ...patch, source: MANUAL } : x)) }));
  const remove = () => {
    setOpen(false);
    const index = kit.logos.findIndex((x) => x.id === l.id);
    void removeWithUndo(wrap.current, () => {
      saver.edit((k) => ({ ...k, logos: k.logos.filter((x) => x.id !== l.id) }));
      toast.show(b.logos.removed, {
        action: { label: b.undo, run: () => saver.edit((k) => (k.logos.some((x) => x.id === l.id) ? k : { ...k, logos: [...k.logos.slice(0, index), l, ...k.logos.slice(index)] })) },
      });
    });
  };
  const bgLabel = l.background === 'light' ? b.logos.onLight : l.background === 'dark' ? b.logos.onDark : b.logos.onAny;
  return (
    <div className="ms-card ms-blogo" ref={wrap}>
      <button ref={btn} type="button" className={cx('ms-blogo-stage', `ms-bg-${l.background}`)} style={stage ? { background: stage } : undefined}
        aria-label={b.logos.edit({ file: l.file })} aria-expanded={open} onClick={() => setOpen(!open)}>
        <img src={api.projectFileUrl(slug, l.file)} alt={b.logos.alt({ file: l.file })} />
      </button>
      <div className="ms-blogo-meta">
        <span className="ms-brow"><b>{t.web.labels.logoVariants[l.variant]}</b><Tag>{bgLabel}</Tag></span>
        <span className="ms-mono ms-faint ms-ell" title={l.file}>{l.file}</span>
      </div>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} width={260}>
        <div className="ms-bpop">
          <span className="ms-cap">{b.logos.popTitle}</span>
          <div className="ms-bpop-field">
            <span>{b.logos.variant}</span>
            <Select disabled={locked} value={l.variant} label={b.logos.variant} onChange={(variant) => update({ variant })}
              options={(Object.keys(t.web.labels.logoVariants) as Array<BrandLogo['variant']>).map((v) => ({ value: v, label: t.web.labels.logoVariants[v] }))} />
          </div>
          <div className="ms-bpop-field">
            <span>{b.logos.background}</span>
            <Segmented value={l.background} label={b.logos.background} disabled={locked} onChange={(background) => update({ background })}
              options={(['light', 'dark', 'any'] as const).map((v) => ({ value: v, label: t.web.labels.logoBackgrounds[v] }))} />
          </div>
          <Button variant="danger" size="sm" disabled={locked} onClick={remove}><Icon name="trash" size={13} />{b.logos.remove}</Button>
        </div>
      </Popover>
    </div>
  );
}
