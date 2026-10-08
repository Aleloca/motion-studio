/* Brand: palette, typography with Google Fonts search, logos, voice, sources, live analysis and proposal review. */
(function () {
  const { html, useState, useEffect, useLayoutEffect, useRef, get, set, useStore, motion, Icon, Toggle, Check, Spinner, Typing, toast, wait, now, nav, Popover, togglePop } = MS;
  const { IMG } = MSDATA;
  const GF = [
    { family: 'Special Elite', css: "'Special Elite', monospace", styles: 1 }, { family: 'Courier Prime', css: "'Courier Prime', monospace", styles: 4 },
    { family: 'Libre Baskerville', css: "'Libre Baskerville', serif", styles: 3 }, { family: 'Newsreader', css: 'var(--serif)', styles: 14 },
  ];
  const updB = (fn) => set((s) => ({ brand: fn(JSON.parse(JSON.stringify(s.brand))) }));

  function BrandPage({ route }) {
    const b = useStore((s) => s.brand);
    const analysis = useStore((s) => s.analysis);
    const [section, setSection] = useState('overview');
    const scroller = useRef(null);
    const root = MS.useEnter([]);
    if (route.pid !== 'hs') return html`<${EmptyBrand} />`;
    const go = (id) => { setSection(id); const el = scroller.current.querySelector(`[data-sec="${id}"]`); el && scroller.current.scrollTo({ top: el.offsetTop - 20, behavior: 'smooth' }); };
    const onScroll = () => { const secs = [...scroller.current.querySelectorAll('[data-sec]')]; const y = scroller.current.scrollTop + 80; let cur = secs[0].dataset.sec; secs.forEach((s) => { if (s.offsetTop <= y) cur = s.dataset.sec; }); if (cur !== section) setSection(cur); };
    const nav2 = [['overview', 'Overview'], ['colors', 'Colors', b.colors.length], ['type', 'Typography', b.fonts.length], ['logos', 'Logos', 2], ['voice', 'Voice'], ['photo', 'Photo style'], ['guidelines', 'Guidelines']];
    return html`<div ref=${root} style=${{ height: '100%', display: 'grid', gridTemplateColumns: '220px minmax(0,1fr) 320px' }}>
      <nav aria-label="Brand sections" className="col" style=${{ padding: '24px 12px', gap: 2, borderRight: '1px solid var(--line)' }}>${nav2.map(([id, l, n]) => html`<button key=${id} className=${'navitem' + (section === id ? ' on' : '')} onClick=${() => go(id)}>${l}${n != null ? html`<span className="n">${n}</span>` : null}</button>`)}</nav>
      <main ref=${scroller} onScroll=${onScroll} className="scroll" style=${{ overflow: 'auto', padding: '28px 36px 80px', display: 'flex', flexDirection: 'column', gap: 34, minWidth: 0 }}>
        <section data-sec="overview" className="row" style=${{ gap: 20 }} data-enter><div style=${{ width: 180, height: 104, borderRadius: 14, background: '#1B1913', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 22, flex: 'none', boxShadow: '0 10px 24px var(--shadow)' }}>HALF STORY</div>
          <div className="col" style=${{ gap: 6 }}><h1 style=${{ margin: 0, fontSize: 26, letterSpacing: '-.02em' }}>Half Story</h1><p className="muted" style=${{ margin: 0, maxWidth: 620, fontSize: 14, lineHeight: 1.55 }}>${b.summary}</p><span className="faint" style=${{ fontSize: 12 }}>Learned from half-story.com · today 14:18 · ${b.history[0]}</span></div></section>
        <${Colors} b=${b} />
        <${Typography} b=${b} />
        <${Logos} b=${b} />
        <${Voice} b=${b} />
        <section data-sec="photo" className="card col" style=${{ padding: '16px 18px', gap: 10 }}><h2 style=${{ margin: 0, fontSize: 16 }}>Photo style</h2><p className="muted" style=${{ margin: 0, lineHeight: 1.55 }}>No photography. Hand-drawn sepia ink-and-wash on aged paper, heavy shadows, rainy night light, 1930s–40s Art Deco city.</p><div style=${{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>${[IMG.r25, IMG.r6, IMG.sq, IMG.pt].map((s) => html`<img key=${s} src=${s} alt="" style=${{ width: '100%', height: 110, objectFit: 'cover', borderRadius: 8 }} />`)}</div></section>
        <section data-sec="guidelines" className="card col" style=${{ padding: '16px 18px', gap: 10 }}><div className="row"><h2 style=${{ margin: 0, fontSize: 16 }}>Guidelines</h2><button className="btn sm ghost" style=${{ marginLeft: 'auto', color: 'var(--accentText)' }} onClick=${() => toast('Opened the full guidelines document')}>Open full document</button></div>
          <div className="col" style=${{ borderRadius: 10, background: 'var(--bg)', padding: '14px 16px', gap: 8, lineHeight: 1.55 }}><b style=${{ fontSize: 14 }}>What Half Story is</b><span className="muted">A detective game set in the fictional city of <b style=${{ color: 'var(--text)' }}>Calder</b>. A new crime case comes out every <b style=${{ color: 'var(--text)' }}>Monday morning</b> and runs for a week. Players move through six districts and question people in different places.</span><b style=${{ fontSize: 14 }}>Key lines</b><span className="muted">• “A crime a week. A whole city to question.”<br/>• “Nobody hands you the solution. Only what you can get people to tell you.”</span></div></section>
      </main>
      <aside className="side scroll" style=${{ borderLeft: '1px solid var(--line)', padding: '22px 18px', gap: 18, overflow: 'auto' }}>
        ${analysis ? html`<${AnalysisCard} a=${analysis} />` : html`<${Sources} b=${b} />`}
        <div className="col" style=${{ gap: 8 }}><span className="cap">Brand health</span>
          ${[['ok', 'Palette with roles'], ['ok', 'Fonts installed in the project'], ['ok', 'Voice and do / avoid rules'], [b.lightLogo ? 'ok' : 'warn', 'Logo for light backgrounds'], ['todo', 'Music or sound style']].map(([s, l]) => html`<div key=${l} className="row" style=${{ height: 30 }}><span style=${{ width: 16, height: 16, borderRadius: '50%', background: s === 'ok' ? 'var(--okBg)' : s === 'warn' ? 'var(--warnBg)' : 'transparent', boxShadow: s === 'todo' ? 'inset 0 0 0 1.5px var(--line)' : 'none', color: s === 'ok' ? 'var(--ok)' : 'var(--warn)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700 }}>${s === 'ok' ? html`<${Icon} n="check" s=${9} w=${2.4} />` : s === 'warn' ? '!' : ''}</span><span className=${s === 'todo' ? 'muted' : ''}>${l}</span></div>`)}</div>
        <div className="col" style=${{ gap: 8, padding: 12, borderRadius: 12, background: 'var(--bg)' }}><b className="b">History</b>${b.history.slice(0, 4).map((h, i) => html`<span key=${i} className="muted" style=${{ fontSize: 12 }}>${h}</span>`)}</div>
      </aside></div>`;
  }
  function EmptyBrand() {
    return html`<div className="dots" style=${{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="card col" style=${{ width: 480, padding: 28, gap: 12 }}><b style=${{ fontSize: 18 }}>Teach Claude this brand</b><span className="muted" style=${{ lineHeight: 1.5 }}>Paste the website. Claude reads it and proposes colors, fonts, logos and voice for you to review.</span><div className="row"><input className="input grow" placeholder="https://www.example.com" aria-label="Website" /><button className="btn ink" onClick=${() => toast('Analysis started')}>Analyze</button></div></div></div>`;
  }

  function Colors({ b }) {
    return html`<section data-sec="colors" className="col" style=${{ gap: 12 }}>
      <div className="row" style=${{ gap: 10 }}><h2 style=${{ margin: 0, fontSize: 16 }}>Colors</h2><span className="faint" style=${{ fontSize: 12 }}>Click a swatch to edit</span><button className="btn sm ghost" style=${{ marginLeft: 'auto', color: 'var(--accentText)' }} onClick=${() => { updB((x) => { x.colors.push({ id: 'n' + Date.now(), name: 'New color', hex: 'A3A3A3', role: 'Other', fresh: true }); x.history.unshift(now() + ' · You added a color'); return x; }); }}>+ Add color</button></div>
      <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', gap: 10 }}>${b.colors.map((c) => html`<${Swatch} key=${c.id} c=${c} />`)}</div></section>`;
  }
  function Swatch({ c }) {
    const ref = useRef(null);
    useLayoutEffect(() => { if (c.fresh) { motion.enter(ref.current, { scale: .9, y: 6 }); } }, []);
    const id = 'sw-' + c.id;
    return html`<div style=${{ position: 'relative' }}><button ref=${ref} data-pop=${id} onClick=${() => togglePop(id)} className="card hov" style=${{ width: '100%', border: 0, padding: 0, overflow: 'hidden', textAlign: 'left', boxShadow: c.hex === 'E86808' ? '0 0 0 2px #FF5A1F' : undefined }}><div style=${{ height: 84, background: '#' + c.hex, boxShadow: c.hex === 'FFFFFF' ? 'inset 0 -1px 0 var(--line)' : 'none', transition: 'background var(--d-m)' }}></div><div className="col" style=${{ padding: '8px 10px', gap: 2 }}><b className="ell" style=${{ fontSize: 12 }}>${c.name}</b><span className="mono muted" style=${{ fontSize: 11 }}>${c.hex}</span><span className="faint ell" style=${{ fontSize: 10.5 }}>${c.role}</span></div></button>
      <${Popover} id=${id} width=${230} origin="top left" style=${{ left: 0, top: 'calc(100% + 6px)' }}>
        <div className="col" style=${{ gap: 8, padding: 4 }}><span className="cap">Edit color</span>
          <label className="field"><small>NAME</small><input value=${c.name} onInput=${(e) => updB((x) => { x.colors.find((y) => y.id === c.id).name = e.target.value; return x; })} style=${{ fontFamily: 'var(--sans)' }} /></label>
          <label className="field"><span style=${{ width: 14, height: 14, borderRadius: 3, background: '#' + c.hex, flex: 'none', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.15)' }}></span><input value=${c.hex} maxLength="6" onInput=${(e) => { const v = e.target.value.replace(/[^0-9a-f]/gi, '').toUpperCase(); updB((x) => { x.colors.find((y) => y.id === c.id).hex = v.padEnd(6, '0').slice(0, 6); return x; }); }} /></label>
          <div className="row" style=${{ gap: 4, flexWrap: 'wrap' }}>${['Background', 'Secondary', 'Text on dark', 'Headlines', 'Accent', 'Logo only'].map((r) => html`<button key=${r} className=${'chip' + (c.role.startsWith(r) ? ' on' : '')} style=${{ height: 22, fontSize: 11 }} onClick=${() => updB((x) => { x.colors.find((y) => y.id === c.id).role = r; return x; })}>${r}</button>`)}</div>
          <button className="btn sm danger" style=${{ alignSelf: 'flex-start' }} onClick=${() => { const prev = get().brand; updB((x) => { x.colors = x.colors.filter((y) => y.id !== c.id); return x; }); set({ popover: null }); toast(`${c.name} removed`, { action: { label: 'Undo', run: () => set({ brand: prev }) } }); }}><${Icon} n="trash" s=${13} />Remove</button></div></${Popover}></div>`;
  }

  function Typography({ b }) {
    const [q, setQ] = useState('typewriter');
    const [adding, setAdding] = useState(null);
    const results = GF.filter((f) => !b.fonts.some((x) => x.family === f.family));
    const add = async (f) => {
      setAdding(f.family); await wait(1400);
      updB((x) => { x.fonts.push({ id: 'f' + Date.now(), family: f.family, role: 'Captions', styles: 'Regular', sample: 'Case closed.', sub: 'Interrogation room, 2 a.m.', css: f.css, fresh: true }); x.history.unshift(now() + ` · You added ${f.family}`); return x; });
      setAdding(null); toast(`${f.family} downloaded into assets/fonts`, { tone: 'ok' });
      set((s) => ({ assets: [...s.assets, { id: 'a' + Date.now(), name: f.family + ' Regular', file: `fonts/${f.family.replace(/ /g, '')}-400.ttf`, kind: 'font', origin: 'google', desc: 'Google Fonts · OFL', tags: ['font'], size: 'TTF · 88 KB', sample: 'Case closed.', css: f.css }] }));
    };
    return html`<section data-sec="type" className="col" style=${{ gap: 12 }}>
      <div className="row" style=${{ gap: 10 }}><h2 style=${{ margin: 0, fontSize: 16 }}>Typography</h2><span className="faint" style=${{ fontSize: 12 }}>Fonts are downloaded into the project, so renders always match</span></div>
      <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 12 }}>${b.fonts.map((f) => html`<${FontCard} key=${f.id} f=${f} />`)}</div>
      <div className="card" style=${{ overflow: 'hidden' }}>
        <label className="row" style=${{ height: 44, padding: '0 14px', borderBottom: '1px solid var(--line2)', gap: 10 }}><${Icon} n="search" s=${15} c="var(--muted)" /><input value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="Search Google Fonts" style=${{ border: 0, outline: 'none', background: 'transparent', flex: 1 }} /><span className="faint" style=${{ fontSize: 11 }}>Search Google Fonts · 1,700+ families</span></label>
        <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>${results.slice(0, 3).map((f, i) => html`<div key=${f.family} className="col" style=${{ padding: '12px 14px', gap: 6, borderLeft: i ? '1px solid var(--line2)' : 'none' }}><span style=${{ fontFamily: f.css, fontSize: 22 }}>Case closed.</span><span className="row" style=${{ justifyContent: 'space-between', fontSize: 12 }}><b className="b">${f.family}</b>${adding === f.family ? html`<span className="row muted" style=${{ gap: 6 }}><${Spinner} s=${12} />Downloading</span>` : html`<button className="btn sm ghost" style=${{ color: 'var(--accentText)', fontWeight: 600 }} onClick=${() => add(f)}>+ Add</button>`}</span></div>`)}</div>
      </div></section>`;
  }
  function FontCard({ f }) {
    const ref = useRef(null);
    useLayoutEffect(() => { if (f.fresh) motion.enter(ref.current, { y: 10, scale: .98 }); }, []);
    return html`<div ref=${ref} className="card col" style=${{ padding: '18px 20px', gap: 12 }}>
      <div className="row"><span className="tag">${f.role}</span><span className="faint" style=${{ fontSize: 11 }}>Google Fonts · OFL</span><span className="ok" style=${{ marginLeft: 'auto', fontSize: 11 }}>✓ in assets/fonts</span></div>
      <span style=${{ fontFamily: f.css, fontSize: 38, lineHeight: 1.05 }}>${f.sample}</span><span style=${{ fontFamily: f.css, fontStyle: f.family === 'Newsreader' ? 'italic' : 'normal', fontSize: 17 }} className="muted">${f.sub}</span>
      <div className="row" style=${{ paddingTop: 10, borderTop: '1px solid var(--line2)' }}><b className="b">${f.family}</b><span className="mono muted" style=${{ fontSize: 11 }}>${f.styles}</span><button className="btn sm ghost" style=${{ marginLeft: 'auto', color: 'var(--accentText)' }} onClick=${() => toast('Pick another family from the search below')}>Change</button></div></div>`;
  }
  function Logos({ b }) {
    const [making, setMaking] = useState(false);
    const make = async () => { setMaking(true); await wait(2600); updB((x) => { x.lightLogo = true; x.history.unshift(now() + ' · Agent made a dark wordmark'); return x; }); setMaking(false); toast('Dark wordmark added to Logos and Assets', { tone: 'ok' }); };
    return html`<section data-sec="logos" className="col" style=${{ gap: 12 }}>
      <div className="row"><h2 style=${{ margin: 0, fontSize: 16 }}>Logos</h2><button className="btn sm ghost" style=${{ marginLeft: 'auto', color: 'var(--accentText)' }} onClick=${() => toast('Choose an SVG or PNG to upload')}>+ Upload logo</button></div>
      <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 12 }}>
        <div className="card" style=${{ overflow: 'hidden' }}><div style=${{ height: 120, background: '#1B1913', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 24 }}>HALF STORY</div><div className="col" style=${{ padding: '10px 12px', gap: 2 }}><span className="row" style=${{ gap: 6 }}><b className="b">Wordmark</b><span className="tag">Primary</span><span className="tag">On dark</span></span><span className="mono faint" style=${{ fontSize: 11 }}>brand/half-story-logo-white.svg</span></div></div>
        <div className="card" style=${{ overflow: 'hidden' }}><div style=${{ height: 120, background: '#F1E6CF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="84" height="84" viewBox="0 0 60 60" aria-label="App icon"><rect x="2" y="2" width="56" height="56" rx="13" fill="#E9D9B8"/><path d="M12 36c6-2 30-2 36 0l-4 4c-8-2-20-2-28 0Z" fill="#2B241A"/><path d="M19 34c0-9 3-17 11-17s11 8 11 17Z" fill="#3A3024"/><path d="M19.5 30c7-1.5 14-1.5 21 0v4h-21Z" fill="#E86808"/><path d="M22 40c2 8 14 8 16 0Z" fill="#2B241A"/></svg></div><div className="col" style=${{ padding: '10px 12px', gap: 2 }}><span className="row" style=${{ gap: 6 }}><b className="b">App icon</b><span className="tag">Icon</span></span><span className="mono faint" style=${{ fontSize: 11 }}>brand/half-story-app-icon.png · 144 px</span></div></div>
        ${b.lightLogo ? html`<div className="card" ref=${(el) => el && !el.dataset.in && (el.dataset.in = 1, motion.enter(el, { scale: .96 }))} style=${{ overflow: 'hidden' }}><div style=${{ height: 120, background: '#F5F1E8', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1B1913', fontWeight: 800, fontSize: 24 }}>HALF STORY</div><div className="col" style=${{ padding: '10px 12px', gap: 2 }}><span className="row" style=${{ gap: 6 }}><b className="b">Wordmark, dark</b><span className="tag">On light</span><span className="tag" style=${{ background: 'var(--sel)' }}>Made by the agent</span></span><span className="mono faint" style=${{ fontSize: 11 }}>brand/half-story-logo-dark.svg</span></div></div>`
          : html`<div className="col" style=${{ borderRadius: 14, border: '1.5px dashed var(--line)', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16, textAlign: 'center' }}>${making ? html`<${MS.React.Fragment}><${Spinner} s=${20} /><b className="b">Drawing a dark version…</b><span className="muted" style=${{ fontSize: 12 }}>From the white wordmark, same proportions</span></${MS.React.Fragment}>` : html`<${MS.React.Fragment}><b className="b">Missing: logo for light backgrounds</b><span className="muted" style=${{ fontSize: 12, lineHeight: 1.45 }}>Upload a dark version, or let the agent make one from the wordmark.</span><button className="btn sm outline" onClick=${make}>Ask the agent</button></${MS.React.Fragment}>`}</div>`}
      </div></section>`;
  }
  function Voice({ b }) {
    const [moreDo, setMoreDo] = useState(false), [moreAv, setMoreAv] = useState(false);
    const [adding, setAdding] = useState(null), [txt, setTxt] = useState('');
    const list = (items, more, kind) => html`${(more ? items : items.slice(0, 3)).map((t, i) => html`<span key=${t} style=${{ lineHeight: 1.45, color: i ? 'var(--muted)' : 'var(--text)' }}>${t}</span>`)}`;
    const addRule = (kind) => { if (!txt.trim()) return; updB((x) => { x[kind].push(txt.trim()); x.history.unshift(now() + ' · You added a rule'); return x; }); setTxt(''); setAdding(null); if (kind === 'dos') setMoreDo(true); else setMoreAv(true); };
    const col = (title, kind, more, setMore, tone) => html`<div className="card col" style=${{ padding: '16px 18px', gap: 10 }}><span className="row bb" style=${{ gap: 8 }}><span style=${{ width: 18, height: 18, borderRadius: '50%', background: tone === 'ok' ? 'var(--okBg)' : 'var(--warnBg)', color: tone === 'ok' ? 'var(--ok)' : 'var(--warn)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><${Icon} n=${tone === 'ok' ? 'check' : 'close'} s=${9} w=${2.4} /></span>${title}<span className="faint" style=${{ fontWeight: 400, fontSize: 12 }}>${b[kind].length}</span></span>
      ${list(b[kind], more, kind)}
      <div className="row" style=${{ gap: 10 }}>${b[kind].length > 3 ? html`<button className="btn sm ghost" style=${{ color: 'var(--accentText)', padding: 0 }} onClick=${() => setMore(!more)}>${more ? 'Show less' : `Show ${b[kind].length - 3} more`}</button>` : null}<button className="btn sm ghost" style=${{ padding: 0, marginLeft: 'auto' }} onClick=${() => { setAdding(kind); setTxt(''); }}>+ Add</button></div>
      ${adding === kind ? html`<form className="row" onSubmit=${(e) => { e.preventDefault(); addRule(kind); }}><input className="input grow" style=${{ height: 30, fontSize: 12 }} autoFocus value=${txt} onInput=${(e) => setTxt(e.target.value)} placeholder=${tone === 'ok' ? 'Something to always do' : 'Something to avoid'} /><button className="btn sm ink" type="submit">Add</button></form>` : null}</div>`;
    return html`<section data-sec="voice" style=${{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr', gap: 12, alignItems: 'start' }}>
      <div className="card col" style=${{ padding: '16px 18px', gap: 8 }}><h2 style=${{ margin: 0, fontSize: 16 }}>Voice</h2><p className="muted" style=${{ margin: 0, lineHeight: 1.55 }}>${b.voice}</p><span className="serif" style=${{ fontStyle: 'italic', fontSize: 15, paddingTop: 6, borderTop: '1px solid var(--line2)' }}>“Nobody confesses. Ruling things out is half the job.”</span></div>
      ${col('Do', 'dos', moreDo, setMoreDo, 'ok')}${col('Avoid', 'donts', moreAv, setMoreAv, 'warn')}</section>`;
  }

  /* ---------- sources and live analysis ---------- */
  function Sources({ b }) {
    const [url, setUrl] = useState('');
    return html`<div className="col" style=${{ gap: 10 }}><span className="cap">Sources</span>
      ${b.sources.map((s) => html`<div key=${s.url} className="col" style=${{ borderRadius: 12, boxShadow: 'inset 0 0 0 1px var(--line)', padding: 12, gap: 6 }}><div className="row"><span style=${{ width: 24, height: 24, borderRadius: 6, background: 'var(--field)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><${Icon} n="globe" s=${12} /></span><b className="b">${s.url}</b></div><span className="muted" style=${{ fontSize: 12 }}>Analyzed ${s.at} · ${s.found} suggestions, ${s.applied} applied</span></div>`)}
      <form className="row" onSubmit=${(e) => { e.preventDefault(); if (!url.trim()) return; updB((x) => { x.sources.push({ url: url.trim().replace(/^https?:\/\//, ''), at: 'not yet', found: 0, applied: 0 }); return x; }); setUrl(''); toast('Source added · analyze to learn from it', { tone: 'ok' }); }}><input className="input grow" style=${{ height: 32, fontSize: 12 }} value=${url} onInput=${(e) => setUrl(e.target.value)} placeholder="Add a website or Instagram URL" aria-label="Add a source" /><button className="btn sm ink" type="submit">Add</button></form>
      <span className="muted" style=${{ fontSize: 12 }}>+ 2 images from References are included</span>
      <button className="btn" onClick=${startAnalysis}><${Icon} n="refresh" s=${14} w=${1.6} />Analyze again</button></div>`;
  }
  async function startAnalysis() {
    const steps = ['Reading half-story.com (4 pages)', 'Looking at 2 reference images', 'Sampling colors from 6 illustrations', 'Reading the stylesheets for fonts', 'Downloading the dark wordmark', 'Writing the guidelines'];
    set({ analysis: { steps: [], progress: 2 } });
    for (let i = 0; i < steps.length; i++) { await wait(1100); set((s) => ({ analysis: { steps: [...s.analysis.steps, steps[i]], progress: Math.round(((i + 1) / steps.length) * 100) }, tokens: s.tokens + 1.8 })); }
    await wait(500); set({ analysis: null, proposal: true });
    toast('Brand suggestions are ready', { action: { label: 'Review', run: () => set({ modal: { type: 'review' } }) } });
    set({ modal: { type: 'review' } });
  }
  function AnalysisCard({ a }) {
    const ref = useRef(null);
    useLayoutEffect(() => { motion.enter(ref.current, { y: 8 }); }, []);
    return html`<div ref=${ref} className="col" style=${{ gap: 10, padding: 14, borderRadius: 12, background: 'var(--sel)', boxShadow: 'inset 0 0 0 1px var(--warnLine)' }}>
      <div className="row"><${Spinner} /><b className="b">Learning the brand</b><span className="mono muted" style=${{ marginLeft: 'auto', fontSize: 11 }}>${a.progress}%</span></div><div className="bar"><i style=${{ width: a.progress + '%' }}></i></div>
      <div className="col" style=${{ gap: 6 }}>${a.steps.map((s) => html`<${StepLine} key=${s} t=${s} />`)}<span className="row muted" style=${{ fontSize: 12, gap: 8 }}><${Typing} />working</span></div>
      <button className="btn sm ghost" style=${{ alignSelf: 'flex-start' }} onClick=${() => { set({ analysis: null }); toast('Analysis canceled'); }}>Cancel</button></div>`;
  }
  function StepLine({ t }) { const ref = useRef(null); useLayoutEffect(() => { motion.enter(ref.current, { y: 6 }); }, []); return html`<span ref=${ref} className="row" style=${{ gap: 8, fontSize: 12.5 }}><span className="ok"><${Icon} n="check" s=${12} w=${2.2} /></span>${t}</span>`; }

  /* ---------- proposal review ---------- */
  const PROPOSAL = {
    colors: [{ id: 'rain', name: 'Rain grey', hex: '6E6A62', role: 'Secondary', why: 'Wet streets in 4 illustrations' }, { id: 'lamp', name: 'Lamp amber', hex: 'C8873A', role: 'Accent', why: 'Street lamps, never next to Clue orange' }],
    fonts: [{ id: 'se', family: 'Special Elite', why: 'Used for case file captions in the site footer' }],
    logos: [{ id: 'dark', name: 'Wordmark, dark', why: 'Found as /assets/logo-dark.svg', dark: true }, { id: 'art', name: 'Case 092 cover', why: 'Probably an illustration, not a logo', img: IMG.r25, off: true }],
    dos: [{ id: 'd1', t: 'Show the case number on every teaser (“Case 092”).' }],
    donts: [{ id: 'x1', t: 'Never show a suspect’s face clearly before Friday.' }, { id: 'x2', t: 'Avoid stock rain overlays; paint it.', off: true }],
  };
  function BrandReview({ onClose }) {
    const all = Object.values(PROPOSAL).flat();
    const [on, setOn] = useState(() => Object.fromEntries(all.map((x) => [x.id, !x.off])));
    const [group, setGroup] = useState('colors');
    const n = Object.values(on).filter(Boolean).length;
    const apply = (close) => {
      const prev = get().brand;
      updB((x) => {
        PROPOSAL.colors.filter((c) => on[c.id]).forEach((c) => x.colors.push({ ...c, fresh: true }));
        if (on.se) x.fonts.push({ id: 'se', family: 'Special Elite', role: 'Captions', styles: 'Regular', sample: 'Case 092.', sub: 'Filed Monday, 6 a.m.', css: "'Special Elite', monospace", fresh: true });
        if (on.dark) x.lightLogo = true;
        PROPOSAL.dos.filter((d) => on[d.id]).forEach((d) => x.dos.push(d.t)); PROPOSAL.donts.filter((d) => on[d.id]).forEach((d) => x.donts.push(d.t));
        x.history.unshift(`${now()} · You applied ${n} of ${all.length} suggestions`); x.sources[0].at = 'just now'; x.sources[0].found = all.length; x.sources[0].applied = n; return x;
      });
      set({ proposal: false }); close();
      toast(`Applied ${n} suggestions to the brand`, { tone: 'ok', action: { label: 'Undo', run: () => set({ brand: prev }) } });
    };
    const groups = [['colors', 'Colors'], ['fonts', 'Typography'], ['logos', 'Logos'], ['dos', 'Do'], ['donts', 'Avoid']];
    const card = (x, body) => html`<button key=${x.id} onClick=${() => setOn({ ...on, [x.id]: !on[x.id] })} className="card" style=${{ border: 0, padding: 0, textAlign: 'left', overflow: 'hidden', boxShadow: on[x.id] ? '0 0 0 1.5px #FF5A1F' : '0 0 0 1px var(--line)', opacity: on[x.id] ? 1 : .7, transition: 'box-shadow var(--d-s), opacity var(--d-s)', position: 'relative' }}>${body}<span style=${{ position: 'absolute', right: 10, top: 10 }}><${Check} on=${on[x.id]} label=${'Keep ' + (x.name || x.family || x.t)} onChange=${(v) => setOn({ ...on, [x.id]: v })} /></span></button>`;
    return html`<${MS.Modal} width=${1100} label="Review brand suggestions" onClose=${onClose}>${(close) => html`<div className="col" style=${{ height: 'min(760px, calc(100vh - 80px))' }}>
      <div className="row" style=${{ padding: '18px 22px', borderBottom: '1px solid var(--line2)', gap: 14 }}><span style=${{ width: 36, height: 36, borderRadius: 10, background: 'var(--sel)', color: 'var(--accentText)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><${Icon} n="sparkle" s=${18} /></span><div className="col"><h2 style=${{ margin: 0, fontSize: 18 }}>Here's what's new on half-story.com</h2><span className="muted">${all.length} suggestions · pick what to keep, everything stays editable afterwards</span></div><button className="btn icon" style=${{ marginLeft: 'auto' }} aria-label="Close" onClick=${close}><${Icon} n="close" s=${12} w=${1.6} /></button></div>
      <div className="grow" style=${{ display: 'grid', gridTemplateColumns: '240px minmax(0,1fr)', minHeight: 0 }}>
        <nav className="col" style=${{ borderRight: '1px solid var(--line2)', padding: '14px 10px', gap: 2 }}>${groups.map(([k, l]) => html`<button key=${k} className=${'navitem' + (group === k ? ' on' : '')} onClick=${() => { setGroup(k); const el = document.querySelector(`[data-rg="${k}"]`); el && el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>${l}<span className="n mono">${PROPOSAL[k].filter((x) => on[x.id]).length}/${PROPOSAL[k].length}</span></button>`)}</nav>
        <div className="col scroll" style=${{ padding: '20px 24px', gap: 22, overflow: 'auto' }}>
          <div className="col" style=${{ gap: 10 }} data-rg="colors"><div className="row"><b style=${{ fontSize: 15 }}>Colors</b><span className="muted" style=${{ fontSize: 12 }}>sampled from the new case artwork</span></div><div style=${{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 10 }}>${PROPOSAL.colors.map((c) => card(c, html`<div style=${{ height: 70, background: '#' + c.hex }}></div><div className="col" style=${{ padding: '8px 10px' }}><b className="b">${c.name}</b><span className="mono muted" style=${{ fontSize: 11 }}>${c.hex} · ${c.role}</span><span className="faint" style=${{ fontSize: 11 }}>${c.why}</span></div>`))}</div></div>
          <div className="col" style=${{ gap: 10 }} data-rg="fonts"><b style=${{ fontSize: 15 }}>Typography</b><div style=${{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 10 }}>${PROPOSAL.fonts.map((f) => card(f, html`<div className="col" style=${{ padding: 16, gap: 6 }}><span style=${{ fontFamily: "'Special Elite', monospace", fontSize: 28 }}>Case 092.</span><b className="b">${f.family}</b><span className="faint" style=${{ fontSize: 11 }}>${f.why}</span></div>`))}</div></div>
          <div className="col" style=${{ gap: 10 }} data-rg="logos"><b style=${{ fontSize: 15 }}>Logos</b><div style=${{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 10 }}>${PROPOSAL.logos.map((l) => card(l, html`<div style=${{ height: 130, background: l.img ? '#000' : '#F5F1E8', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1B1913', fontWeight: 800, fontSize: 22 }}>${l.img ? html`<img src=${l.img} alt="" style=${{ width: '100%', height: '100%', objectFit: 'cover', opacity: .75 }} />` : 'HALF STORY'}</div><div className="col" style=${{ padding: '8px 10px' }}><b className="b">${l.name}</b><span className="faint" style=${{ fontSize: 11 }}>${l.why}</span></div>`))}</div></div>
          ${['dos', 'donts'].map((k) => html`<div key=${k} className="col" style=${{ gap: 10 }} data-rg=${k}><b style=${{ fontSize: 15 }}>${k === 'dos' ? 'Do' : 'Avoid'}</b><div style=${{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8 }}>${PROPOSAL[k].map((d) => card(d, html`<div style=${{ padding: '12px 44px 12px 14px', lineHeight: 1.45 }}>${d.t}</div>`))}</div></div>`)}
        </div></div>
      <div className="row" style=${{ padding: '14px 22px', borderTop: '1px solid var(--line2)', background: 'var(--bg)', gap: 12 }}><span className="muted" style=${{ fontSize: 12 }}>Applying adds the items you keep. You can undo from the toast or from History.</span><div className="grow"></div><button className="btn lg ghost" onClick=${() => { set({ proposal: false }); close(); toast('Suggestions discarded'); }}>Discard all</button><button className="btn lg ink" disabled=${!n} onClick=${() => apply(close)}>Apply ${n} of ${all.length}</button></div>
    </div>`}</${MS.Modal}>`;
  }

  Object.assign(MS, { BrandPage, BrandReview, startAnalysis });
})();
