/* Library: assets (filters, selection, detail, upload with auto description) and references (moodboard). */
(function () {
  const { html, useState, useEffect, useLayoutEffect, useRef, get, set, useStore, motion, Icon, Toggle, Check, Spinner, Typing, toast, wait, now, nav } = MS;
  const { IMG } = MSDATA;
  const updA = (id, fn) => set((s) => ({ assets: s.assets.map((a) => (a.id === id ? fn({ ...a }) : a)) }));

  function Thumb({ a, h = 150 }) {
    if (a.kind === 'font') return html`<div className="col" style=${{ height: h, background: 'var(--field)', alignItems: 'center', justifyContent: 'center', gap: 4 }}><span style=${{ fontFamily: a.css || 'var(--serif)', fontStyle: a.italic ? 'italic' : 'normal', fontSize: 46, lineHeight: 1 }}>Aa</span><span className="muted" style=${{ fontFamily: a.css || 'var(--serif)', fontStyle: a.italic ? 'italic' : 'normal', fontSize: 13 }}>${a.sample}</span></div>`;
    if (a.id === 'a1') return html`<div style=${{ height: h, background: '#1B1913', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 19 }}>HALF STORY</div>`;
    if (a.id === 'a2') return html`<div style=${{ height: h, background: '#F1E6CF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="78" height="78" viewBox="0 0 60 60"><rect x="2" y="2" width="56" height="56" rx="13" fill="#E9D9B8"/><path d="M12 36c6-2 30-2 36 0l-4 4c-8-2-20-2-28 0Z" fill="#2B241A"/><path d="M19 34c0-9 3-17 11-17s11 8 11 17Z" fill="#3A3024"/><path d="M19.5 30c7-1.5 14-1.5 21 0v4h-21Z" fill="#E86808"/><path d="M22 40c2 8 14 8 16 0Z" fill="#2B241A"/></svg></div>`;
    return html`<div style=${{ height: h, background: '#000' }}><img src=${a.img} alt="" style=${{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: a.id === 'a5' ? 'top' : 'center' }} /></div>`;
  }

  function AssetsPage() {
    const assets = useStore((s) => s.assets);
    const [type, setType] = useState('all'); const [origin, setOrigin] = useState(null); const [tag, setTag] = useState(null); const [q, setQ] = useState('');
    const [sel, setSel] = useState(new Set()); const [open, setOpen] = useState('a5'); const [drag, setDrag] = useState(false);
    const root = MS.useEnter([]);
    const shown = assets.filter((a) => (type === 'all' || a.kind === type) && (!origin || a.origin === origin) && (!tag || a.tags.includes(tag)) && (!q || (a.name + ' ' + a.desc + ' ' + a.tags.join(' ')).toLowerCase().includes(q.toLowerCase())));
    const count = (k) => assets.filter((a) => a.kind === k).length;
    const tags = [...new Set(assets.flatMap((a) => a.tags))].filter((t) => t !== 'font').slice(0, 8);
    const toggleSel = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const upload = async () => {
      const id = 'u' + Date.now();
      set((s) => ({ assets: [...s.assets, { id, name: 'calder-map.png', file: 'calder-map.png', kind: 'image', origin: 'uploaded', desc: '', tags: [], size: '2048×1536 · 3.1 MB', img: IMG.r6, describing: true, fresh: true }] }));
      setOpen(id); toast('Uploaded calder-map.png · Claude is describing it');
      await wait(2600);
      updA(id, (a) => ({ ...a, describing: false, name: 'Calder district map', desc: 'Hand-inked map of Calder’s six districts at night, sepia wash with the river in pale umber and one orange marker on the docks.', tags: ['map', 'city', 'sepia', 'districts'] }));
      toast('Calder district map is described and tagged', { tone: 'ok' });
    };
    const remove = (ids) => { const prev = get().assets; set((s) => ({ assets: s.assets.filter((a) => !ids.includes(a.id)) })); setSel(new Set()); if (ids.includes(open)) setOpen(null); toast(`${ids.length} asset${ids.length > 1 ? 's' : ''} deleted`, { action: { label: 'Undo', run: () => set({ assets: prev }) } }); };
    const redescribe = async (ids) => { ids.forEach((id) => updA(id, (a) => ({ ...a, describing: true }))); setSel(new Set()); await wait(2200); ids.forEach((id) => updA(id, (a) => ({ ...a, describing: false }))); toast(`${ids.length} description${ids.length > 1 ? 's' : ''} updated`, { tone: 'ok' }); };
    const detail = assets.find((a) => a.id === open);
    return html`<div ref=${root} style=${{ height: '100%', display: 'grid', gridTemplateColumns: `220px minmax(0,1fr) ${detail ? 360 : 0}px`, transition: 'grid-template-columns var(--d-m) var(--e-out)', position: 'relative' }} onDragOver=${(e) => { e.preventDefault(); setDrag(true); }} onDragLeave=${() => setDrag(false)} onDrop=${(e) => { e.preventDefault(); setDrag(false); upload(); }}>
      <aside className="col scroll" style=${{ borderRight: '1px solid var(--line)', padding: '18px 12px', gap: 18, overflow: 'auto' }}>
        <div className="col" style=${{ gap: 2 }}><span className="cap" style=${{ padding: '0 8px 6px' }}>Type</span>
          ${[['all', 'All', 'grid', assets.length], ['image', 'Images', 'image', count('image')], ['logo', 'Logos', 'list', count('logo')], ['font', 'Fonts', 'text', count('font')], ['video', 'Video', 'video', count('video')]].map(([k, l, ic, n]) => html`<button key=${k} className=${'navitem' + (type === k ? ' on' : '')} style=${{ opacity: n ? 1 : .5 }} onClick=${() => setType(k)}><${Icon} n=${ic} s=${14} />${l}<span className="n">${n}</span></button>`)}</div>
        <div className="col" style=${{ gap: 2 }}><span className="cap" style=${{ padding: '0 8px 6px' }}>Origin</span>
          ${[['website', 'From website'], ['uploaded', 'Uploaded'], ['google', 'Google Fonts'], ['generated', 'Generated']].map(([k, l]) => html`<button key=${k} className=${'navitem' + (origin === k ? ' on' : '')} onClick=${() => setOrigin(origin === k ? null : k)}>${l}<span className="n">${assets.filter((a) => a.origin === k).length}</span></button>`)}</div>
        <div className="col" style=${{ gap: 8 }}><span className="cap" style=${{ padding: '0 8px' }}>Tags</span><div className="row" style=${{ flexWrap: 'wrap', gap: 6, padding: '0 6px' }}>${tags.map((t) => html`<button key=${t} className=${'chip' + (tag === t ? ' on' : '')} onClick=${() => setTag(tag === t ? null : t)}>${t}</button>`)}</div></div>
        <div className="grow"></div>
        <div className="col" style=${{ padding: 10, borderRadius: 10, background: 'var(--field)', gap: 6, fontSize: 12 }}><span className="row" style=${{ justifyContent: 'space-between' }}><span className="muted">Library size</span><b>${(4.9 + (assets.length - 7) * 3.1).toFixed(1)} MB</b></span><div className="bar" style=${{ background: 'var(--line)' }}><i style=${{ width: '9%', background: 'var(--text)' }}></i></div></div>
      </aside>
      <main className="col scroll" style=${{ padding: '18px 22px 90px', gap: 14, overflow: 'auto', minWidth: 0 }}>
        <div className="row" style=${{ gap: 10 }}><h1 style=${{ margin: 0, fontSize: 20, letterSpacing: '-.015em' }}>Assets</h1><span className="muted" style=${{ fontSize: 12 }}>${shown.length} of ${assets.length}${sel.size ? ` · ${sel.size} selected` : ''}</span>${type !== 'all' || origin || tag || q ? html`<button className="btn sm ghost" onClick=${() => { setType('all'); setOrigin(null); setTag(null); setQ(''); }}>Clear filters</button>` : null}<div className="grow"></div>
          <label className="search" style=${{ width: 260 }}><${Icon} n="search" s=${14} /><input value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="Search names, descriptions, tags" aria-label="Search assets" /></label>
          <button className="btn ink" onClick=${upload}><${Icon} n="upload" s=${13} w=${1.7} />Upload</button></div>
        <div style=${{ display: 'grid', gridTemplateColumns: `repeat(${detail ? 3 : 4}, minmax(0,1fr))`, gap: 12 }}>
          ${shown.map((a) => html`<${AssetCard} key=${a.id} a=${a} selected=${sel.has(a.id)} active=${open === a.id} onSelect=${() => toggleSel(a.id)} onOpen=${() => setOpen(a.id)} />`)}
          <button className="col" onClick=${upload} style=${{ alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, border: '1.5px dashed var(--line)', background: 'transparent', color: 'var(--muted)', padding: 16, minHeight: 230, textAlign: 'center' }}><${Icon} n="upload" s=${20} /><b style=${{ color: 'var(--text)' }}>Drop files anywhere</b><span style=${{ fontSize: 12, lineHeight: 1.45 }}>Images, SVG, video, fonts, audio · up to 200 MB each. Claude describes and tags them.</span></button>
        </div>
      </main>
      <aside className="side" style=${{ borderLeft: detail ? '1px solid var(--line)' : 0, overflow: 'hidden' }}>${detail ? html`<${AssetDetail} key=${detail.id} a=${detail} onClose=${() => setOpen(null)} onDelete=${() => remove([detail.id])} />` : null}</aside>
      ${sel.size ? html`<${SelBar} n=${sel.size} onDescribe=${() => redescribe([...sel])} onDelete=${() => remove([...sel])} onClear=${() => setSel(new Set())} />` : null}
      ${drag ? html`<div style=${{ position: 'absolute', inset: 8, borderRadius: 16, border: '2px dashed #FF5A1F', background: 'rgba(255,90,31,.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20, fontWeight: 700, fontSize: 16 }}>Drop to add to Half Story</div>` : null}
    </div>`;
  }
  function AssetCard({ a, selected, active, onSelect, onOpen }) {
    const ref = useRef(null);
    useLayoutEffect(() => { motion.enter(ref.current, { y: a.fresh ? 14 : 8, scale: a.fresh ? .96 : 1 }); }, []);
    return html`<div ref=${ref} className="card hov col" onClick=${onOpen} style=${{ overflow: 'hidden', boxShadow: active ? '0 0 0 2px #FF5A1F' : selected ? '0 0 0 1.5px #FF5A1F' : undefined }}>
      <div style=${{ position: 'relative' }}><${Thumb} a=${a} />
        <span style=${{ position: 'absolute', left: 8, top: 8 }} onClick=${(e) => e.stopPropagation()}><${Check} on=${selected} onChange=${onSelect} label=${'Select ' + a.name} /></span>
        ${a.size && a.kind === 'image' ? html`<span className="mono" style=${{ position: 'absolute', right: 8, bottom: 8, padding: '1px 6px', borderRadius: 4, background: 'rgba(0,0,0,.6)', color: '#fff', fontSize: 10 }}>${a.size.split(' · ')[0]}</span>` : null}
        ${a.describing ? html`<${MS.React.Fragment}><span className="shimmer"></span><span className="pill" style=${{ position: 'absolute', left: 8, bottom: 8, background: 'rgba(23,23,23,.82)', color: '#fff' }}><${Spinner} s=${11} />Describing…</span></${MS.React.Fragment}>` : null}</div>
      <div className="col" style=${{ padding: '10px 12px', gap: 6 }}><b className="b ell">${a.name}</b>
        ${a.describing ? html`<${MS.React.Fragment}><span style=${{ height: 10, width: '80%', borderRadius: 4, background: 'var(--field)' }}></span><span style=${{ height: 10, width: '55%', borderRadius: 4, background: 'var(--field)' }}></span></${MS.React.Fragment}>` : html`<span className="muted" style=${{ fontSize: 12, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>${a.desc}</span>`}
        <div className="row" style=${{ gap: 4 }}>${a.tags.slice(0, 2).map((t) => html`<span key=${t} className="tag">${t}</span>`)}${a.tags.length > 2 ? html`<span className="faint" style=${{ fontSize: 11 }}>+${a.tags.length - 2}</span>` : null}<span className="faint" style=${{ marginLeft: 'auto', fontSize: 11 }}>${{ website: 'website', uploaded: 'uploaded', google: 'Google Fonts', generated: 'generated' }[a.origin]}</span></div></div></div>`;
  }
  function AssetDetail({ a, onClose, onDelete }) {
    const ref = useRef(null);
    const [tagIn, setTagIn] = useState('');
    useLayoutEffect(() => { motion.enter(ref.current, { x: 16, y: 0 }); }, []);
    return html`<div ref=${ref} className="col" style=${{ height: '100%' }}>
      <div className="row" style=${{ height: 48, padding: '0 14px', borderBottom: '1px solid var(--line2)' }}><input value=${a.name} onInput=${(e) => updA(a.id, (x) => ({ ...x, name: e.target.value }))} aria-label="Asset name" style=${{ border: 0, outline: 'none', background: 'transparent', fontWeight: 600, flex: 1 }} /><button className="btn icon sm ghost" aria-label="Close details" onClick=${onClose}><${Icon} n="close" s=${12} /></button></div>
      <div className="col scroll" style=${{ padding: 14, gap: 14, overflow: 'auto' }}>
        <div style=${{ borderRadius: 10, overflow: 'hidden' }}><${Thumb} a=${a} h=${240} /></div>
        <div className="col" style=${{ gap: 6 }}><div className="row"><span className="lbl" style=${{ fontSize: 11 }}>Description</span><span className="faint" style=${{ fontSize: 11 }}>by Claude · edit freely</span><button className="btn icon sm ghost" style=${{ marginLeft: 'auto' }} aria-label="Describe again" onClick=${async () => { updA(a.id, (x) => ({ ...x, describing: true })); await wait(1800); updA(a.id, (x) => ({ ...x, describing: false })); toast('Description updated', { tone: 'ok' }); }}><${Icon} n="refresh" s=${12} /></button></div>
          ${a.describing ? html`<div className="row muted" style=${{ padding: '10px 12px', borderRadius: 8, background: 'var(--field)', gap: 8, fontSize: 12 }}><${Typing} />Claude is looking at it</div>` : html`<textarea className="input" rows="4" style=${{ fontSize: 12.5, borderRadius: 8 }} value=${a.desc} onInput=${(e) => updA(a.id, (x) => ({ ...x, desc: e.target.value }))}></textarea>`}</div>
        <div className="col" style=${{ gap: 6 }}><span className="lbl" style=${{ fontSize: 11 }}>Tags</span><div className="row" style=${{ flexWrap: 'wrap', gap: 6 }}>${a.tags.map((t) => html`<span key=${t} className="chip" style=${{ background: 'var(--field)', boxShadow: 'none', paddingRight: 4 }}>${t}<button className="btn icon sm ghost" style=${{ width: 16, height: 16 }} aria-label=${'Remove ' + t} onClick=${() => updA(a.id, (x) => ({ ...x, tags: x.tags.filter((y) => y !== t) }))}>×</button></span>`)}<form onSubmit=${(e) => { e.preventDefault(); if (!tagIn.trim()) return; updA(a.id, (x) => ({ ...x, tags: [...x.tags, tagIn.trim()] })); setTagIn(''); }}><input className="chip" value=${tagIn} onInput=${(e) => setTagIn(e.target.value)} placeholder="+ Add" aria-label="Add a tag" style=${{ width: 70, outline: 'none' }} /></form></div></div>
        <div style=${{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '6px 10px', fontSize: 12, paddingTop: 12, borderTop: '1px solid var(--line2)' }}><span className="muted">File</span><span className="mono ell" style=${{ fontSize: 11.5 }}>${a.file}</span><span className="muted">Size</span><span>${a.size}</span><span className="muted">Added</span><span>${a.origin === 'uploaded' ? 'Uploaded by you · today' : a.origin === 'google' ? 'Google Fonts · today' : 'From half-story.com · today'}</span><span className="muted">Used in</span><span className=${a.id === 'a3' || a.id === 'a4' ? '' : 'faint'}>${a.id === 'a3' || a.id === 'a4' ? 'A crime a week' : 'Not used yet'}</span></div>
        <div className="row"><button className="btn ink grow" onClick=${() => nav({ name: 'newCreative', pid: 'hs' })}>Use in a creative</button><button className="btn icon" aria-label="Show in Finder" onClick=${() => toast('Shown in Finder', { tone: 'ok' })}><${Icon} n="folder" s=${14} /></button><button className="btn icon danger" aria-label="Delete" onClick=${onDelete}><${Icon} n="trash" s=${14} /></button></div>
      </div></div>`;
  }
  function SelBar({ n, onDescribe, onDelete, onClear }) {
    const ref = useRef(null);
    useLayoutEffect(() => { motion.enter(ref.current, { y: 16 }); }, []);
    return html`<div ref=${ref} className="row" style=${{ position: 'absolute', left: '50%', bottom: 20, transform: 'translateX(-50%)', gap: 4, padding: '6px 6px 6px 14px', borderRadius: 12, background: '#171717', color: '#fff', boxShadow: '0 14px 40px rgba(0,0,0,.3)', zIndex: 10 }}>
      <b style=${{ marginRight: 8 }}>${n} selected</b>${[['Describe again', onDescribe], ['Add tags', () => toast('Type a tag to add it to every selected asset')], ['Use in a creative', () => nav({ name: 'newCreative', pid: 'hs' })]].map(([l, f]) => html`<button key=${l} className="btn sm" style=${{ background: 'transparent', color: '#fff' }} onClick=${f}>${l}</button>`)}
      <span style=${{ width: 1, height: 18, background: '#3A3A3A', margin: '0 4px' }}></span><button className="btn sm" style=${{ background: 'transparent', color: '#FF8A5C' }} onClick=${onDelete}>Delete</button><button className="btn icon sm" style=${{ background: 'transparent', color: '#fff' }} aria-label="Clear selection" onClick=${onClear}><${Icon} n="close" s=${11} /></button></div>`;
  }

  /* ---------- references ---------- */
  function ReferencesPage() {
    const refs = useStore((s) => s.references);
    const [filter, setFilter] = useState('all'); const [url, setUrl] = useState(''); const [note, setNote] = useState(null);
    const root = MS.useEnter([]);
    const shown = refs.filter((r) => filter === 'all' || r.type === filter);
    const on = refs.filter((r) => r.on).length;
    const upd = (id, fn) => set((s) => ({ references: s.references.map((r) => (r.id === id ? fn({ ...r }) : r)) }));
    const add = async () => { if (!url.trim()) return; const id = 'r' + Date.now(); const host = url.replace(/^https?:\/\//, '').split('/')[0]; set((s) => ({ references: [{ id, type: 'link', title: 'Reading the page…', note: '', src: host, loading: true, fresh: true }, ...s.references] })); setUrl(''); await wait(1600); upd(id, (r) => ({ ...r, loading: false, title: host.includes('youtube') || host.includes('vimeo') ? 'Rain on glass, macro study' : 'Film noir lighting guide', note: 'Hard key light from one side, deep shadows, practical lamps.' })); };
    const cols = [[], [], [], []]; shown.forEach((r, i) => cols[i % 4].push(r));
    return html`<div className="scroll" style=${{ height: '100%', overflow: 'auto' }}><div ref=${root} style=${{ width: 1280, maxWidth: 'calc(100% - 48px)', margin: '0 auto', padding: '24px 0 60px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="row" style=${{ gap: 16, alignItems: 'flex-end' }} data-enter><div className="col" style=${{ gap: 4 }}><h1 style=${{ margin: 0, fontSize: 22, letterSpacing: '-.015em' }}>References</h1><span className="muted">Inspiration for the look and feel. The agent reads them; renders only use what's in Assets.</span></div><div className="grow"></div>
        <div className="seg">${[['all', 'All', refs.length], ['image', 'Images', refs.filter((r) => r.type === 'image').length], ['link', 'Links', refs.filter((r) => r.type === 'link').length], ['note', 'Notes', refs.filter((r) => r.type === 'note').length]].map(([k, l, n]) => html`<button key=${k} className=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${l} <span className="faint" style=${{ fontWeight: 400 }}>${n}</span></button>`)}</div>
        <form className="row" onSubmit=${(e) => { e.preventDefault(); add(); }}><input className="input" style=${{ width: 280, height: 34, background: 'var(--panel)', boxShadow: 'inset 0 0 0 1px var(--line)' }} value=${url} onInput=${(e) => setUrl(e.target.value)} placeholder="Paste a link or drop images" aria-label="Paste a link" /><button className="btn ink" type="submit">Add</button></form></div>
      <div className="row card" style=${{ padding: '10px 14px', gap: 10 }} data-enter><span className="dot" style=${{ color: '#FF5A1F' }}></span><span><b>${on} reference${on === 1 ? '' : 's'}</b> feed the next brand analysis</span><span className="muted">· turn it on for any card with the switch</span><button className="btn sm ghost" style=${{ marginLeft: 'auto', color: 'var(--accentText)' }} onClick=${() => { MS.nav({ name: 'project', pid: 'hs', tab: 'brand' }); setTimeout(() => MS.startAnalysis(), 400); }}>Analyze brand with these</button></div>
      <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 14, alignItems: 'start' }}>${cols.map((col, i) => html`<div key=${i} className="col" style=${{ gap: 14 }}>${col.map((r) => html`<${RefCard} key=${r.id} r=${r} onToggle=${(v) => upd(r.id, (x) => ({ ...x, on: v }))} onRemove=${() => { const prev = get().references; set((s) => ({ references: s.references.filter((x) => x.id !== r.id) })); toast('Reference removed', { action: { label: 'Undo', run: () => set({ references: prev }) } }); }} />`)}${i === 3 ? (note !== null ? html`<form className="card col" style=${{ padding: 14, gap: 8 }} onSubmit=${(e) => { e.preventDefault(); if (!note.trim()) return; set((s) => ({ references: [...s.references, { id: 'n' + Date.now(), type: 'note', note: note.trim(), src: 'You · ' + now(), fresh: true }] })); setNote(null); }}><textarea className="input" rows="3" autoFocus value=${note} onInput=${(e) => setNote(e.target.value)} placeholder="Words for the agent, no image needed"></textarea><div className="row"><button className="btn sm ghost" type="button" onClick=${() => setNote(null)}>Cancel</button><button className="btn sm ink" style=${{ marginLeft: 'auto' }} type="submit">Add note</button></div></form>` : html`<button className="col" onClick=${() => setNote('')} style=${{ borderRadius: 14, border: '1.5px dashed var(--line)', background: 'transparent', height: 120, alignItems: 'center', justifyContent: 'center', gap: 6, color: 'var(--muted)' }}><b style=${{ color: 'var(--text)' }}>Add a note</b><span style=${{ fontSize: 12 }}>Words for the agent, no image needed</span></button>`) : null}</div>`)}</div>
    </div></div>`;
  }
  function RefCard({ r, onToggle, onRemove }) {
    const ref = useRef(null);
    useLayoutEffect(() => { motion.enter(ref.current, { y: r.fresh ? 14 : 8, scale: r.fresh ? .96 : 1 }); }, []);
    const sw = html`<span className="row" style=${{ gap: 6, marginLeft: 'auto', fontSize: 12 }}>${r.type === 'image' ? 'Brand analysis' : ''}<${Toggle} sm on=${!!r.on} onChange=${onToggle} label="Use for brand analysis" /></span>`;
    const actions = html`<button className="btn icon sm ghost" aria-label="Remove" onClick=${onRemove} style=${{ position: 'absolute', right: 8, top: 8, background: 'rgba(255,255,255,.9)', color: '#171717', opacity: 0, transition: 'opacity var(--d-s)' }} data-x><${Icon} n="trash" s=${12} /></button>`;
    if (r.type === 'note') return html`<div ref=${ref} className="card col" style=${{ padding: 14, gap: 8, position: 'relative' }}><span className="cap">Note</span><span className="serif" style=${{ fontStyle: 'italic', fontSize: 18, lineHeight: 1.35 }}>${r.note}</span><span className="faint" style=${{ fontSize: 12 }}>${r.src}</span>${actions}<style>${'.card:hover>[data-x]{opacity:1!important}'}</style></div>`;
    return html`<div ref=${ref} className="card" style=${{ overflow: 'hidden', position: 'relative', boxShadow: r.on ? '0 0 0 1.5px #FF5A1F' : undefined, transition: 'box-shadow var(--d-s)' }}>
      ${r.type === 'image' ? html`<img src=${r.img} alt="" style=${{ width: '100%', height: r.h, objectFit: 'cover', objectPosition: 'top', display: 'block' }} />` : html`<div style=${{ height: 150, background: r.deco ? '#2E2A22' : '#0B0B0B', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', color: '#E8E2D6' }}>${r.loading ? html`<${Spinner} s=${20} />` : r.deco ? html`<span style=${{ fontWeight: 800, fontSize: 24, letterSpacing: '.1em', color: '#E9D9B8' }}>HOTEL ✦</span>` : html`<span className="serif" style=${{ fontStyle: 'italic', fontSize: 24 }}>title sequence</span>`}${r.badge ? html`<span className="pill" style=${{ position: 'absolute', left: 10, top: 10, background: 'rgba(255,255,255,.15)', color: '#fff' }}>${r.badge}</span>` : null}</div>`}
      <div className="col" style=${{ padding: '10px 12px', gap: 6 }}>${r.title ? html`<b className="b">${r.title}</b>` : null}${r.note ? html`<span className=${r.title ? 'muted' : ''} style=${{ fontSize: r.title ? 12 : 13, lineHeight: 1.45 }}>${r.note}</span>` : null}
        <div className="row muted" style=${{ fontSize: 12, gap: 6 }}>${r.type === 'link' ? html`<${Icon} n="link" s=${12} />` : null}${r.src}${sw}</div></div>${actions}<style>${'.card:hover>[data-x]{opacity:1!important}'}</style></div>`;
  }

  Object.assign(MS, { AssetsPage, ReferencesPage });
})();
