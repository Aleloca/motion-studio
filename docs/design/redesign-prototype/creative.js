/* Creative: canvas, video editor, image editor, versions, comments, simulated agent turns. */
(function () {
  const { html, useState, useEffect, useLayoutEffect, useRef, get, set, useStore, motion, Icon, ChannelChip, Toggle, Check, Spinner, Typing, toast, wait, now, nav, Popover, togglePop, ApprovalCard, Bell, Tokens, Avatar, fmt, requestApproval, Empty } = MS;
  const { IMG } = MSDATA;

  const updC = (cid, fn) => set((s) => ({ creatives: s.creatives.map((x) => (x.id === cid ? fn(JSON.parse(JSON.stringify(x))) : x)) }));
  const outOf = (c, fid) => c.outputs.find((o) => o.fid === fid);
  const srcOf = (c, o) => { const base = o.follows ? outOf(c, o.follows) : o; if (!base) return ''; const v = (base.versions || []).find((x) => x.n === (base.view || base.editing)); return (v && v.img) || base.img; };

  /* ---------- simulated agent turn ---------- */
  let rainAsked = false;
  async function runChange(cid, text, ref) {
    const c0 = get().creatives.find((x) => x.id === cid);
    const reel = c0.outputs.find((o) => o.versions && MS.fmt(o.fid).kind === 'video') || c0.outputs.find((o) => o.versions);
    const fid = reel.fid;
    updC(cid, (c) => { c.chat.push({ id: 'u' + Date.now(), who: 'you', at: now(), text, ref }); c.working = { step: 'Reading your request', progress: 4 }; return c; });
    set((s) => ({ jobs: [{ id: 'job-' + cid, title: c0.title, step: 'Reading your request', progress: 4, img: srcOf(c0, reel) }, ...s.jobs] }));
    const step = async (t, p, ms = 1300) => {
      updC(cid, (c) => { c.chat.push({ id: 's' + Date.now() + Math.random(), who: 'agent', kind: 'typing', at: now() }); return c; });
      await wait(ms);
      updC(cid, (c) => { c.chat = c.chat.filter((m) => m.kind !== 'typing'); c.chat.push({ id: 's' + Date.now(), who: 'agent', kind: 'step', at: now(), text: t }); c.working = { step: t, progress: p }; return c; });
      set((s) => ({ jobs: s.jobs.map((j) => (j.id === 'job-' + cid ? { ...j, step: t, progress: p } : j)), tokens: s.tokens + 1.3 }));
    };
    await step('Read your request and the brand voice', 14);
    await step('Updated the composition: ' + (text.length > 60 ? text.slice(0, 57) + '…' : text), 32);
    if (!rainAsked) {
      rainAsked = true;
      const d = await requestApproval({ cid, where: 'Half Story · ' + c0.title, title: 'Download a texture from pexels.com?', plain: 'The agent wants a free rain texture for the city scene. pexels.com is not on this project\'s internet list.', chips: [{ t: 'Free · Pexels license' }, { t: 'Adds pexels.com to the list', tone: 'neutral' }], cmd: 'mcp__studio__download_file url=https://images.pexels.com/photos/1529360/rain.jpg dest=assets/brand/rain-texture.jpg', agentSays: 'A real texture reads better than a generated one at this size.', rule: 'WebFetch(domain:pexels.com)', ruleIcon: 'globe', ruleLabel: 'Download from pexels.com' });
      if (d === 'deny') { updC(cid, (c) => { c.chat.push({ id: 'n' + Date.now(), who: 'agent', kind: 'step', at: now(), text: 'Skipped the texture; drew the rain procedurally instead' }); return c; }); }
      else { updC(cid, (c) => { c.chat.push({ id: 'n' + Date.now(), who: 'agent', kind: 'step', at: now(), text: 'Downloaded rain-texture.jpg into Assets (credited to Pexels)' }); return c; }); }
    }
    await step('Rendering 210 frames', 58, 1500);
    for (const p of [72, 86, 97]) { await wait(500); updC(cid, (c) => { c.working.progress = p; return c; }); set((s) => ({ jobs: s.jobs.map((j) => (j.id === 'job-' + cid ? { ...j, progress: p } : j)) })); }
    await step('Checked size, length and safe zones', 100, 900);
    const n = Math.max(...reel.versions.map((v) => v.n)) + 1;
    updC(cid, (c) => {
      const o = c.outputs.find((x) => x.fid === fid);
      o.versions.push({ n, at: now(), by: 'Agent', note: text.length > 40 ? text.slice(0, 37) + '…' : text, img: n % 2 ? IMG.r6 : IMG.r45, fresh: true });
      o.editing = n; o.view = n; c.working = null;
      c.chat.push({ id: 'r' + Date.now(), who: 'agent', kind: 'result', at: now(), text: `${MS.fmt(fid).name} v${n} is ready and passes every ${MS.fmt(fid).channel} check.` + (c.outputs.some((x) => x.follows === fid) ? ` TikTok and Shorts follow the starred version (★ v${o.star}), so they don't change until you star v${n}.` : '') });
      return c;
    });
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== 'job-' + cid), done: [{ id: 'd' + Date.now(), text: `${MS.fmt(fid).name} v${n} is ready`, at: now(), ok: true }, ...s.done] }));
    toast(`${MS.fmt(fid).name} v${n} is ready`, { tone: 'ok', action: { label: 'Open editor', run: () => nav({ name: 'creative', pid: 'hs', cid, view: MS.fmt(fid).kind === 'video' ? 'video' : 'image' }) } });
  }
  MS.retryLoop = () => { toast('Trying again with a 7-second cut…'); updC('loop', (c) => { c.state = 'running'; c.progress = 20; c.step = 'Trimming to 7 s'; return c; }); setTimeout(() => { updC('loop', (c) => { c.state = 'ready'; c.updated = 'Just now'; c.outputs[0].star = 1; return c; }); toast('Calder at night loop is ready', { tone: 'ok' }); }, 4000 * motion.speed()); };

  /* ---------- shared bits ---------- */
  function StatusPill({ c }) {
    const waiting = useStore((s) => s.approvals.some((a) => a.cid === c.id));
    if (waiting) return html`<span className="pill warn"><span className="dot" style=${{ color: '#FF5A1F' }}></span>Needs you</span>`;
    if (c.working) return html`<span className="pill neutral"><${Spinner} s=${11} />Working · ${c.working.progress}%</span>`;
    return html`<span className="pill ok"><span className="dot"></span>Ready</span>`;
  }
  function VersionsPopover({ c, o, id, style, onPick }) {
    const vs = [...(o.versions || [])].reverse();
    return html`<${Popover} id=${id} width=${300} style=${style}>
      <div className="row" style=${{ justifyContent: 'space-between', padding: '4px 8px 8px' }}><b>${fmt(o.fid).name} versions</b><span className="faint" style=${{ fontSize: 11 }}>${vs.length}</span></div>
      <div className="col scroll" style=${{ gap: 2, maxHeight: 360, overflow: 'auto' }}>
      ${vs.map((v) => html`<div key=${v.n} className="row" style=${{ gap: 10, padding: '6px 8px', borderRadius: 8, background: (o.view || o.editing) === v.n ? 'var(--field)' : 'transparent', cursor: 'pointer' }} onClick=${() => { updC(c.id, (x) => { outOf(x, o.fid).view = v.n; return x; }); onPick && onPick(v.n); }}>
        <div style=${{ width: fmt(o.fid).w > fmt(o.fid).h ? 40 : 24, height: fmt(o.fid).w === fmt(o.fid).h ? 24 : 42, borderRadius: 4, overflow: 'hidden', flex: 'none' }}><img src=${v.img} alt="" style=${{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>
        <div className="col grow" style=${{ gap: 1 }}><span className="row" style=${{ gap: 6 }}><b>v${v.n}</b><span className="faint" style=${{ fontSize: 11 }}>${v.at}</span>${o.editing === v.n ? html`<span className="pill neutral" style=${{ height: 18, fontSize: 10 }}>Editing</span>` : null}</span><span className="muted ell" style=${{ fontSize: 11.5 }}>${v.by} · ${v.note}</span></div>
        <button className="btn icon sm ghost" aria-label=${o.star === v.n ? 'Used for export' : 'Use for export'} title=${o.star === v.n ? 'Used for export' : 'Use for export'} onClick=${(e) => { e.stopPropagation(); updC(c.id, (x) => { outOf(x, o.fid).star = v.n; return x; }); toast(`v${v.n} will be exported for ${fmt(o.fid).name}`, { tone: 'ok' }); }} style=${{ color: o.star === v.n ? '#FF5A1F' : 'var(--faint)' }}><${Icon} n="star" s=${14} fill=${o.star === v.n ? '#FF5A1F' : 'none'} /></button>
      </div>`)}</div>
      <div className="row" style=${{ padding: '8px 4px 2px', borderTop: '1px solid var(--line2)', marginTop: 4 }}><button className="btn sm grow" onClick=${() => set({ popover: null, modal: { type: 'compare', cid: c.id, fid: o.fid } })}>Compare</button><button className="btn sm grow" onClick=${() => { const v = o.view || o.editing; updC(c.id, (x) => { outOf(x, o.fid).editing = v; return x; }); set({ popover: null }); toast(`Next changes start from v${v}`, { tone: 'ok' }); }}>Restart from here</button></div>
    </${Popover}>`;
  }
  function ChatList({ c }) {
    const end = useRef(null);
    const approvals = useStore((s) => s.approvals);
    const mine = approvals.filter((a) => a.cid === c.id);
    useEffect(() => { end.current && end.current.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [c.chat.length, mine.length]);
    return html`<div className="col scroll" style=${{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14, gap: 12 }}>
      ${c.chat.map((m) => html`<${Msg} key=${m.id} m=${m} />`)}
      ${mine.map((a) => html`<div key=${a.id} style=${{ marginLeft: 36 }}><${ApprovalCard} a=${a} /></div>`)}
      <div ref=${end}></div></div>`;
  }
  function Msg({ m }) {
    const ref = useRef(null);
    useLayoutEffect(() => { motion.enter(ref.current, { y: 8 }); }, []);
    if (m.kind === 'typing') return html`<div ref=${ref} className="row" style=${{ gap: 10 }}><${AgentDot} /><div style=${{ padding: '10px 12px', borderRadius: '4px 12px 12px 12px', background: 'var(--field)' }}><${Typing} /></div></div>`;
    if (m.kind === 'step') return html`<div ref=${ref} className="row" style=${{ gap: 10, alignItems: 'flex-start', paddingLeft: 36 }}><span className="ok" style=${{ marginTop: 2 }}><${Icon} n="check" s=${13} w=${2} /></span><span className="grow" style=${{ fontSize: 12.5, lineHeight: 1.45 }}>${m.text}</span><span className="faint mono" style=${{ fontSize: 10.5 }}>${m.at}</span></div>`;
    const you = m.who === 'you';
    return html`<div ref=${ref} className="row" style=${{ gap: 10, alignItems: 'flex-start' }}>
      ${you ? html`<span className="avatar" style=${{ width: 26, height: 26 }}>AL</span>` : html`<${AgentDot} />`}
      <div className="col grow" style=${{ gap: 4, minWidth: 0 }}><span className="muted" style=${{ fontSize: 11 }}><b style=${{ color: 'var(--text)' }}>${you ? 'You' : 'Agent'}</b> · ${m.at}</span>
        <div style=${{ padding: '9px 12px', borderRadius: '4px 12px 12px 12px', background: you ? 'var(--panel)' : 'var(--field)', boxShadow: you ? 'inset 0 0 0 1px var(--line)' : 'none', lineHeight: 1.5 }}>${m.text}</div>
        ${m.ref ? html`<span className="chip" style=${{ alignSelf: 'flex-start', height: 22, fontSize: 11 }}><${Icon} n="comment" s=${11} />${m.ref}</span>` : null}</div></div>`;
  }
  const AgentDot = () => html`<span style=${{ flex: 'none', width: 26, height: 26, borderRadius: '50%', background: 'var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="10" height="10" viewBox="0 0 12 12"><path d="M3 2.5v7l6-3.5-6-3.5Z" fill="#FF5A1F"/></svg></span>`;
  function Composer({ c, pins, clearPins, placeholder }) {
    const [t, setT] = useState('');
    const busy = !!c.working;
    const send = () => { if (!t.trim() || busy) return; const ref = pins && pins.length ? pins.map((p) => p.label).join(', ') : undefined; runChange(c.id, t.trim(), ref); setT(''); clearPins && clearPins(); };
    return html`<div style=${{ padding: '12px 14px', borderTop: '1px solid var(--line2)' }}><div className="col" style=${{ gap: 8, padding: 10, borderRadius: 12, boxShadow: 'inset 0 0 0 1px var(--line)', background: 'var(--panel)' }}>
      ${pins && pins.length ? html`<div className="row" style=${{ gap: 6, flexWrap: 'wrap' }}>${pins.map((p) => html`<span key=${p.id} className="chip on" style=${{ height: 22, fontSize: 11 }}>${p.label}</span>`)}</div>` : null}
      <label className="sr" htmlFor=${'msg-' + c.id}>Ask for a change</label>
      <textarea id=${'msg-' + c.id} rows="2" placeholder=${busy ? 'The agent is working… you can queue the next change' : placeholder || 'Ask for a change, or press C and click a frame'} value=${t} onInput=${(e) => setT(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }} style=${{ resize: 'none', border: 0, outline: 'none', background: 'transparent', lineHeight: 1.5 }}></textarea>
      <div className="row"><span className="faint" style=${{ fontSize: 11 }}>⌘↵ to send</span><button className="btn icon sm accent" style=${{ marginLeft: 'auto', borderRadius: '50%', boxShadow: 'none' }} aria-label="Send" disabled=${!t.trim() || busy} onClick=${send}><${Icon} n="upload" s=${13} w=${1.8} c="#fff" /></button></div>
    </div></div>`;
  }

  /* ---------- page ---------- */
  function CreativePage({ route }) {
    const c = useStore((s) => s.creatives.find((x) => x.id === route.cid));
    const view = route.view || 'canvas';
    if (!c) return null;
    if (c.state === 'draft' && !c.outputs.length) return html`<div className="app"><${CreativeTop} c=${c} /><div className="dots grow" style=${{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="card col" style=${{ width: 440, padding: 26, gap: 12 }}><b style=${{ fontSize: 18 }}>Nothing generated yet</b><span className="muted">The brief for “${c.title}” is saved. Pick formats and generate when you're ready.</span><button className="btn ink" style=${{ alignSelf: 'flex-start' }} onClick=${() => nav({ name: 'newCreative', pid: 'hs', draft: true })}>Open the brief</button></div></div></div>`;
    return html`<div className="app">${view === 'canvas' ? html`<${CanvasView} c=${c} />` : view === 'video' ? html`<${VideoEditor} c=${c} />` : html`<${ImageEditor} c=${c} />`}</div>`;
  }
  function CreativeTop({ c, right }) {
    return html`<div className="topbar">
      <button className="btn" onClick=${() => nav({ name: 'project', pid: 'hs', tab: 'creatives' })} style=${{ paddingLeft: 6 }}><${Icon} n="back" s=${16} w=${1.5} />Creatives</button>
      <span className="muted">Half Story</span><span className="faint">/</span><b className="b">${c.title}</b><${StatusPill} c=${c} />
      <div className="grow"></div>${right}<${Bell} /><${Tokens} /><${Avatar} />
      <button className="btn ink" onClick=${() => set({ modal: { type: 'export', cid: c.id } })}><${Icon} n="download" s=${13} w=${1.7} />Export</button></div>`;
  }

  /* ---------- canvas ---------- */
  function CanvasView({ c }) {
    const [tool, setTool] = useState('select');
    const [zoom, setZoom] = useState(1);
    const [safe, setSafe] = useState(false);
    const [pins, setPins] = useState([]);
    const [draftPin, setDraftPin] = useState(null);
    const [tab, setTab] = useState('chat');
    const [sel, setSel] = useState(c.outputs[0] && c.outputs[0].fid);
    const reelRef = useRef(null);
    const root = useRef(null);
    useLayoutEffect(() => {
      const from = MS._flipBack; MS._flipBack = null;
      const els = root.current.querySelectorAll('[data-board]');
      if (from && reelRef.current) { motion.flip(reelRef.current, from); els.forEach((el, i) => { if (!el.contains(reelRef.current)) motion.enter(el, { scale: .98, y: 0, delay: 80 + i * 30 }); }); }
      else els.forEach((el, i) => motion.enter(el, { y: 12, delay: i * 40 }));
    }, []);
    useEffect(() => { const k = (e) => { if (e.target.closest('input,textarea')) return; if (e.key === 'c' || e.key === 'C') setTool('comment'); if (e.key === 'v' || e.key === 'V') setTool('select'); if (e.key === 'Escape') { setTool('select'); setDraftPin(null); } }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
    const openEditor = (fid, el) => { MS._flipFrom = el.getBoundingClientRect(); nav({ name: 'creative', pid: 'hs', cid: c.id, view: fmt(fid).kind === 'video' ? 'video' : 'image' }); };
    const placePin = (e, o) => {
      if (tool !== 'comment') return;
      const r = e.currentTarget.getBoundingClientRect();
      setDraftPin({ fid: o.fid, x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
    };
    const boards = layout(c);
    return html`<${MS.React.Fragment}><${CreativeTop} c=${c} />
      <div ref=${root} className="grow" style=${{ display: 'grid', gridTemplateColumns: '252px minmax(0,1fr) 368px', minHeight: 0 }}>
        <aside className="side" style=${{ borderRight: '1px solid var(--line)', padding: '12px 10px', gap: 4 }}>
          <div className="row" style=${{ justifyContent: 'space-between', padding: '0 6px 6px' }}><b>Formats</b><span className="faint" style=${{ fontSize: 12 }}>${c.outputs.length}</span></div>
          ${groupBy(c.outputs).map(([ch, outs]) => html`<div key=${ch} className="col" style=${{ gap: 2 }}>
            <div className="row cap" style=${{ height: 28, padding: '0 6px', fontWeight: 500 }}><${ChannelChip} k=${ch} />${fmt(outs[0].fid).channel}</div>
            ${outs.map((o) => html`<button key=${o.fid} className=${'navitem' + (sel === o.fid ? ' on' : '')} style=${{ paddingLeft: 30 }} onClick=${() => { setSel(o.fid); const el = root.current.querySelector(`[data-board="${o.fid}"]`); el && motion.pulse(el.querySelector('.frame') || el); }}><${Icon} n=${fmt(o.fid).kind === 'video' ? 'video' : 'image'} s=${14} />${fmt(o.fid).name}<span className="n">${o.pending ? '…' : o.follows ? 'follows ' + fmt(o.follows).name : '★ v' + o.star}</span></button>`)}
          </div>`)}
          <div className="grow"></div>
          <div style=${{ position: 'relative' }}><button className="btn outline" data-pop="addfmt" style=${{ width: '100%', boxShadow: 'none', outline: '1px dashed var(--line)', outlineOffset: -1 }} onClick=${() => togglePop('addfmt')}><${Icon} n="plus" s=${13} />Add a format</button>
            <${Popover} id="addfmt" width=${260} origin="bottom left" style=${{ left: 0, bottom: 40 }}>
              <span className="cap" style=${{ display: 'block', padding: '4px 8px 6px' }}>Same brief, new format</span>
              ${MSDATA.FORMATS.filter((f) => !c.outputs.some((o) => o.fid === f.id)).slice(0, 7).map((f) => html`<button key=${f.id} className="navitem" onClick=${() => { set({ popover: null }); addFormat(c.id, f.id); }}><${ChannelChip} k=${f.ch} />${f.channel} ${f.name}<span className="n">${f.ratio}</span></button>`)}
            </${Popover}></div>
        </aside>
        <main className="dots" style=${{ position: 'relative', overflow: 'hidden', cursor: tool === 'comment' ? 'crosshair' : tool === 'hand' ? 'grab' : 'default' }} onClick=${(e) => { if (e.target === e.currentTarget) setDraftPin(null); }}>
          <div style=${{ position: 'absolute', left: 0, top: 0, transform: `scale(${zoom})`, transformOrigin: '40px 30px', transition: 'transform var(--d-m) var(--e-out)' }}>
          ${boards.map((b) => { const o = b.o; const f = fmt(o.fid); const src = srcOf(c, o); const base = o.follows ? outOf(c, o.follows) : o; const isReel = o === c.outputs[0];
            return html`<div key=${o.fid} data-board=${o.fid} className="col" style=${{ position: 'absolute', left: b.x, top: b.y, gap: 8 }}>
              <div className="row" style=${{ gap: 6, fontSize: 12, position: 'relative' }}><span className="muted"><b style=${{ color: 'var(--text)' }}>${f.channel === 'Instagram' ? 'Instagram ' + f.name : f.name}</b></span>
                ${o.pending ? html`<span className="pill neutral" style=${{ height: 20 }}><${Spinner} s=${10} />Rendering</span>` : o.follows ? html`<span className="faint">· follows ${fmt(o.follows).name}${base.star ? ' ★ v' + base.star : ''}</span>` : html`<${MS.React.Fragment}><button className="vbadge" data-pop=${'v-' + o.fid} onClick=${() => togglePop('v-' + o.fid)}>★ v${o.star}<${Icon} n="chevron" s=${10} /></button>${(o.view || o.editing) !== o.star ? html`<span style=${{ fontSize: 11, color: 'var(--accentText)' }}>viewing v${o.view || o.editing}</span>` : null}<${VersionsPopover} c=${c} o=${o} id=${'v-' + o.fid} style=${{ left: 0, top: 26 }} /></${MS.React.Fragment}>`}
              </div>
              <div className="frame" ref=${isReel ? reelRef : null} style=${{ width: b.w, height: b.h, boxShadow: sel === o.fid ? '0 0 0 2px #FF5A1F, 0 16px 40px var(--shadow)' : undefined }} onClick=${(e) => { setSel(o.fid); placePin(e, o); }} onDoubleClick=${(e) => !o.follows && openEditor(o.fid, e.currentTarget)}>
                <img src=${src} alt=${f.name} key=${src} onLoad=${(e) => motion.anim(e.currentTarget, [{ opacity: 0, filter: 'blur(8px)' }, { opacity: 1, filter: 'blur(0)' }], 480)} />
                ${c.working && !o.follows && (f.kind === 'video' || o.pending) ? html`<span className="shimmer"></span>` : null}
                ${safe && f.kind === 'video' ? html`<${MS.React.Fragment}><div style=${{ position: 'absolute', left: 0, right: 0, top: 0, height: '11.5%', background: 'rgba(255,90,31,.18)', borderBottom: '1px dashed rgba(255,90,31,.8)' }}></div><div style=${{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '21.9%', background: 'rgba(255,90,31,.18)', borderTop: '1px dashed rgba(255,90,31,.8)' }}></div>${!o.follows ? html`<span style=${{ position: 'absolute', left: 6, bottom: 6, padding: '2px 6px', borderRadius: 4, background: 'rgba(0,0,0,.65)', color: '#fff', fontSize: 10 }}>Covered by ${f.channel} caption and buttons</span>` : null}</${MS.React.Fragment}>` : null}
                ${(c.comments || []).filter((k) => k.fid === o.fid).map((k, i) => html`<span key=${k.id} title=${k.text} style=${{ position: 'absolute', left: k.x + '%', top: k.y + '%', width: 24, height: 24, borderRadius: '12px 12px 12px 3px', background: k.done ? 'var(--ok)' : '#FF5A1F', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'translate(-2px,-22px)' }}>${k.done ? '✓' : i + 1}</span>`)}
                ${!o.follows && tool === 'select' ? html`<button className="btn" style=${{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', height: 36, borderRadius: 999, background: 'rgba(255,255,255,.94)', color: '#171717', fontWeight: 700, boxShadow: '0 8px 24px rgba(0,0,0,.3)', opacity: 0, transition: 'opacity var(--d-s)' }} data-open onClick=${(e) => { e.stopPropagation(); openEditor(o.fid, e.currentTarget.parentElement); }}>Open editor</button>` : null}
              </div>
              ${c.working && isReel ? html`<div className="col" style=${{ gap: 4, width: b.w }}><div className="bar"><i style=${{ width: c.working.progress + '%' }}></i></div><span className="muted" style=${{ fontSize: 11 }}>${c.working.step}</span></div>` : null}
              ${draftPin && draftPin.fid === o.fid ? html`<${PinComposer} pin=${draftPin} board=${b} onCancel=${() => setDraftPin(null)} onSend=${(text) => { const k = { id: 'k' + Date.now(), fid: o.fid, t: f.kind === 'video' ? 5.0 : null, x: draftPin.x, y: draftPin.y, text }; updC(c.id, (x) => { x.comments = [...(x.comments || []), k]; return x; }); setDraftPin(null); setTool('select'); runChange(c.id, text, `${f.name}${f.kind === 'video' ? ' · 0:05' : ''}`); }} />` : null}
            </div>`; })}
          </div>
          <div className="row" style=${{ position: 'absolute', left: '50%', bottom: 20, transform: 'translateX(-50%)', gap: 4, padding: 6, borderRadius: 12, background: '#171717', boxShadow: '0 10px 30px var(--shadowLg)', zIndex: 5 }}>
            ${[['select', 'cursor', 'Select (V)'], ['comment', 'comment', 'Comment (C)'], ['hand', 'hand', 'Hand (H)']].map(([k, ic, l]) => html`<button key=${k} className="btn icon" aria-label=${l} title=${l} style=${{ background: tool === k ? '#FF5A1F' : 'transparent', color: '#fff', height: 34, width: 34 }} onClick=${() => setTool(k)}><${Icon} n=${ic} s=${15} w=${1.5} /></button>`)}
            <span style=${{ width: 1, height: 20, background: '#3A3A3A', margin: '0 4px' }}></span>
            <button className="btn icon sm" style=${{ background: 'transparent', color: '#fff' }} aria-label="Zoom out" onClick=${() => setZoom(Math.max(.5, +(zoom - .1).toFixed(2)))}>−</button><span className="mono" style=${{ color: '#fff', fontSize: 12, width: 40, textAlign: 'center' }}>${Math.round(zoom * 50)}%</span><button className="btn icon sm" style=${{ background: 'transparent', color: '#fff' }} aria-label="Zoom in" onClick=${() => setZoom(Math.min(1.6, +(zoom + .1).toFixed(2)))}>+</button>
            <span style=${{ width: 1, height: 20, background: '#3A3A3A', margin: '0 4px' }}></span>
            <span className="row" style=${{ color: '#fff', fontSize: 12, padding: '0 8px 0 4px' }}><${Toggle} sm on=${safe} onChange=${setSafe} label="Safe zones" />Safe zones</span>
          </div>
          ${tool === 'comment' ? html`<div className="pill neutral" style=${{ position: 'absolute', left: '50%', top: 14, transform: 'translateX(-50%)', background: 'var(--panel)', boxShadow: '0 0 0 1px var(--line), 0 6px 16px var(--shadow)', height: 30, padding: '0 12px', fontWeight: 500 }}>Click a frame to comment · Esc to stop</div>` : null}
        </main>
        <aside className="side" style=${{ borderLeft: '1px solid var(--line)' }}>
          <div className="ptabs"><button className=${tab === 'chat' ? 'on' : ''} onClick=${() => setTab('chat')}>Chat</button><button className=${tab === 'comments' ? 'on' : ''} onClick=${() => setTab('comments')}>Comments <span className="tag" style=${{ height: 16, fontSize: 10 }}>${(c.comments || []).length}</span></button><button className=${tab === 'brief' ? 'on' : ''} onClick=${() => setTab('brief')}>Brief</button></div>
          ${tab === 'chat' ? html`<${MS.React.Fragment}><${ChatList} c=${c} /><${Composer} c=${c} pins=${pins} clearPins=${() => setPins([])} /></${MS.React.Fragment}>` : tab === 'comments' ? html`<div className="col scroll" style=${{ padding: 14, gap: 10, overflow: 'auto' }}>${(c.comments || []).map((k, i) => html`<div key=${k.id} className="card col" style=${{ padding: 12, gap: 6 }}><span className="row" style=${{ fontSize: 11 }}><span className="pill" style=${{ background: k.done ? 'var(--okBg)' : 'var(--sel)', color: k.done ? 'var(--ok)' : 'var(--accentText)', height: 20 }}>${k.done ? 'Applied' : 'Open'}</span><span className="muted">${fmt(k.fid).name}${k.t != null ? ' · 0:0' + Math.floor(k.t) : ''}</span></span><span>${k.text}</span></div>`)}</div>` : html`<div className="col" style=${{ padding: 16, gap: 12 }}><span className="cap">Goal</span><span style=${{ lineHeight: 1.5 }}>${c.brief ? c.brief.goal : '—'}</span><span className="cap">Key message</span><span>${c.brief ? c.brief.message : '—'}</span><button className="btn outline" style=${{ alignSelf: 'flex-start' }} onClick=${() => nav({ name: 'newCreative', pid: 'hs', edit: c.id })}>Edit the brief</button></div>`}
        </aside>
      </div>
      <style>${'[data-board] .frame:hover [data-open]{opacity:1!important}'}</style>
    </${MS.React.Fragment}>`;
  }
  function PinComposer({ pin, board, onCancel, onSend }) {
    const [t, setT] = useState('');
    const ref = useRef(null);
    useLayoutEffect(() => { motion.anim(ref.current, [{ opacity: 0, transform: 'scale(.92) translateY(4px)' }, { opacity: 1, transform: 'none' }], 200, motion.E.spring); ref.current.querySelector('textarea').focus(); }, []);
    return html`<div ref=${ref} className="row" style=${{ position: 'absolute', left: (pin.x / 100) * board.w - 2, top: 30 + (pin.y / 100) * board.h - 24, alignItems: 'flex-start', gap: 8, zIndex: 10, transformOrigin: '0 0' }}>
      <span style=${{ width: 26, height: 26, borderRadius: '13px 13px 13px 3px', background: '#FF5A1F', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 10px rgba(255,90,31,.4)' }}>AL</span>
      <div className="col" style=${{ width: 250, padding: 10, gap: 8, borderRadius: 10, background: 'var(--panel)', boxShadow: '0 0 0 1px var(--line), 0 12px 30px var(--shadowLg)' }}>
        <textarea rows="3" className="input" placeholder="What should change here?" value=${t} onInput=${(e) => setT(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && t.trim()) onSend(t.trim()); if (e.key === 'Escape') onCancel(); }} style=${{ fontSize: 12.5 }}></textarea>
        <div className="row"><span className="faint" style=${{ fontSize: 11 }}>at 0:05</span><button className="btn sm ghost" style=${{ marginLeft: 'auto' }} onClick=${onCancel}>Cancel</button><button className="btn sm accent" disabled=${!t.trim()} onClick=${() => onSend(t.trim())}>Send</button></div>
      </div></div>`;
  }
  function groupBy(outs) { const m = new Map(); outs.forEach((o) => { const ch = fmt(o.fid).ch; if (!m.has(ch)) m.set(ch, []); m.get(ch).push(o); }); return [...m.entries()]; }
  function layout(c) {
    const res = []; let x = 60, y = 40; const vids = c.outputs.filter((o) => !o.follows && fmt(o.fid).h > fmt(o.fid).w); const rest = c.outputs.filter((o) => !vids.includes(o));
    vids.forEach((o) => { res.push({ o, x, y, w: 304, h: 540 }); x += 344; });
    let lx = x, ly = 40;
    rest.forEach((o) => { const f = fmt(o.fid); if (o.follows) { res.push({ o, x: lx, y: ly, w: 152, h: 270 }); lx += 192; } });
    const imgs = rest.filter((o) => !o.follows); let iy = rest.some((o) => o.follows) ? 364 : 40;
    imgs.forEach((o) => { const f = fmt(o.fid); const w = f.w >= f.h ? 344 : 260; res.push({ o, x, y: iy, w, h: Math.round(w * f.h / f.w) }); iy += Math.round(w * f.h / f.w) + 60; });
    return res;
  }
  function addFormat(cid, fid) {
    const f = fmt(fid);
    updC(cid, (c) => { c.outputs.push({ fid, versions: [], star: 0, editing: 0, img: f.kind === 'video' ? IMG.r45 : IMG.sq, pending: true }); c.working = { step: `Adding ${f.channel} ${f.name}`, progress: 10 }; c.chat.push({ id: 'u' + Date.now(), who: 'you', at: now(), text: `Add ${f.channel} ${f.name} (${f.ratio})` }); return c; });
    toast(`Adding ${f.channel} ${f.name}…`);
    setTimeout(() => { updC(cid, (c) => { const o = c.outputs.find((x) => x.fid === fid); o.versions = [{ n: 1, at: now(), by: 'Agent', note: 'Recomposed from the Reel sources', img: o.img }]; o.star = 1; o.editing = 1; o.pending = false; c.working = null; c.chat.push({ id: 'r' + Date.now(), who: 'agent', kind: 'result', at: now(), text: `${f.channel} ${f.name} is ready. I reused the Reel's scenes and re-framed them for ${f.ratio}.` }); return c; }); toast(`${f.channel} ${f.name} is ready`, { tone: 'ok' }); }, 4200 * motion.speed());
  }

  /* ---------- video editor ---------- */
  const DUR = 7;
  const frameAt = (t) => (t < .7 ? IMG.r1 : t < 3 ? IMG.r25 : t < 3.6 ? IMG.r1 : t < 5.6 ? IMG.r45 : IMG.r6);
  function VideoEditor({ c }) {
    const o = c.outputs[0];
    const [t, setT] = useState(4.5);
    const [playing, setPlaying] = useState(false);
    const [clips, setClips] = useState(() => ({
      scenes: [{ id: 's1', name: 'Crime scene', start: 0, end: 3, img: IMG.r25 }, { id: 's2', name: 'Ink bleed', start: 3, end: 3.6, img: IMG.r1 }, { id: 's3', name: 'Calder at night', start: 3.6, end: 7, img: IMG.r45 }],
      text: [{ id: 't1', name: 'A crime a week.', start: .4, end: 3, font: 'Newsreader', size: 58, color: 'FBE8C3' }, { id: 't2', name: 'A whole city to question.', start: 3.6, end: 5.3, font: 'Newsreader', size: 58, color: 'FBE8C3' }, { id: 't3', name: 'A new case every Monday.', start: 5.3, end: 7, font: 'Newsreader', size: 32, color: 'DAC5A3' }],
      logo: [{ id: 'l1', name: 'Wordmark · 82%', start: 4.6, end: 7 }],
    }));
    const [selId, setSelId] = useState('t2');
    const [edits, setEdits] = useState(0);
    const [tab, setTab] = useState('clip');
    const player = useRef(null), root = useRef(null);
    const all = [...clips.scenes, ...clips.text, ...clips.logo];
    const selClip = all.find((x) => x.id === selId);
    useLayoutEffect(() => {
      const from = MS._flipFrom; MS._flipFrom = null;
      if (from) motion.flip(player.current, from);
      const parts = root.current.querySelectorAll('[data-part]');
      parts.forEach((el) => { const d = el.dataset.part; motion.enter(el, { x: d === 'l' ? -16 : d === 'r' ? 16 : 0, y: d === 'b' ? 24 : 0, delay: from ? 160 : 0 }); });
    }, []);
    useEffect(() => {
      if (!playing) return; let raf, last = performance.now();
      const tick = (n) => { const dt = (n - last) / 1000; last = n; setT((x) => { const v = x + dt; if (v >= DUR) { setPlaying(false); return DUR; } return v; }); raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
    }, [playing]);
    useEffect(() => { const k = (e) => { if (e.target.closest('input,textarea')) return; if (e.code === 'Space') { e.preventDefault(); setPlaying((p) => !p); } if (e.key === 'ArrowRight') setT((x) => Math.min(DUR, x + 1 / 30)); if (e.key === 'ArrowLeft') setT((x) => Math.max(0, x - 1 / 30)); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
    const back = () => { MS._flipBack = player.current.getBoundingClientRect(); nav({ name: 'creative', pid: 'hs', cid: c.id, view: 'canvas' }); };
    const edit = (patch) => {
      setClips((cl) => { const n = JSON.parse(JSON.stringify(cl)); for (const k of ['scenes', 'text', 'logo']) n[k] = n[k].map((x) => (x.id === selId ? { ...x, ...patch } : x)); return n; });
      setEdits((e) => e + 1);
    };
    const save = () => {
      const n = Math.max(...o.versions.map((v) => v.n)) + 1;
      const pill = document.querySelector('[data-draft]');
      updC(c.id, (x) => { const r = x.outputs[0]; r.versions.push({ n, at: now(), by: 'You', note: `${edits} direct edit${edits > 1 ? 's' : ''}`, img: frameAt(5) }); r.editing = n; r.view = n; return x; });
      setSaved(n); setEdits(0);
      setTimeout(() => setSaved(0), 1800 * motion.speed());
    };
    const [saved, setSaved] = useState(0);
    const pct = (s) => (s / DUR) * 100;
    const tc = (s) => `00:${String(Math.floor(s)).padStart(2, '0')}.${String(Math.floor((s % 1) * 100)).padStart(2, '0')}`;
    const sceneNow = clips.scenes.find((s) => t >= s.start && t < s.end) || clips.scenes[2];
    const textNow = clips.text.find((s) => t >= s.start && t < s.end);
    const pinsNow = (c.comments || []).filter((k) => k.fid === o.fid && k.t != null && Math.abs(k.t - t) < .5);
    return html`<${MS.React.Fragment}>
      <div className="topbar">
        <button className="btn" onClick=${back} style=${{ paddingLeft: 6 }}><${Icon} n="back" s=${16} w=${1.5} />All formats</button>
        <span className="muted">${c.title}</span><span className="faint">/</span><${ChannelChip} k="IG" /><b className="b">Instagram Reel</b><span className="mono faint" style=${{ fontSize: 11 }}>1080×1920 · 7.0 s · 30 fps</span>
        <span className="chip" style=${{ height: 26, color: 'var(--muted)' }}><${Icon} n="link" s=${12} />Also used by TikTok and Shorts</span>
        <div className="grow"></div><${Bell} /><${Tokens} />
        <div style=${{ position: 'relative' }}><button className="btn outline" data-pop="v-editor" onClick=${() => togglePop('v-editor')}><b>Reel v${o.view || o.editing}</b><span className="faint" style=${{ fontSize: 12 }}>${(o.view || o.editing) === Math.max(...o.versions.map((v) => v.n)) ? 'latest' : 'older'}</span><${Icon} n="chevron" s=${11} /></button><${VersionsPopover} c=${c} o=${o} id="v-editor" style=${{ right: 0, top: 40 }} /></div>
        <button className="btn ink" onClick=${() => set({ modal: { type: 'export', cid: c.id } })}>Export</button>
      </div>
      <div ref=${root} className="grow" style=${{ display: 'grid', gridTemplateColumns: '224px minmax(0,1fr) 288px', gridTemplateRows: 'minmax(0,1fr) 262px', minHeight: 0 }}>
        <aside className="side" data-part="l" style=${{ borderRight: '1px solid var(--line)', overflow: 'hidden' }}>
          <div className="row" style=${{ justifyContent: 'space-between', height: 38, padding: '0 12px', borderBottom: '1px solid var(--line2)' }}><b style=${{ fontSize: 12 }}>Scenes</b><span className="faint" style=${{ fontSize: 11 }}>${clips.scenes.length} · ${DUR.toFixed(1)} s</span></div>
          <div className="col" style=${{ padding: 8, gap: 2 }}>${clips.scenes.map((s) => html`<button key=${s.id} className="row" style=${{ gap: 10, padding: 6, borderRadius: 8, border: 0, textAlign: 'left', background: sceneNow.id === s.id ? 'var(--field)' : 'transparent', boxShadow: selId === s.id ? '0 0 0 1px #FF5A1F' : 'none' }} onClick=${() => { setT(s.start + .01); setSelId(s.id); }}><div style=${{ width: 34, height: 60, borderRadius: 4, overflow: 'hidden', flex: 'none' }}><img src=${s.img} alt="" style=${{ width: '100%', height: '100%', objectFit: 'cover' }} /></div><div className="col grow"><b className="ell" style=${{ fontSize: 12.5 }}>${s.name}</b><span className="mono faint" style=${{ fontSize: 10.5 }}>${s.start.toFixed(1)} – ${s.end.toFixed(1)} s</span></div></button>`)}</div>
          <div className="row" style=${{ height: 32, padding: '0 12px', borderTop: '1px solid var(--line2)', marginTop: 6 }}><span className="muted" style=${{ fontSize: 11, fontWeight: 600 }}>In this scene</span></div>
          <div className="col" style=${{ padding: '0 8px', gap: 2 }}>${[...clips.text, ...clips.logo].filter((x) => x.start < sceneNow.end && x.end > sceneNow.start).map((x) => html`<button key=${x.id} className="row" style=${{ height: 30, padding: '0 8px', borderRadius: 6, border: 0, textAlign: 'left', background: selId === x.id ? 'var(--sel)' : 'transparent', fontSize: 12 }} onClick=${() => setSelId(x.id)}><span style=${{ width: 18, height: 18, borderRadius: 4, background: selId === x.id ? '#FF5A1F' : 'var(--field)', color: selId === x.id ? '#fff' : 'var(--text)', fontFamily: 'Georgia,serif', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>${x.id[0] === 'l' ? 'HS' : 'T'}</span><span className="ell">${x.name}</span></button>`)}</div>
        </aside>
        <main className="dots" style=${{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0 }}>
          <div ref=${player} className="frame" style=${{ height: 'min(548px, 88%)', aspectRatio: '9 / 16', borderRadius: 6, boxShadow: '0 20px 50px var(--shadow)' }} onClick=${() => setPlaying((p) => !p)}>
            <img src=${frameAt(t)} alt="Reel preview" />
            ${textNow && selId === textNow.id ? html`<div style=${{ position: 'absolute', left: '10%', top: textNow.id === 't1' ? '16%' : '59%', width: '62%', height: '13%', border: '1.5px solid #FF5A1F', borderRadius: 3 }}><span style=${{ position: 'absolute', left: -1, top: -20, padding: '1px 6px', borderRadius: 3, background: '#FF5A1F', color: '#fff', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>Text · ${textNow.name}</span></div>` : null}
            ${pinsNow.map((k) => html`<span key=${k.id} style=${{ position: 'absolute', left: k.x + '%', top: k.y + '%', width: 24, height: 24, borderRadius: '12px 12px 12px 3px', background: k.done ? 'var(--ok)' : '#FF5A1F', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'translate(-2px,-22px)' }}>${k.done ? '✓' : '1'}</span>`)}
            ${!playing ? html`<span style=${{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 54, height: 54, borderRadius: '50%', background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: .85 }}><${Icon} n="play" s=${22} c="#fff" fill="#fff" /></span>` : null}
          </div>
          ${edits || saved ? html`<${DraftPill} edits=${edits} saved=${saved} onSave=${save} onDiscard=${() => { setEdits(0); toast('Edits discarded'); }} />` : null}
        </main>
        <aside className="side" data-part="r" style=${{ borderLeft: '1px solid var(--line)', overflow: 'hidden' }}>
          <div className="ptabs"><button className=${tab === 'chat' ? 'on' : ''} onClick=${() => setTab('chat')}>Chat</button><button className=${tab === 'clip' ? 'on' : ''} onClick=${() => setTab('clip')}>Clip</button></div>
          ${tab === 'chat' ? html`<${MS.React.Fragment}><${ChatList} c=${c} /><${Composer} c=${c} /></${MS.React.Fragment}>` : html`<${ClipInspector} clip=${selClip} edit=${edit} />`}
        </aside>
        <section aria-label="Timeline" data-part="b" style=${{ gridColumn: '1 / 4', background: 'var(--panel)', borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column' }}>
          <div className="row" style=${{ padding: '8px 16px', gap: 12, borderBottom: '1px solid var(--line2)' }}>
            <button className="btn icon" style=${{ borderRadius: '50%', background: 'var(--ink)', color: 'var(--inkText)' }} aria-label=${playing ? 'Pause' : 'Play'} onClick=${() => { if (t >= DUR) setT(0); setPlaying(!playing); }}>${playing ? html`<svg width="11" height="11" viewBox="0 0 12 12"><path d="M3 2h2v8H3zM7 2h2v8H7z" fill="currentColor"/></svg>` : html`<${Icon} n="play" s=${12} fill="currentColor" c="currentColor" />`}</button>
            <span className="mono" style=${{ fontSize: 13 }}>${tc(t)}<span className="faint"> / 00:07.00</span></span>
            <button className="btn icon sm outline" aria-label="Previous frame" onClick=${() => setT(Math.max(0, t - 1 / 30))}>‹</button><button className="btn icon sm outline" aria-label="Next frame" onClick=${() => setT(Math.min(DUR, t + 1 / 30))}>›</button>
            <div className="grow"></div><span className="muted" style=${{ fontSize: 12 }}>Space plays · click a clip to edit it · drag the ruler to scrub</span>
          </div>
          <div className="grow" style=${{ display: 'grid', gridTemplateColumns: '100px minmax(0,1fr)' }}>
            <div className="col cap" style=${{ borderRight: '1px solid var(--line2)', fontWeight: 500 }}><span style=${{ height: 24 }}></span>${['Scenes', 'Text', 'Logo', 'Audio'].map((l, i) => html`<span key=${l} style=${{ height: i === 0 ? 58 : 36, display: 'flex', alignItems: 'center', padding: '0 14px' }}>${l}</span>`)}</div>
            <div style=${{ position: 'relative', marginRight: 16 }} onMouseDown=${(e) => { if (!e.target.dataset.ruler) return; const r = e.currentTarget.getBoundingClientRect(); const move = (ev) => setT(Math.max(0, Math.min(DUR, ((ev.clientX - r.left) / r.width) * DUR))); move(e); const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); }; addEventListener('mousemove', move); addEventListener('mouseup', up); }}>
              <div data-ruler="1" style=${{ height: 24, display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', alignItems: 'center', cursor: 'ew-resize' }} className="mono faint">${[0, 1, 2, 3, 4, 5, 6].map((s) => html`<span key=${s} data-ruler="1" style=${{ fontSize: 10, paddingLeft: 4 }}>${s}s</span>`)}</div>
              ${['scenes', 'text', 'logo'].map((k) => html`<div key=${k} style=${{ position: 'relative', height: k === 'scenes' ? 58 : 36 }}>${clips[k].map((x) => html`<button key=${x.id} onClick=${() => { setSelId(x.id); setTab('clip'); setT(Math.max(t, x.start)); }} style=${{ position: 'absolute', left: `calc(${pct(x.start)}% + 1px)`, width: `calc(${pct(x.end - x.start)}% - 3px)`, top: k === 'scenes' ? 4 : 5, height: k === 'scenes' ? 50 : 26, borderRadius: 6, border: 0, padding: 0, overflow: 'hidden', textAlign: 'left', transition: 'left var(--d-m) var(--e-out), width var(--d-m) var(--e-out), box-shadow var(--d-s)', background: k === 'text' ? (selId === x.id ? '#FF5A1F' : 'var(--field)') : k === 'logo' ? 'var(--okBg)' : 'var(--field)', color: k === 'text' && selId === x.id ? '#fff' : k === 'logo' ? 'var(--ok)' : 'var(--text)', boxShadow: selId === x.id ? '0 0 0 2px var(--panel), 0 0 0 3.5px #FF5A1F' : 'inset 0 0 0 1px var(--line)', fontSize: 11, fontWeight: selId === x.id ? 600 : 400 }}>
                ${k === 'scenes' && x.img ? html`<div style=${{ display: 'flex', height: '100%' }}>${[0, 1, 2, 3, 4, 5].map((i) => html`<img key=${i} src=${x.img} alt="" style=${{ height: '100%', aspectRatio: '9/16', objectFit: 'cover' }} />`)}<span style=${{ position: 'absolute', left: 6, bottom: 4, color: '#fff', fontWeight: 600, textShadow: '0 1px 3px #000' }}>${x.name}</span></div>` : html`<span style=${{ padding: '0 8px', whiteSpace: 'nowrap' }}>${x.name}</span>`}</button>`)}</div>`)}
              <div style=${{ height: 36, display: 'flex', alignItems: 'center' }}><button className="btn sm" style=${{ width: 'calc(100% - 4px)', justifyContent: 'flex-start', background: 'transparent', boxShadow: 'inset 0 0 0 1px var(--line)', borderStyle: 'dashed', color: 'var(--faint)' }} onClick=${() => { setTab('chat'); toast('Ask the agent for music or a voice-over in the chat'); }}>No audio yet · add music or a voice-over</button></div>
              <div style=${{ position: 'absolute', left: `${pct(t)}%`, top: 0, bottom: 0, width: 2, background: 'var(--text)', pointerEvents: 'none', transform: 'translateX(-1px)' }}><span style=${{ position: 'absolute', left: -5, top: 0, width: 12, height: 12, borderRadius: 2, background: 'var(--text)' }}></span></div>
              ${(c.comments || []).filter((k) => k.fid === o.fid && k.t != null).map((k) => html`<button key=${k.id} title=${k.text} onClick=${() => setT(k.t)} style=${{ position: 'absolute', left: `calc(${pct(k.t)}% - 9px)`, top: 2, width: 20, height: 20, borderRadius: '10px 10px 10px 2px', border: 0, background: k.done ? 'var(--ok)' : '#FF5A1F', color: '#fff', fontSize: 9, fontWeight: 700 }}>${k.done ? '✓' : '•'}</button>`)}
            </div>
          </div>
        </section>
      </div></${MS.React.Fragment}>`;
  }
  function DraftPill({ edits, saved, onSave, onDiscard, label = 'Reel' }) {
    const ref = useRef(null);
    useLayoutEffect(() => { motion.enter(ref.current, { y: -10 }); }, []);
    useLayoutEffect(() => { if (saved && ref.current) motion.anim(ref.current, [{ transform: 'translateX(-50%) scale(1.04)' }, { transform: 'translateX(-50%) scale(1)' }], 320, motion.E.spring); }, [saved]);
    return html`<div ref=${ref} data-draft className="row" style=${{ position: 'absolute', left: '50%', top: 16, transform: 'translateX(-50%)', height: 34, padding: saved ? '0 14px' : '0 5px 0 12px', borderRadius: 999, background: 'var(--panel)', boxShadow: '0 0 0 1px var(--line), 0 8px 20px var(--shadow)', fontSize: 12, gap: 10, whiteSpace: 'nowrap', zIndex: 5, transition: 'padding var(--d-m) var(--e-out)' }}>
      ${saved ? html`<b className="ok row" style=${{ gap: 6 }}><${Icon} n="check" s=${13} w=${2} />Saved as ${label} v${saved}</b>` : html`<${MS.React.Fragment}><span className="dot" style=${{ color: '#FF5A1F' }}></span><span><b>Draft</b> <span className="muted">· ${edits} edit${edits > 1 ? 's' : ''} · rendered just now</span></span><button className="btn sm ghost" style=${{ borderRadius: 999, height: 24 }} onClick=${onDiscard}>Discard</button><button className="btn sm ink" style=${{ borderRadius: 999, height: 24 }} onClick=${onSave}>Save as new version</button></${MS.React.Fragment}>`}
    </div>`;
  }
  function ClipInspector({ clip, edit }) {
    if (!clip) return html`<${Empty} icon="cursor" title="Select a clip" sub="Click a clip in the timeline or a scene on the left." />`;
    const isText = clip.id[0] === 't';
    const swatches = ['1B1913', '342C1E', '856E51', 'DAC5A3', 'FBE8C3', 'E86808', 'FFFFFF'];
    const num = (label, key, v) => html`<label className="field" style=${{ flex: 1 }}><small>${label}</small><input value=${v} onChange=${(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) { if (key === 'dur') edit({ end: +(clip.start + n).toFixed(2) }); else if (key === 'in') edit({ start: n, end: +(n + (clip.end - clip.start)).toFixed(2) }); else edit({ end: n }); motion.flash(e.target.parentElement); } }} /></label>`;
    return html`<div className="col scroll" style=${{ overflow: 'auto' }}>
      <div className="row" style=${{ padding: 12, borderBottom: '1px solid var(--line2)' }}><span style=${{ width: 24, height: 24, borderRadius: 6, background: 'var(--field)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Georgia,serif' }}>${isText ? 'T' : clip.id[0] === 'l' ? 'HS' : '▣'}</span><div className="col grow"><b className="ell">${clip.name}</b><span className="faint" style=${{ fontSize: 11 }}>${isText ? 'Text' : clip.id[0] === 'l' ? 'Logo' : 'Scene'}</span></div><button className="btn icon sm ghost" aria-label="Ask the agent about this clip" title="Ask the agent" onClick=${() => toast('Opened the chat with this clip attached')}><${Icon} n="comment" s=${14} /></button></div>
      <div className="sec"><h4>Timing</h4><div className="row" style=${{ gap: 6 }}>${num('IN', 'in', clip.start.toFixed(2) + 's')}${num('DUR', 'dur', (clip.end - clip.start).toFixed(2) + 's')}${num('OUT', 'out', clip.end.toFixed(2) + 's')}</div></div>
      ${isText ? html`<${MS.React.Fragment}>
        <div className="sec"><h4>Content</h4><textarea className="input" rows="2" style=${{ fontSize: 12, padding: 8, borderRadius: 6 }} value=${clip.name} onInput=${(e) => edit({ name: e.target.value })}></textarea></div>
        <div className="sec"><h4>Typography</h4>
          <div className="field"><span className="grow">${clip.font}</span><${Icon} n="chevron" s=${11} c="var(--faint)" /></div>
          <div className="row" style=${{ gap: 6 }}><div className="field" style=${{ flex: 1.4 }}><span className="grow">Regular</span><${Icon} n="chevron" s=${11} c="var(--faint)" /></div><label className="field" style=${{ flex: 1 }}><input value=${clip.size} onChange=${(e) => edit({ size: +e.target.value || clip.size })} /></label></div>
          <div className="row" style=${{ gap: 6 }}><div className="field" style=${{ flex: 1 }}><small>↕</small>1.1</div><div className="field" style=${{ flex: 1 }}><small>↔</small>0%</div>${['alignL', 'alignC', 'alignR'].map((a, i) => html`<button key=${a} className="btn icon sm" style=${{ background: i === 0 ? 'var(--field)' : 'transparent', color: 'var(--muted)' }} aria-label=${a}><${Icon} n=${a} s=${14} /></button>`)}</div></div>
        <div className="sec"><h4>Fill</h4><div className="row" style=${{ gap: 6, flexWrap: 'wrap' }}>${swatches.map((h) => html`<button key=${h} aria-label=${'#' + h} onClick=${() => edit({ color: h })} style=${{ width: 26, height: 26, borderRadius: 6, border: 0, background: '#' + h, boxShadow: clip.color === h ? '0 0 0 2px var(--panel), 0 0 0 3.5px #FF5A1F' : 'inset 0 0 0 1px rgba(0,0,0,.15)', transition: 'box-shadow var(--d-s)' }}></button>`)}</div><span className="mono faint" style=${{ fontSize: 11 }}>${clip.color} · from the Half Story palette</span></div>
        <div className="sec"><h4>Animation</h4><div className="field"><small>IN</small><span className="grow">Fade up · 0.4s</span><${Icon} n="chevron" s=${11} c="var(--faint)" /></div><div className="field"><small>OUT</small><span className="grow">None</span><${Icon} n="chevron" s=${11} c="var(--faint)" /></div></div>
      </${MS.React.Fragment}>` : html`<div className="sec"><h4>Scene</h4><span className="muted" style=${{ fontSize: 12, lineHeight: 1.5 }}>Change the timing here, or ask the agent to restage the scene from the chat.</span></div>`}
    </div>`;
  }

  /* ---------- image editor ---------- */
  function ImageEditor({ c }) {
    const o = c.outputs.find((x) => fmt(x.fid).kind === 'image') || c.outputs[0];
    const layers = [
      { id: 'L1', name: 'HALF STORY wordmark', kind: 'Logo · brand asset', box: [7, 8, 37, 6], lock: true },
      { id: 'L2', name: 'This week in Calder.', kind: 'Text · Newsreader italic', box: [6, 47, 30, 4] },
      { id: 'L3', name: 'Headline', kind: 'Text · Newsreader 58 px', box: [5.8, 50.6, 46.2, 24.4] },
      { id: 'L4', name: 'A new case every Monday.', kind: 'Text · Newsreader italic', box: [6, 81, 35, 4] },
      { id: 'L5', name: 'Mobile and browser. Six languages.', kind: 'Text · 14 px', box: [6, 86, 35, 3] },
      { id: 'L6', name: 'Shadow gradient', kind: 'Fill · 70% black', box: [0, 0, 60, 100] },
      { id: 'L7', name: 'Crime scene illustration', kind: 'Image · home-splash-scene.jpg', box: [0, 0, 100, 100], lock: true, img: IMG.r25 },
    ];
    const [sel, setSel] = useState('L3');
    const [hidden, setHidden] = useState({});
    const [tool, setTool] = useState('move');
    const [edits, setEdits] = useState(0); const [saved, setSaved] = useState(0);
    const [opacity, setOpacity] = useState(100);
    const [zoom, setZoom] = useState(59);
    const canvas = useRef(null), root = useRef(null), box = useRef(null);
    const L = layers.find((l) => l.id === sel);
    useLayoutEffect(() => { const from = MS._flipFrom; MS._flipFrom = null; if (from) motion.flip(canvas.current, from); root.current.querySelectorAll('[data-part]').forEach((el) => { const d = el.dataset.part; motion.enter(el, { x: d === 'l' ? -16 : d === 'r' ? 16 : 0, delay: from ? 160 : 0 }); }); }, []);
    useLayoutEffect(() => { if (box.current) motion.anim(box.current, [{ opacity: 0, transform: 'scale(.98)' }, { opacity: 1, transform: 'none' }], 200); }, [sel]);
    const edit = () => setEdits((e) => e + 1);
    const save = () => { const n = Math.max(...o.versions.map((v) => v.n)) + 1; updC(c.id, (x) => { const r = x.outputs.find((y) => y.fid === o.fid); r.versions.push({ n, at: now(), by: 'You', note: `${edits} direct edit${edits > 1 ? 's' : ''}`, img: IMG.sq }); r.editing = n; r.view = n; return x; }); setSaved(n); setEdits(0); setTimeout(() => setSaved(0), 1800 * motion.speed()); };
    const back = () => { MS._flipBack = canvas.current.getBoundingClientRect(); nav({ name: 'creative', pid: 'hs', cid: c.id, view: 'canvas' }); };
    const tools = [['move', 'cursor', 'Move'], ['text', 'text', 'Text'], ['crop', 'crop', 'Crop'], ['drop', 'drop', 'Eyedropper'], ['comment', 'comment', 'Comment'], ['hand', 'hand', 'Hand']];
    return html`<${MS.React.Fragment}>
      <div className="topbar">
        <button className="btn" onClick=${back} style=${{ paddingLeft: 6 }}><${Icon} n="back" s=${16} w=${1.5} />All formats</button>
        <span className="muted">${c.title}</span><span className="faint">/</span><${ChannelChip} k="IG" /><b className="b">Instagram Image</b><span className="mono faint" style=${{ fontSize: 11 }}>1080×1080 · PNG · ${layers.length} layers</span>
        <div className="grow"></div><${Bell} /><${Tokens} />
        <div style=${{ position: 'relative' }}><button className="btn outline" data-pop="v-img" onClick=${() => togglePop('v-img')}><b>Image v${o.view || o.editing}</b><${Icon} n="chevron" s=${11} /></button><${VersionsPopover} c=${c} o=${o} id="v-img" style=${{ right: 0, top: 40 }} /></div>
        <button className="btn ink" onClick=${() => set({ modal: { type: 'export', cid: c.id } })}>Export</button>
      </div>
      <div ref=${root} className="grow" style=${{ display: 'grid', gridTemplateColumns: '52px 248px minmax(0,1fr) 280px', minHeight: 0 }}>
        <nav className="side" data-part="l" style=${{ borderRight: '1px solid var(--line)', alignItems: 'center', padding: '10px 0', gap: 4 }}>${tools.map(([k, ic, l]) => html`<button key=${k} className="btn icon" title=${l} aria-label=${l} onClick=${() => setTool(k)} style=${{ width: 38, height: 38, background: tool === k ? '#FF5A1F' : 'transparent', color: tool === k ? '#fff' : 'var(--muted)' }}><${Icon} n=${ic} s=${17} /></button>`)}</nav>
        <aside className="side" data-part="l" style=${{ borderRight: '1px solid var(--line)' }}>
          <div className="row" style=${{ height: 44, padding: '0 14px', borderBottom: '1px solid var(--line2)', justifyContent: 'space-between' }}><b>Layers</b><button className="btn icon sm ghost" aria-label="Add layer" onClick=${() => toast('Add text, image or shape layers from here')}>+</button></div>
          <div className="col" style=${{ padding: 8, gap: 2 }}>${layers.map((l) => html`<div key=${l.id} className="row" style=${{ height: 44, padding: '0 8px', borderRadius: 8, gap: 10, background: sel === l.id ? 'var(--sel)' : 'transparent', boxShadow: sel === l.id ? 'inset 0 0 0 1px #FF5A1F' : 'none', cursor: 'pointer', opacity: hidden[l.id] ? .45 : 1, transition: 'background var(--d-s), opacity var(--d-s)' }} onClick=${() => setSel(l.id)}>
            <button className="btn icon sm ghost" aria-label=${hidden[l.id] ? 'Show layer' : 'Hide layer'} onClick=${(e) => { e.stopPropagation(); setHidden((h) => ({ ...h, [l.id]: !h[l.id] })); edit(); }} style=${{ width: 22, height: 22 }}><${Icon} n="eye" s=${13} /></button>
            <div style=${{ width: 32, height: 32, borderRadius: 5, overflow: 'hidden', background: l.img ? '#000' : l.id === 'L6' ? 'linear-gradient(90deg,#000,transparent)' : '#1B1913', color: '#FBE8C3', fontFamily: 'Georgia,serif', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>${l.img ? html`<img src=${l.img} alt="" style=${{ width: '100%', height: '100%', objectFit: 'cover' }} />` : l.id === 'L1' ? 'HS' : l.id === 'L6' ? '' : 'Aa'}</div>
            <div className="col grow" style=${{ minWidth: 0 }}><span className="ell" style=${{ fontWeight: sel === l.id ? 700 : 500 }}>${l.name}</span><span className="faint ell" style=${{ fontSize: 11 }}>${l.kind}</span></div>
            ${l.lock ? html`<span className="faint"><${Icon} n="lock" s=${12} /></span>` : null}</div>`)}</div>
        </aside>
        <main className="dots" style=${{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0 }}>
          <div ref=${canvas} style=${{ position: 'relative', width: 'min(640px, 80%)', aspectRatio: '1', boxShadow: '0 20px 50px var(--shadow)', transform: `scale(${zoom / 59})`, transition: 'transform var(--d-m) var(--e-out)' }}>
            <img src=${IMG.sq} alt="Instagram image" style=${{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', opacity: opacity / 100 }} />
            ${Object.entries(hidden).filter(([, v]) => v).map(([id]) => { const l = layers.find((x) => x.id === id); return id === 'L7' || id === 'L6' ? null : html`<div key=${id} style=${{ position: 'absolute', left: l.box[0] + '%', top: l.box[1] + '%', width: l.box[2] + '%', height: l.box[3] + '%', background: '#1E1B15' }}></div>`; })}
            <div ref=${box} style=${{ position: 'absolute', left: L.box[0] + '%', top: L.box[1] + '%', width: L.box[2] + '%', height: L.box[3] + '%', border: '1.5px solid #FF5A1F', pointerEvents: 'none', transition: 'all var(--d-m) var(--e-out)' }}>
              ${[[-5, -5], ['calc(100% - 4px)', -5], [-5, 'calc(100% - 4px)'], ['calc(100% - 4px)', 'calc(100% - 4px)']].map((p, i) => html`<span key=${i} style=${{ position: 'absolute', left: p[0], top: p[1], width: 8, height: 8, background: '#fff', border: '1.5px solid #FF5A1F' }}></span>`)}
              <span className="mono" style=${{ position: 'absolute', left: 0, bottom: -24, padding: '2px 6px', borderRadius: 3, background: '#FF5A1F', color: '#fff', fontSize: 10, whiteSpace: 'nowrap' }}>x ${Math.round(L.box[0] * 10.8)} · y ${Math.round(L.box[1] * 10.8)} · ${Math.round(L.box[2] * 10.8)} × ${Math.round(L.box[3] * 10.8)}</span>
            </div>
          </div>
          ${edits || saved ? html`<${DraftPillImg} edits=${edits} saved=${saved} onSave=${save} onDiscard=${() => { setEdits(0); setHidden({}); setOpacity(100); toast('Edits discarded'); }} />` : null}
          <div className="row mono" style=${{ position: 'absolute', left: '50%', bottom: 18, transform: 'translateX(-50%)', gap: 6, padding: '6px 10px', borderRadius: 10, background: 'var(--panel)', boxShadow: '0 0 0 1px var(--line), 0 8px 20px var(--shadow)', fontSize: 12 }}><button className="btn icon sm ghost" onClick=${() => setZoom(Math.max(30, zoom - 10))} aria-label="Zoom out">−</button><span style=${{ width: 36, textAlign: 'center' }}>${zoom}%</span><button className="btn icon sm ghost" onClick=${() => setZoom(Math.min(100, zoom + 10))} aria-label="Zoom in">+</button><span style=${{ width: 1, height: 16, background: 'var(--line)' }}></span><button className="btn sm ghost" onClick=${() => setZoom(59)}>Fit</button></div>
        </main>
        <aside className="side" data-part="r" style=${{ borderLeft: '1px solid var(--line)', overflow: 'auto' }}>
          <div className="ptabs"><button>Chat</button><button className="on">Layer</button></div>
          <div className="row" style=${{ padding: 12, borderBottom: '1px solid var(--line2)' }}><span style=${{ width: 24, height: 24, borderRadius: 6, background: 'var(--field)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Georgia,serif' }}>${L.id === 'L7' ? '▣' : 'T'}</span><div className="col grow"><b className="ell">${L.name}</b><span className="faint" style=${{ fontSize: 11 }}>${L.kind}</span></div></div>
          <div className="sec"><h4>Position</h4><div className="row" style=${{ gap: 6 }}><div className="field grow"><small>X</small>${Math.round(L.box[0] * 10.8)}</div><div className="field grow"><small>Y</small>${Math.round(L.box[1] * 10.8)}</div><div className="field grow"><small>↻</small>0°</div></div><div className="row" style=${{ gap: 6 }}><div className="field grow"><small>W</small>${Math.round(L.box[2] * 10.8)}</div><div className="field grow"><small>H</small>${Math.round(L.box[3] * 10.8)}</div><button className="btn icon sm" aria-label="Lock ratio"><${Icon} n="link" s=${13} /></button></div></div>
          <div className="sec"><h4>Layer</h4><div className="row" style=${{ gap: 6 }}><div className="field" style=${{ flex: 1.4 }}><span className="grow">Normal</span><${Icon} n="chevron" s=${11} c="var(--faint)" /></div><label className="field" style=${{ flex: 1 }}><input type="number" min="0" max="100" value=${opacity} onChange=${(e) => { setOpacity(+e.target.value); edit(); }} />%</label></div></div>
          ${L.kind.startsWith('Text') ? html`<div className="sec"><h4>Typography</h4><div className="field"><span className="grow">Newsreader</span><${Icon} n="chevron" s=${11} c="var(--faint)" /></div><div className="row" style=${{ gap: 6 }}><div className="field" style=${{ flex: 1.4 }}><span className="grow">Regular</span></div><div className="field" style=${{ flex: 1 }}>58</div></div></div>
          <div className="sec"><h4>Fill</h4><div className="row" style=${{ gap: 6 }}>${['FBE8C3', 'DAC5A3', 'E86808', 'FFFFFF'].map((h, i) => html`<button key=${h} onClick=${edit} aria-label=${'#' + h} style=${{ width: 26, height: 26, borderRadius: 6, border: 0, background: '#' + h, boxShadow: i === 0 ? '0 0 0 2px var(--panel), 0 0 0 3.5px #FF5A1F' : 'inset 0 0 0 1px rgba(0,0,0,.15)' }}></button>`)}</div></div>` : null}
          <div className="sec"><h4>Effects <button className="btn icon sm ghost" aria-label="Add effect" onClick=${() => { edit(); toast('Drop shadow added'); }}>+</button></h4><span className="faint" style=${{ fontSize: 11 }}>No effects · add a shadow or blur</span></div>
        </aside>
      </div></${MS.React.Fragment}>`;
  }
  function DraftPillImg(p) { return html`<${DraftPill} ...${p} label="Image" />`; }

  Object.assign(MS, { CreativePage, runChange, updC });
})();
