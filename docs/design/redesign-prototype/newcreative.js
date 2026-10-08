/* New creative: brief, assets, format board, generation. */
(function () {
  const { html, useState, useEffect, useLayoutEffect, useRef, get, set, useStore, motion, Icon, ChannelChip, Toggle, Spinner, toast, wait, now, nav, Popover, togglePop, fmt } = MS;
  const { IMG, FORMATS } = MSDATA;

  const SUGGEST = {
    'Teaser for the new case': "A 6-second teaser for this week's case. Open on the crime scene, keep it sepia, reveal the one orange clue last, and close on the logo.",
    'Feature announcement': 'Announce that Half Story now runs in six languages. Calm, confident, one line per scene, end on “A new case every Monday.”',
    'App Store screenshots': 'Three App Store screenshots that show questioning a suspect, the city map and the case report, each with a short caption.',
  };

  function NewCreativePage({ route }) {
    const existing = useStore((s) => (route.edit ? s.creatives.find((c) => c.id === route.edit) : null));
    const [brief, setBrief] = useState(existing ? existing.brief.goal : route.draft ? 'Three App Store screenshots that show questioning a suspect, the city map and the case report.' : '');
    const [msg, setMsg] = useState(existing ? existing.brief.message : 'A crime a week. A whole city to question.');
    const [len, setLen] = useState(6);
    const [useBrand, setUseBrand] = useState(true);
    const [picked, setPicked] = useState(['a3', 'a4']);
    const [sel, setSel] = useState(() => new Set(existing ? existing.outputs.map((o) => o.fid) : route.draft ? ['as-69'] : ['ig-reel', 'ig-square', 'tt-video', 'yt-shorts']));
    const [kind, setKind] = useState('all');
    const [q, setQ] = useState('');
    const [more, setMore] = useState(new Set(route.draft ? ['App Store'] : []));
    const [saved, setSaved] = useState(now());
    const assets = useStore((s) => s.assets);
    const ta = useRef(null), root = MS.useEnter([]);
    useEffect(() => { const i = setTimeout(() => setSaved(now()), 900); return () => clearTimeout(i); }, [brief, msg, len, sel.size]);
    const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const chosen = FORMATS.filter((f) => sel.has(f.id));
    const vids = chosen.filter((f) => f.kind === 'video'); const imgs = chosen.filter((f) => f.kind === 'image');
    const vertical = vids.filter((f) => f.ratio === '9:16');
    const linked = vertical.length > 1 ? vertical.length - 1 : 0;
    const renders = vids.length - linked;
    const est = chosen.length ? `about ${3 + renders * 3}–${5 + renders * 4} min · roughly ${18 + renders * 14 + imgs.length * 6}–${28 + renders * 20 + imgs.length * 9}k tokens` : 'pick at least one format';
    const groups = ['Instagram', 'TikTok', 'YouTube', 'Facebook', 'LinkedIn', 'X', 'Pinterest', 'App Store', 'Google Play'];
    const shown = (f) => (kind === 'all' || f.kind === kind) && (!q || (f.channel + ' ' + f.name).toLowerCase().includes(q.toLowerCase()));
    const primary = ['Instagram', 'TikTok', 'YouTube'];
    const visibleGroups = groups.filter((g) => primary.includes(g) || more.has(g) || q);
    const hiddenGroups = groups.filter((g) => !visibleGroups.includes(g));
    const generate = () => {
      if (!brief.trim()) { motion.flash(ta.current); ta.current.focus(); toast('Describe what you want to make first'); return; }
      if (!chosen.length) { toast('Pick at least one format'); return; }
      const id = 'c' + Date.now(); const title = brief.split(/[.,]/)[0].replace(/^(A|An) /, '').slice(0, 40);
      const first9 = vertical[0];
      const outputs = chosen.map((f) => (f.ratio === '9:16' && f.kind === 'video' && first9 && f.id !== first9.id ? { fid: f.id, follows: first9.id } : { fid: f.id, versions: [], star: 0, editing: 0, img: f.kind === 'video' ? IMG.r45 : IMG.sq, pending: true }));
      const c = { id, title: title.charAt(0).toUpperCase() + title.slice(1), updated: 'Just now', state: 'running', brief: { goal: brief, message: msg, length: len }, outputs, chat: [{ id: 'u0', who: 'you', at: now(), text: brief }], comments: [], working: { step: 'Reading the brief and the brand', progress: 5 } };
      set((s) => ({ creatives: [c, ...s.creatives] }));
      nav({ name: 'creative', pid: 'hs', cid: id, view: 'canvas' });
      runFirst(id);
    };
    return html`<div className="app">
      <div className="topbar"><button className="btn" style=${{ paddingLeft: 6 }} onClick=${() => nav({ name: 'project', pid: 'hs', tab: 'creatives' })}><${Icon} n="back" s=${16} w=${1.5} />Creatives</button><span className="muted">Half Story</span><span className="faint">/</span><b className="b">${existing ? 'Edit brief · ' + existing.title : 'New creative'}</b><div className="grow"></div><span className="faint" style=${{ fontSize: 12 }}>Draft saved ${saved}</span><${MS.Bell} /><${MS.Avatar} /></div>
      <div ref=${root} className="grow" style=${{ display: 'grid', gridTemplateColumns: '540px minmax(0,1fr)', minHeight: 0 }}>
        <div className="col scroll" style=${{ borderRight: '1px solid var(--line)', background: 'var(--panel)', padding: '26px 28px', gap: 22, overflow: 'auto' }}>
          <div className="col" style=${{ gap: 10 }} data-enter>
            <label htmlFor="brief" style=${{ fontSize: 20, fontWeight: 700, letterSpacing: '-.015em' }}>What do you want to make?</label>
            <div className="col" style=${{ borderRadius: 14, background: 'var(--field)', padding: '14px 14px 10px', gap: 10, boxShadow: 'inset 0 0 0 1px var(--line)' }}>
              <textarea id="brief" ref=${ta} rows="4" value=${brief} onInput=${(e) => setBrief(e.target.value)} placeholder="Describe the idea: what happens, the mood, how it ends." style=${{ resize: 'none', border: 0, outline: 'none', background: 'transparent', fontSize: 15, lineHeight: 1.5 }}></textarea>
              <div className="row" style=${{ gap: 6 }}><span className="chip" style=${{ height: 26, background: 'var(--panel)' }}><span className="hs" style=${{ width: 18, height: 18, fontSize: 8 }}>HS</span>Brand kit</span><span className="chip" style=${{ height: 26, background: 'var(--panel)' }}>${picked.length} assets</span><span className="faint" style=${{ marginLeft: 'auto', fontSize: 11 }}>${brief.length} / 2000</span></div>
            </div>
            <div className="row" style=${{ gap: 6, flexWrap: 'wrap' }}><span className="faint" style=${{ fontSize: 12 }}>Try</span>${Object.keys(SUGGEST).map((k) => html`<button key=${k} className="chip" onClick=${() => { setBrief(SUGGEST[k]); if (k === 'App Store screenshots') { setSel(new Set(['as-69'])); setMore(new Set(['App Store'])); } motion.flash(ta.current.parentElement); }}>${k}</button>`)}</div>
          </div>
          <div className="col" style=${{ gap: 6 }} data-enter><label className="lbl" htmlFor="km">Key message <span className="faint" style=${{ fontWeight: 400 }}>· shown on screen</span></label><input id="km" className="input" value=${msg} onInput=${(e) => setMsg(e.target.value)} style=${{ fontSize: 14 }} /></div>
          <div className="col" style=${{ gap: 8 }} data-enter><div className="row" style=${{ justifyContent: 'space-between' }}><span className="lbl">Video length</span><span className="faint" style=${{ fontSize: 11 }}>${vids.length ? `for the ${vids.length} video format${vids.length > 1 ? 's' : ''}` : 'no video formats selected'}</span></div>
            <div className="seg" style=${{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', opacity: vids.length ? 1 : .5 }}>${[6, 15, 30, 60, 'Custom'].map((v) => html`<button key=${v} className=${len === v ? 'on' : ''} style=${{ justifyContent: 'center' }} onClick=${() => setLen(v)}>${typeof v === 'number' ? v + ' s' : v}</button>`)}</div></div>
          <div className="col" style=${{ gap: 8 }} data-enter><div className="row" style=${{ justifyContent: 'space-between' }}><span className="lbl">Assets to use</span><div style=${{ position: 'relative' }}><button className="btn sm ghost" data-pop="lib" onClick=${() => togglePop('lib')} style=${{ color: 'var(--accentText)' }}>Browse library</button>
              <${Popover} id="lib" width=${360} style=${{ right: 0, top: 32 }}><span className="cap" style=${{ display: 'block', padding: '4px 6px 8px' }}>Half Story library</span><div style=${{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>${assets.filter((a) => a.kind !== 'font').map((a) => html`<button key=${a.id} onClick=${() => setPicked((p) => (p.includes(a.id) ? p.filter((x) => x !== a.id) : [...p, a.id]))} style=${{ position: 'relative', height: 74, borderRadius: 8, border: 0, padding: 0, overflow: 'hidden', background: a.img ? '#000' : '#1B1913', color: '#fff', fontSize: 9, fontWeight: 800, boxShadow: picked.includes(a.id) ? '0 0 0 2px #FF5A1F' : 'none' }}>${a.img ? html`<img src=${a.img} alt=${a.name} style=${{ width: '100%', height: '100%', objectFit: 'cover' }} />` : a.id === 'a1' ? 'HALF STORY' : 'ICON'}</button>`)}</div></${Popover}></div></div>
            <div className="row" style=${{ gap: 8 }}>${picked.map((id) => { const a = assets.find((x) => x.id === id); return html`<button key=${id} onClick=${() => setPicked((p) => p.filter((x) => x !== id))} title="Remove" style=${{ position: 'relative', width: 72, height: 72, borderRadius: 8, overflow: 'hidden', border: 0, padding: 0, boxShadow: '0 0 0 2px #FF5A1F', background: a.img ? '#000' : '#1B1913', color: '#fff', fontSize: 10, fontWeight: 800 }}>${a.img ? html`<img src=${a.img} alt=${a.name} style=${{ width: '100%', height: '100%', objectFit: 'cover' }} />` : a.name.split(',')[0]}<span style=${{ position: 'absolute', right: 4, top: 4, width: 18, height: 18, borderRadius: '50%', background: '#FF5A1F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><${Icon} n="check" s=${10} w=${2.4} c="#fff" /></span></button>`; })}
              <button className="btn" data-pop="lib" onClick=${() => togglePop('lib')} style=${{ width: 72, height: 72, borderRadius: 8, background: 'transparent', boxShadow: 'inset 0 0 0 1.5px var(--line)', borderStyle: 'dashed' }} aria-label="Add assets"><${Icon} n="plus" s=${16} /></button></div>
            <span className="faint" style=${{ fontSize: 12 }}>The logo and fonts come from the brand kit automatically.</span></div>
          <div className="row" data-enter style=${{ gap: 12, padding: 12, borderRadius: 12, boxShadow: 'inset 0 0 0 1px var(--line2)' }}>
            <div className="row" style=${{ gap: 0 }}>${['#1B1913', '#856E51', '#DAC5A3', '#E86808'].map((c, i) => html`<span key=${c} style=${{ width: 22, height: 22, borderRadius: '50%', background: c, boxShadow: '0 0 0 2px var(--panel)', marginLeft: i ? -6 : 0 }}></span>`)}</div>
            <div className="col grow"><b className="b">Follows the Half Story brand</b><span className="muted ell" style=${{ fontSize: 12 }}>Newsreader · sepia ink · measured, atmospheric noir</span></div>
            <${Toggle} on=${useBrand} onChange=${setUseBrand} label="Follow the brand" /></div>
        </div>
        <div className="dots col scroll" style=${{ padding: '26px 32px', gap: 18, overflow: 'auto', minWidth: 0 }}>
          <div className="row" style=${{ gap: 12 }}><h2 style=${{ margin: 0, fontSize: 20, letterSpacing: '-.015em' }}>Where will it be published?</h2><div className="grow"></div>
            <div className="seg" style=${{ background: 'var(--panel)', boxShadow: '0 0 0 1px var(--line)' }}>${[['all', 'All'], ['video', 'Video'], ['image', 'Image']].map(([k, l]) => html`<button key=${k} className=${kind === k ? 'on' : ''} onClick=${() => setKind(k)} style=${kind === k ? { background: 'var(--field)', boxShadow: 'none' } : {}}>${k !== 'all' ? html`<${Icon} n=${k} s=${12} />` : null}${l}</button>`)}</div>
            <label className="search" style=${{ width: 200 }}><${Icon} n="search" s=${14} /><input placeholder="Search formats" value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="Search formats" /></label></div>
          ${visibleGroups.map((g) => { const fs = FORMATS.filter((f) => f.channel === g && shown(f)); if (!fs.length) return null; const n = fs.filter((f) => sel.has(f.id)).length; return html`<div key=${g} className="col" style=${{ gap: 10 }}>
            <div className="row"><${ChannelChip} k=${fs[0].ch} lg=${true} /><b className="b">${g}</b>${n ? html`<span className="faint" style=${{ fontSize: 12 }}>${n} selected${fs.some((f) => f.linkable && sel.has(f.id)) && vertical.length > 1 ? ' · same file as the Reel' : ''}</span>` : null}</div>
            <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0,1fr))', gap: 10 }}>${fs.map((f) => html`<${Tile} key=${f.id} f=${f} on=${sel.has(f.id)} linked=${f.ratio === '9:16' && f.kind === 'video' && vertical.length > 1 && vertical[0].id !== f.id && sel.has(f.id)} onClick=${() => toggle(f.id)} />`)}</div></div>`; })}
          ${hiddenGroups.length ? html`<div className="col" style=${{ gap: 10 }}><span className="lbl muted">More channels</span><div className="row" style=${{ gap: 8, flexWrap: 'wrap' }}>${hiddenGroups.map((g) => { const f = FORMATS.find((x) => x.channel === g); return html`<button key=${g} className="btn outline" onClick=${() => setMore((m) => new Set([...m, g]))}><${ChannelChip} k=${f.ch} lg=${true} />${g}<span className="faint" style=${{ fontSize: 11 }}>${FORMATS.filter((x) => x.channel === g).length}</span></button>`; })}<button className="btn outline" style=${{ boxShadow: 'none', outline: '1px dashed var(--line)' }} onClick=${() => toast('Custom sizes: pick width, height and length')}>+ Custom size</button></div></div>` : null}
        </div>
      </div>
      <div className="row" style=${{ height: 64, flex: 'none', padding: '0 20px', background: 'var(--panel)', borderTop: '1px solid var(--line)', gap: 14 }}>
        <div className="row" style=${{ gap: 6 }}>${chosen.filter((f) => !(f.ratio === '9:16' && f.kind === 'video' && vertical[0] && f.id !== vertical[0].id)).slice(0, 5).map((f) => { const h = 40, w = Math.max(14, Math.min(64, Math.round(h * f.w / f.h))); return html`<span key=${f.id} style=${{ width: w, height: h, borderRadius: 3, background: 'var(--sel)', boxShadow: 'inset 0 0 0 1.5px #FF5A1F' }}></span>`; })}</div>
        <div className="col"><b className="b">${chosen.length} format${chosen.length === 1 ? '' : 's'} · ${renders} video render${renders === 1 ? '' : 's'} + ${imgs.length} image${imgs.length === 1 ? '' : 's'}</b><span className="muted" style=${{ fontSize: 12 }}>${linked ? `${linked} reuse${linked > 1 ? '' : 's'} the ${vertical[0].channel} ${vertical[0].name} · ` : ''}${est}</span></div>
        <div className="grow"></div>
        <button className="btn lg ghost" onClick=${() => { toast('Draft saved', { tone: 'ok' }); nav({ name: 'project', pid: 'hs', tab: 'creatives' }); }}>Save draft</button>
        <button className="btn lg accent" onClick=${generate}>Generate <span className="mono" style=${{ fontSize: 11, opacity: .8 }}>⌘↵</span></button>
      </div></div>`;
  }
  function Tile({ f, on, linked, onClick }) {
    const ref = useRef(null);
    const first = useRef(true);
    useLayoutEffect(() => { if (first.current) { first.current = false; return; } motion.anim(ref.current, [{ transform: 'scale(.96)' }, { transform: 'scale(1)' }], 260, motion.E.spring); }, [on]);
    const h = 48, w = Math.max(18, Math.min(56, Math.round(h * f.w / f.h)));
    return html`<button ref=${ref} onClick=${onClick} aria-pressed=${on} style=${{ position: 'relative', height: 112, borderRadius: 12, border: 0, padding: 10, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', textAlign: 'left', background: 'var(--panel)', boxShadow: on ? '0 0 0 2px #FF5A1F' : '0 0 0 1px var(--line)', transition: 'box-shadow var(--d-s)' }}>
      <div className="row" style=${{ height: 50, gap: 6 }}><span style=${{ width: w, height: Math.round(w * f.h / f.w) > 50 ? 48 : Math.round(w * f.h / f.w), borderRadius: 4, background: on ? 'var(--sel)' : 'var(--field)', boxShadow: `inset 0 0 0 1.5px ${on ? '#FF5A1F' : 'var(--line)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: on ? '#FF5A1F' : 'var(--faint)', transition: 'all var(--d-s)' }}><${Icon} n=${f.kind === 'video' ? 'play' : 'image'} s=${12} fill=${f.kind === 'video' ? 'currentColor' : 'none'} /></span>${linked ? html`<span className="faint" title="Same file as the first 9:16 video"><${Icon} n="link" s=${13} /></span>` : null}</div>
      <div className="col"><b className="b ell">${f.name}</b><span className="mono faint ell" style=${{ fontSize: 10.5 }}>${f.ratio} · ${f.note || f.kind}</span></div>
      ${on ? html`<span style=${{ position: 'absolute', right: 8, top: 8, width: 18, height: 18, borderRadius: '50%', background: '#FF5A1F', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><${Icon} n="check" s=${10} w=${2.4} c="#fff" /></span>` : null}</button>`;
  }

  async function runFirst(cid) {
    const upd = MS.updC;
    const step = async (t, p, ms = 1300) => {
      upd(cid, (c) => { c.chat.push({ id: 't' + Date.now(), who: 'agent', kind: 'typing', at: now() }); return c; });
      await wait(ms);
      upd(cid, (c) => { c.chat = c.chat.filter((m) => m.kind !== 'typing'); c.chat.push({ id: 's' + Date.now(), who: 'agent', kind: 'step', at: now(), text: t }); c.working = { step: t, progress: p }; return c; });
      set((s) => ({ tokens: s.tokens + 2.1 }));
    };
    const c0 = get().creatives.find((x) => x.id === cid);
    set((s) => ({ jobs: [{ id: 'job-' + cid, title: c0.title, step: 'Reading the brief', progress: 5, img: IMG.r25 }, ...s.jobs] }));
    await step('Read the brief, the brand kit and 2 assets', 15);
    await step('Planned 3 scenes: crime scene, ink bleed, Calder at night', 30);
    await step('Wrote the composition and downloaded Newsreader', 45);
    await step('Rendering ' + c0.outputs.filter((o) => !o.follows).length + ' formats', 70, 1800);
    await step('Checked sizes, lengths and safe zones', 100, 1000);
    upd(cid, (c) => { c.outputs.forEach((o) => { if (!o.follows) { o.versions = [{ n: 1, at: now(), by: 'Agent', note: 'First render from the brief', img: o.img }]; o.star = 1; o.editing = 1; o.pending = false; } }); c.working = null; c.state = 'ready'; c.updated = 'Just now'; c.chat.push({ id: 'r' + Date.now(), who: 'agent', kind: 'result', at: now(), text: `Version 1 is ready: ${c.outputs.length} formats, all checks passed. Click any frame to comment, or open a format to edit it directly.` }); return c; });
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== 'job-' + cid), done: [{ id: 'd' + Date.now(), text: `${c0.title}: version 1 ready`, at: now(), ok: true }, ...s.done] }));
    toast(`${c0.title} is ready`, { tone: 'ok', action: { label: 'Open', run: () => nav({ name: 'creative', pid: 'hs', cid, view: 'canvas' }) } });
  }

  MS.NewCreativePage = NewCreativePage;
})();
