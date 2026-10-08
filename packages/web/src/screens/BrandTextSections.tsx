// Brand page sections in words: overview, voice and rules, photo style and guidelines.
import type { BrandNote, BrandOverview, ReferenceEntry } from '@motion-studio/shared';
import { useRef, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { relativeTime, useLocale, useT } from '../i18n.tsx';
import { enter } from '../motion/index.ts';
import { Button, cx, initials, Icon, Input, Markdown, Modal, Textarea, toast } from '../ui/index.ts';
import { MANUAL, nextId, stageColor, websiteHosts } from './brandModel.ts';
import { IMAGE, RULES_SHOWN, useBrand, useAppear, removeWithUndo } from './brandContext.tsx';
/* ---------- overview ---------- */

export function Overview({ overview, projectName }: { overview: BrandOverview; projectName: string | null }) {
  const t = useT();
  const b = t.web.brand;
  const locale = useLocale();
  const { slug, kit } = useBrand();
  const primary = kit.logos.find((l) => l.variant === 'primary') ?? kit.logos[0];
  const stage = primary ? stageColor(primary.background === 'dark' ? 'dark' : 'light', kit.colors) : null;
  const analyzed = overview.sources.map((s) => s.lastAnalyzedAt).filter((x): x is string => Boolean(x)).sort().at(-1);
  const hosts = websiteHosts(overview.sources).join(', ');
  const summary = [...overview.proposals].filter((p) => p.status !== 'discarded' && p.summary.trim()).sort((a, c) => c.createdAt.localeCompare(a.createdAt))[0]?.summary;
  const name = projectName ?? slug;
  return (
    <section data-sec="overview" className="ms-boverview" aria-label={b.nav.overview} data-enter>
      <div className={cx('ms-boverview-tile', !primary && 'ms-initials', primary?.background === 'dark' && !stage && 'ms-dark')} style={stage ? { background: stage } : undefined}>
        {primary ? <img src={api.projectFileUrl(slug, primary.file)} alt={b.logos.alt({ file: primary.file })} /> : <span aria-hidden="true">{initials(name)}</span>}
      </div>
      <div className="ms-boverview-text">
        <h1>{name}</h1>
        <p>{summary ?? b.overview.intro}</p>
        <span className="ms-faint">{analyzed && hosts ? b.overview.learnedFrom({ hosts, when: relativeTime(locale, analyzed) }) : b.overview.notAnalyzed}</span>
      </div>
    </section>
  );
}

/* ---------- voice, photo style, guidelines ---------- */

/** A note of the kit (tone, photo style) shown as text, edited in place. */
function NoteText({ note, field, label, placeholder, empty }: { note: BrandNote | null; field: 'tone' | 'photoStyle'; label: string; placeholder: string; empty: string }) {
  const t = useT();
  const v = t.web.brand.voice;
  const { locked, saver } = useBrand();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const start = () => { setText(note?.text ?? ''); setEditing(true); };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    saver.edit((k) => ({ ...k, [field]: value ? { id: field === 'tone' ? 'tone' : 'photo-style', text: value, source: MANUAL } : null }));
    setEditing(false);
  };
  if (editing) {
    return (
      <form className="ms-bnote-edit" onSubmit={save}>
        <Textarea rows={4} value={text} aria-label={label} placeholder={placeholder} autoFocus onChange={(e) => setText(e.target.value)} />
        <span className="ms-brow">
          <Button type="submit" variant="ink" size="sm">{v.save}</Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>{v.cancel}</Button>
        </span>
      </form>
    );
  }
  return (
    <>
      {note ? <p className="ms-btext">{note.text}</p> : <p className="ms-bempty-line">{empty}</p>}
      <Button variant="ghost" size="sm" className="ms-blink ms-bstart" disabled={locked} onClick={start}>{note ? v.edit : v.write}</Button>
    </>
  );
}

