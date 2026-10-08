/* Modal host: export, compare versions, native-like folder picker. */
(function () {
  const { html, useState, useEffect, useLayoutEffect, useRef, get, set, useStore, motion, Icon, ChannelChip, Check, Spinner, toast, wait, now, fmt } = MS;

  function Modal({ children, width = 760, onClose, label }) {
    const ref = useRef(null), scrim = useRef(null);
    useLayoutEffect(() => { motion.anim(scrim.current, [{ opacity: 0 }, { opacity: 1 }], 200, motion.E.std); motion.anim(ref.current, [{ opacity: 0, transform: 'translate(-50%,-48%) scale(.97)' }, { opacity: 1, transform: 'translate(-50%,-50%)' }], 320, motion.E.out); }, []);
    const close = () => { Promise.all([motion.exit(ref.current, { ms: 150 }), motion.exit(scrim.current, { ms: 200 })]).then(onClose); };
    useEffect(() => { const k = (e) => { if (e.key === 'Escape') close(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
    return html`<${MS.React.Fragment}><div className="scrim" ref=${scrim} onClick=${close}></div><div className="dialog" ref=${ref} role="dialog" aria-label=${label} style=${{ left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width, maxHeight: 'calc(100vh - 64px)' }}>${children(close)}</div></${MS.React.Fragment}>`;
  }
  function ModalHost() {
    const m = useStore((s) => s.modal);
    if (!m) return null;
    const close = () => set({ modal: null });
    const C = { export: ExportDialog, compare: CompareDialog, review: MS.BrandReview, analyze: MS.AnalyzeDialog }[m.type];
    return C ? html`<${C} key=${m.type} m=${m} onClose=${close} />` : null;
  }

  /* ---------- folder picker (simulated macOS sheet) ---------- */
  function FolderPicker({ onPick, onCancel }) {
    const ref = useRef(null);
    const [sel, setSel] = useState('Half Story');
    useLayoutEffect(() => { motion.anim(ref.current, [{ transform: 'translateY(-100%)' }, { transform: 'none' }], 320, motion.E.out); }, []);
    const tree = [['Desktop', ['Half Story', 'Screenshots']], ['Documents', ['Half Story', 'Invoices']], ['Movies', []]];
    return html`<div style=${{ position: 'absolute', inset: 0, zIndex: 5, background: 'rgba(0,0,0,.12)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
      <div ref=${ref} style=${{ width: 520, background: 'var(--panel)', borderRadius: '0 0 12px 12px', boxShadow: '0 20px 50px var(--shadowLg)', overflow: 'hidden' }}>
        <div className="row" style=${{ height: 40, padding: '0 12px', borderBottom: '1px solid var(--line2)', background: 'var(--bg)' }}><span className="row" style=${{ gap: 6 }}><span style=${{ width: 11, height: 11, borderRadius: '50%', background: '#FF5F57' }}></span><span style=${{ width: 11, height: 11, borderRadius: '50%', background: '#FEBC2E' }}></span><span style=${{ width: 11, height: 11, borderRadius: '50%', background: '#28C840' }}></span></span><b style=${{ margin: '0 auto' }}>Choose a folder</b><span style=${{ width: 50 }}></span></div>
        <div style=${{ display: 'grid', gridTemplateColumns: '150px 1fr', height: 220 }}>
          <div className="col" style=${{ padding: 8, gap: 2, borderRight: '1px solid var(--line2)', background: 'var(--bg)' }}><span className="cap" style=${{ padding: '4px 6px', fontSize: 10 }}>Favorites</span>${['Desktop', 'Documents', 'Downloads', 'Movies'].map((f) => html`<span key=${f} className="row" style=${{ height: 26, padding: '0 6px', gap: 6, fontSize: 12, borderRadius: 6, background: f === 'Desktop' ? 'var(--field)' : 'transparent' }}><${Icon} n="folder" s=${13} />${f}</span>`)}</div>
          <div className="col" style=${{ padding: 8, gap: 2 }}>${tree[0][1].concat(['New folder…']).map((f) => html`<button key=${f} className="row" onClick=${() => setSel(f)} onDoubleClick=${() => onPick('~/Desktop/' + f)} style=${{ height: 28, padding: '0 8px', gap: 8, borderRadius: 6, border: 0, textAlign: 'left', background: sel === f ? '#0A66FF' : 'transparent', color: sel === f ? '#fff' : 'var(--text)' }}><${Icon} n=${f === 'New folder…' ? 'plus' : 'folder'} s=${14} />${f}</button>`)}</div>
        </div>
        <div className="row" style=${{ padding: 10, justifyContent: 'flex-end', borderTop: '1px solid var(--line2)' }}><button className="btn sm outline" onClick=${onCancel}>Cancel</button><button className="btn sm" style=${{ background: '#0A66FF', color: '#fff' }} onClick=${() => onPick('~/Desktop/' + sel)}>Choose</button></div>
      </div></div>`;
  }

  /* ---------- export ---------- */
  function ExportDialog({ m, onClose }) {
    const c = useStore((s) => s.creatives.find((x) => x.id === m.cid));
    const outs = c.outputs;
    const [on, setOn] = useState(() => Object.fromEntries(outs.map((o) => [o.fid, true])));
    const [dest, setDest] = useState('~/Desktop/Half Story');
    const [picking, setPicking] = useState(false);
    const [phase, setPhase] = useState('idle');
    const [prog, setProg] = useState(0);
    const size = (o) => (fmt(o.fid).kind === 'video' ? 6.2 : 2.1);
    const chosen = outs.filter((o) => on[o.fid]);
    const total = chosen.reduce((a, o) => a + size(o), 0);
    const name = (o) => `half-story-${fmt(o.fid).channel.toLowerCase().replace(/\s+/g, '-')}-${fmt(o.fid).name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-v${o.follows ? (outs.find((x) => x.fid === o.follows) || {}).star : o.star}.${fmt(o.fid).kind === 'video' ? 'mp4' : 'png'}`;
    const run = async () => { setPhase('run'); for (let i = 1; i <= chosen.length; i++) { await wait(450); setProg(i); } await wait(250); setPhase('done'); set((s) => ({ done: [{ id: 'x' + Date.now(), text: `${chosen.length} files exported to ${dest}`, at: now(), ok: true }, ...s.done] })); };
    return html`<${Modal} width=${760} label="Export" onClose=${onClose}>${(close) => html`<div style=${{ position: 'relative' }}>
      <div className="row" style=${{ padding: '18px 22px', borderBottom: '1px solid var(--line2)', gap: 12 }}><div className="col"><h2 style=${{ margin: 0, fontSize: 18, letterSpacing: '-.01em' }}>Export “${c.title}”</h2><span className="muted">The starred version of each format, ready to post.</span></div><button className="btn icon" style=${{ marginLeft: 'auto' }} aria-label="Close" onClick=${close}><${Icon} n="close" s=${13} w=${1.6} /></button></div>
      ${phase === 'done' ? html`<div className="col" style=${{ padding: '34px 22px', alignItems: 'center', gap: 10, textAlign: 'center' }}>
          <span ref=${(el) => el && motion.pop(el)} style=${{ width: 54, height: 54, borderRadius: '50%', background: 'var(--okBg)', color: 'var(--ok)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><${Icon} n="check" s=${24} w=${2.2} /></span>
          <b style=${{ fontSize: 17 }}>${chosen.length} files exported</b><span className="muted mono" style=${{ fontSize: 12 }}>${dest}</span>
          <div className="row" style=${{ marginTop: 8 }}><button className="btn outline" onClick=${() => { toast('Opened ' + dest + ' in Finder', { tone: 'ok' }); }}><${Icon} n="folder" s=${14} />Show in Finder</button><button className="btn ink" onClick=${close}>Done</button></div></div>`
      : html`<${MS.React.Fragment}>
      <div style=${{ padding: '8px 12px' }}>
        <div style=${{ display: 'grid', gridTemplateColumns: '28px 52px minmax(0,1fr) 120px 84px', gap: '0 12px', padding: '8px 10px' }} className="cap"><span></span><span></span><span>Format</span><span>Version</span><span style=${{ textAlign: 'right' }}>Size</span></div>
        ${outs.map((o, i) => { const f = fmt(o.fid); const base = o.follows ? outs.find((x) => x.fid === o.follows) : o; const latest = base.versions ? Math.max(...base.versions.map((v) => v.n)) : base.star; return html`<div key=${o.fid} style=${{ display: 'grid', gridTemplateColumns: '28px 52px minmax(0,1fr) 120px 84px', gap: '0 12px', alignItems: 'center', padding: '8px 10px', borderRadius: 10, background: i === 0 ? 'var(--field)' : 'transparent', opacity: on[o.fid] ? 1 : .5, transition: 'opacity var(--d-s)' }}>
          <${Check} on=${on[o.fid]} label=${'Export ' + f.name} onChange=${(v) => setOn({ ...on, [o.fid]: v })} />
          <div style=${{ width: f.w > f.h ? 52 : f.w === f.h ? 44 : 30, height: f.w > f.h ? 30 : f.w === f.h ? 44 : 52, borderRadius: 4, overflow: 'hidden' }}><img src=${o.img || base.img} alt="" style=${{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>
          <div className="col" style=${{ minWidth: 0 }}><span className="row" style=${{ gap: 6 }}><${ChannelChip} k=${f.ch} /><b className="b">${f.channel} ${f.name}</b></span><span className="mono faint ell" style=${{ fontSize: 11 }}>${name(o)}</span></div>
          ${o.follows ? html`<span className="muted" style=${{ fontSize: 12 }}>follows Reel</span>` : html`<span className="row" style=${{ height: 30, padding: '0 10px', borderRadius: 7, background: 'var(--panel)', boxShadow: '0 0 0 1px var(--line)', fontWeight: 600, gap: 6 }}>★ v${o.star}${latest > o.star ? html`<span style=${{ fontWeight: 400, fontSize: 11, color: 'var(--accentText)' }}>v${latest} newer</span>` : null}</span>`}
          <span className="mono" style=${{ textAlign: 'right', fontSize: 12 }}>${size(o).toFixed(1)} MB</span></div>`; })}
      </div>
      <div style=${{ display: 'grid', gridTemplateColumns: '120px minmax(0,1fr)', gap: 10, alignItems: 'center', padding: '14px 22px', borderTop: '1px solid var(--line2)' }}>
        <span className="b">Save to</span><div className="row"><div className="row grow" style=${{ height: 34, padding: '0 10px', borderRadius: 8, background: 'var(--field)' }}><${Icon} n="folder" s=${14} c="var(--muted)" /><span className="mono" style=${{ fontSize: 12 }}>${dest}</span><span className="faint" style=${{ marginLeft: 'auto', fontSize: 11 }}>last used</span></div><button className="btn outline" onClick=${() => setPicking(true)}>Choose…</button></div>
        <span className="b">File names</span><div className="row mono" style=${{ height: 34, padding: '0 10px', borderRadius: 8, background: 'var(--field)', fontSize: 12, gap: 6 }}>${['project', 'channel', 'format', 'version'].map((t, i) => html`<${MS.React.Fragment} key=${t}>${i ? '-' : ''}<span style=${{ padding: '1px 6px', borderRadius: 4, background: 'var(--panel)', boxShadow: '0 0 0 1px var(--line)' }}>${t}</span></${MS.React.Fragment}>`)}</div>
      </div>
      <div className="row" style=${{ padding: '14px 22px', borderTop: '1px solid var(--line2)', background: 'var(--bg)', gap: 12 }}>
        ${phase === 'run' ? html`<div className="col grow" style=${{ gap: 6 }}><span>Exporting ${prog} of ${chosen.length}…</span><div className="bar"><i style=${{ width: (prog / chosen.length) * 100 + '%' }}></i></div></div>` : html`<div className="col grow"><b>${chosen.length} files · ${total.toFixed(1)} MB</b><span className="muted" style=${{ fontSize: 12 }}>Existing files are never overwritten</span></div>`}
        <button className="btn lg ghost" onClick=${close}>Cancel</button><button className="btn lg ink" disabled=${!chosen.length || phase === 'run'} onClick=${run}>${phase === 'run' ? html`<${Spinner} />` : null}Export ${chosen.length} files</button>
      </div></${MS.React.Fragment}>`}
      ${picking ? html`<${FolderPicker} onCancel=${() => setPicking(false)} onPick=${(p) => { setDest(p); setPicking(false); }} />` : null}
    </div>`}</${Modal}>`;
  }

  /* ---------- compare versions ---------- */
  function CompareDialog({ m, onClose }) {
    const c = useStore((s) => s.creatives.find((x) => x.id === m.cid));
    const o = c.outputs.find((x) => x.fid === m.fid);
    const vs = o.versions;
    const [a, setA] = useState(o.star); const [b, setB] = useState(Math.max(...vs.map((v) => v.n)));
    const [split, setSplit] = useState(50);
    const f = fmt(o.fid); const h = 520, w = Math.round(h * f.w / f.h);
    const img = (n) => (vs.find((v) => v.n === n) || vs[0]).img;
    return html`<${Modal} width=${Math.max(620, w + 300)} label="Compare versions" onClose=${onClose}>${(close) => html`<div className="row" style=${{ alignItems: 'stretch' }}>
      <div className="dots" style=${{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style=${{ position: 'relative', width: w, height: h, borderRadius: 4, overflow: 'hidden', boxShadow: '0 16px 40px var(--shadow)', cursor: 'ew-resize' }} onMouseMove=${(e) => { if (e.buttons) { const r = e.currentTarget.getBoundingClientRect(); setSplit(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100))); } }} onMouseDown=${(e) => { const r = e.currentTarget.getBoundingClientRect(); setSplit(((e.clientX - r.left) / r.width) * 100); }}>
          <img src=${img(b)} alt=${'v' + b} style=${{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          <div style=${{ position: 'absolute', inset: 0, clipPath: `inset(0 ${100 - split}% 0 0)` }}><img src=${img(a)} alt=${'v' + a} style=${{ width: '100%', height: '100%', objectFit: 'cover', filter: a !== b ? 'sepia(.25)' : 'none' }} /></div>
          <div style=${{ position: 'absolute', top: 0, bottom: 0, left: split + '%', width: 2, background: '#fff', boxShadow: '0 0 8px rgba(0,0,0,.5)' }}><span style=${{ position: 'absolute', top: '50%', left: -13, width: 28, height: 28, borderRadius: '50%', background: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#171717', fontSize: 12 }}>⇆</span></div>
          <span className="pill" style=${{ position: 'absolute', left: 8, top: 8, background: 'rgba(0,0,0,.6)', color: '#fff' }}>v${a}</span><span className="pill" style=${{ position: 'absolute', right: 8, top: 8, background: 'rgba(0,0,0,.6)', color: '#fff' }}>v${b}</span>
        </div></div>
      <div className="col" style=${{ width: 280, borderLeft: '1px solid var(--line2)' }}>
        <div className="row" style=${{ padding: '14px 16px', borderBottom: '1px solid var(--line2)' }}><b>Compare ${f.name}</b><button className="btn icon sm" style=${{ marginLeft: 'auto' }} aria-label="Close" onClick=${close}><${Icon} n="close" s=${12} /></button></div>
        ${[['Left', a, setA], ['Right', b, setB]].map(([l, v, sv]) => html`<div key=${l} className="col" style=${{ padding: '12px 16px', gap: 6 }}><span className="cap">${l}</span><div className="row" style=${{ gap: 4, flexWrap: 'wrap' }}>${vs.map((x) => html`<button key=${x.n} className=${'chip' + (x.n === v ? ' on' : '')} onClick=${() => sv(x.n)}>v${x.n}${o.star === x.n ? ' ★' : ''}</button>`)}</div><span className="muted" style=${{ fontSize: 12 }}>${(vs.find((x) => x.n === v) || {}).by} · ${(vs.find((x) => x.n === v) || {}).note}</span></div>`)}
        <div className="grow"></div>
        <div className="col" style=${{ padding: 16, gap: 8, borderTop: '1px solid var(--line2)' }}><button className="btn ink" onClick=${() => { MS.updC(c.id, (x) => { x.outputs.find((y) => y.fid === o.fid).star = b; return x; }); toast(`v${b} will be exported`, { tone: 'ok' }); close(); }}>★ Use v${b} for export</button><button className="btn" onClick=${() => { MS.updC(c.id, (x) => { x.outputs.find((y) => y.fid === o.fid).star = a; return x; }); toast(`v${a} will be exported`, { tone: 'ok' }); close(); }}>★ Use v${a} for export</button></div>
      </div></div>`}</${Modal}>`;
  }

  Object.assign(MS, { Modal, ModalHost, FolderPicker });
})();