export function Voice() {
  const t = useT();
  const v = t.web.brand.voice;
  const { kit } = useBrand();
  return (
    <section data-sec="voice" className="ms-bvoice" aria-label={t.web.brand.nav.voice} data-enter>
      <div className="ms-card ms-bcard">
        <h2>{t.web.brand.nav.voice}</h2>
        <NoteText note={kit.tone} field="tone" label={v.toneLabel} placeholder={v.placeholder} empty={v.empty} />
      </div>
      <RuleCard kind="dos" />
      <RuleCard kind="donts" />
    </section>
  );
}

function RuleCard({ kind }: { kind: 'dos' | 'donts' }) {
  const t = useT();
  const v = t.web.brand.voice;
  const { kit, locked, saver } = useBrand();
  const items = kit[kind];
  const [more, setMore] = useState(false);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const title = kind === 'dos' ? v.do : v.avoid;
  const add = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    saver.edit((k) => ({ ...k, [kind]: [...k[kind], { id: nextId(kind === 'dos' ? 'do' : 'avoid', k[kind].map((x) => x.id)), text: value, source: MANUAL }] }));
    setText('');
    setAdding(false);
    setMore(true);
  };
  const shown = more ? items : items.slice(0, RULES_SHOWN);
  return (
    <div className="ms-card ms-bcard ms-brules">
      <span className="ms-brules-head">
        <span className={cx('ms-brules-icon', kind === 'dos' ? 'ms-ok' : 'ms-warn')} aria-hidden="true"><Icon name={kind === 'dos' ? 'check' : 'close'} size={9} strokeWidth={2.4} /></span>
        <h3>{title}</h3>
        <span className="ms-faint">{items.length}</span>
      </span>
      {items.length ? (
        <ul className="ms-brules-list" aria-label={title}>
          {shown.map((n, i) => <Rule key={n.id} n={n} kind={kind} first={i === 0} />)}
        </ul>
      ) : <p className="ms-bempty-line">{v.noRules}</p>}
      <span className="ms-brow">
        {items.length > RULES_SHOWN ? <button type="button" className="ms-blink-btn" onClick={() => setMore(!more)}>{more ? v.less : v.more({ count: items.length - RULES_SHOWN })}</button> : null}
        <button type="button" className="ms-blink-btn ms-bpush" disabled={locked} onClick={() => { setAdding(!adding); setText(''); }}>{v.addRule}</button>
      </span>
      {adding ? (
        <form className="ms-brow" onSubmit={add}>
          <Input className="ms-grow ms-bsmall" autoFocus value={text} aria-label={kind === 'dos' ? v.doLabel : v.avoidLabel} placeholder={kind === 'dos' ? v.doPlaceholder : v.avoidPlaceholder} onChange={(e) => setText(e.target.value)} />
          <Button type="submit" variant="ink" size="sm" disabled={!text.trim()}>{v.add}</Button>
        </form>
      ) : null}
    </div>
  );
}

function Rule({ n, kind, first }: { n: BrandNote; kind: 'dos' | 'donts'; first: boolean }) {
  const t = useT();
  const v = t.web.brand.voice;
  const { kit, locked, saver } = useBrand();
  const ref = useRef<HTMLLIElement>(null);
  useAppear(ref);
  const remove = () => {
    const index = kit[kind].findIndex((x) => x.id === n.id);
    void removeWithUndo(ref.current, () => {
      saver.edit((k) => ({ ...k, [kind]: k[kind].filter((x) => x.id !== n.id) }));
      toast.show(v.ruleRemoved, {
        action: { label: t.web.brand.undo, run: () => saver.edit((k) => (k[kind].some((x) => x.id === n.id) ? k : { ...k, [kind]: [...k[kind].slice(0, index), n, ...k[kind].slice(index)] })) },
      });
    });
  };
  return (
    <li ref={ref} className={cx('ms-brule', first && 'ms-first')}>
      <span>{n.text}</span>
      <Button variant="ghost" size="sm" icon className="ms-brule-x" disabled={locked} aria-label={v.removeRule({ text: n.text })} onClick={remove}><Icon name="close" size={11} /></Button>
    </li>
  );
}

export function PhotoStyle({ references }: { references: ReferenceEntry[] }) {
  const t = useT();
  const b = t.web.brand;
  const { slug, kit } = useBrand();
  const images = references.filter((r) => r.useForBrand && IMAGE.test(r.file)).slice(0, 3);
  return (
    <section data-sec="photo" className="ms-card ms-bcard" aria-labelledby="ms-bphoto" data-enter>
      <h2 id="ms-bphoto">{b.nav.photo}</h2>
      <NoteText note={kit.photoStyle} field="photoStyle" label={b.photo.label} placeholder={b.photo.placeholder} empty={b.photo.empty} />
      {images.length ? (
        <div className="ms-bphotos">{images.map((r) => <img key={r.file} src={api.projectFileUrl(slug, `references/${r.file}`)} alt={r.note || r.file} />)}</div>
      ) : null}
    </section>
  );
}

export function Guidelines({ text, onSaved }: { text: string; onSaved(text: string): void }) {
  const t = useT();
  const g = t.web.brand.guidelines;
  const { saver } = useBrand();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const show = (edit: boolean) => { setDraft(text); setEditing(edit); setOpen(true); };
  const save = async () => {
    setBusy(true);
    const ok = await saver.saveGuidelines(draft);
    setBusy(false);
    if (ok) { onSaved(draft); setEditing(false); }
  };
  const changed = editing && draft !== text;
  // Point 36: with an unsaved draft, Esc and the scrim do nothing (dismissible=false); the X and Cancel ask first.
  const [asking, setAsking] = useState<'close' | 'cancel' | null>(null);
  const leave = (how: 'close' | 'cancel') => {
    if (changed) { setAsking(how); return; }
    finish(how);
  };
  const finish = (how: 'close' | 'cancel') => {
    setAsking(null);
    setDraft(text);
    if (how === 'close' || !text.trim()) setOpen(false); else setEditing(false);
  };
  return (
    <section data-sec="guidelines" className="ms-card ms-bcard" aria-labelledby="ms-bguide" data-enter>
      <div className="ms-bsection-head">
        <h2 id="ms-bguide">{t.web.brand.nav.guidelines}</h2>
        {text.trim() ? <Button variant="ghost" size="sm" className="ms-blink" onClick={() => show(false)}>{g.open}</Button> : null}
      </div>
      {text.trim() ? (
        <div className="ms-bguide-preview"><Markdown text={text} headings /></div>
      ) : (
        <>
          <p className="ms-bempty-line">{g.empty}</p>
          <Button size="sm" className="ms-bstart" onClick={() => show(true)}><Icon name="edit" size={13} />{g.write}</Button>
        </>
      )}
      <Modal open={open} onClose={() => setOpen(false)} label={t.web.brand.nav.guidelines} width={760} dismissible={!changed && !busy}>
        <div className="ms-bguide-dialog">
          <div className="ms-bguide-head">
            <h2>{t.web.brand.nav.guidelines}</h2>
            {!editing ? <Button size="sm" onClick={() => { setDraft(text); setEditing(true); }}><Icon name="edit" size={13} />{g.edit}</Button> : null}
            <Button variant="ghost" size="sm" icon aria-label={g.close} disabled={busy} onClick={() => leave('close')}><Icon name="close" size={12} /></Button>
          </div>
          <div className="ms-bguide-body">
            {editing ? <Textarea rows={18} className="ms-mono" value={draft} aria-label={g.label} onChange={(e) => setDraft(e.target.value)} /> : <Markdown text={text} headings />}
          </div>
          {editing && asking ? (
            <div className="ms-bguide-foot ms-bguide-ask" role="group" aria-label={g.discardQ}>
              <span className="ms-bwarn">{g.discardQ}</span>
              <Button variant="ghost" onClick={() => setAsking(null)}>{g.keep}</Button>
              <Button variant="danger" autoFocus onClick={() => finish(asking)}>{g.discard}</Button>
            </div>
          ) : editing ? (
            <div className="ms-bguide-foot">
              <Button variant="ghost" disabled={busy} onClick={() => leave('cancel')}>{g.cancel}</Button>
              <Button variant="ink" loading={busy} disabled={draft === text} onClick={() => void save()}>{g.save}</Button>
            </div>
          ) : null}
        </div>
      </Modal>
    </section>
  );
}
