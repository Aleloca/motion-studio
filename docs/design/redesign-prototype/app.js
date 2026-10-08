/* App shell: router with page transitions, top bars, popovers, approvals, projects, project creatives. */
(function () {
  const { html, useState, useEffect, useLayoutEffect, useRef, get, set, useStore, motion, Icon, Logo, ChannelChip, Toggle, Spinner, toast, wait, now } = MS;
  const { IMG, FORMATS, creatives, brand, assets, references, permissions, projects } = MSDATA;
  const fmt = (id) => FORMATS.find((f) => f.id === id);

  /* ---------- initial state ---------- */
  set({
    theme: 'system', route: { name: 'projects' }, dir: 1, popover: null, modal: null, toasts: [],
    projects: projects.map((p) => ({ ...p })), creatives: creatives.map((c0) => { const c = JSON.parse(JSON.stringify(c0)); c.chat = c.chat || []; c.comments = c.comments || []; c.outputs.forEach((o) => { if (!o.follows && !o.versions) { o.versions = [{ n: 1, at: '14:00', by: 'Agent', note: 'First render from the brief', img: o.img }]; o.star = o.star || 1; o.editing = 1; } }); if (c.state === 'running') c.working = { step: c.step, progress: c.progress }; if (c.state === 'failed') c.chat.push({ id: 'e1', who: 'agent', kind: 'result', at: 'yesterday', text: c.error + '. Try again and I will cut it to 7 seconds.' }); return c; }),
    brand: JSON.parse(JSON.stringify(brand)), assets: assets.map((a) => ({ ...a })), references: references.map((r) => ({ ...r })), permissions: permissions.map((p) => ({ ...p })),
    settings: { autoApprove: true, confirmPaid: true, parallel: 2, notifyApproval: true, notifyReady: true, language: 'System · English', domains: ['cdn.half-story.com'] },
    approvals: [], jobs: [{ id: 'j-case092', title: 'Case 092 teaser', step: 'Rendering 210 frames', progress: 62, img: IMG.r25 }], done: [
      { id: 'd1', text: 'Reel v7 saved from your edits', at: '16:20', ok: true }, { id: 'd2', text: '4 files exported to ~/Desktop/Half Story', at: '15:43', ok: true }, { id: 'd3', text: 'Calder at night loop failed, too long', at: 'yesterday', ok: false }],
    tokens: 38.2, onboarded: true,
  });

  /* ---------- navigation ---------- */
  const DEPTH = { welcome: 0, pairing: 0, projects: 1, appSettings: 2, project: 2, newCreative: 3, creative: 3 };
  function nav(route) {
    const cur = get().route;
    const dir = (DEPTH[route.name] ?? 2) >= (DEPTH[cur.name] ?? 2) ? 1 : -1;
    set({ route, dir: route.name === cur.name ? 1 : dir, popover: null });
  }
  const routeKey = (r) => r.name === 'project' ? `project:${r.pid}` : r.name === 'creative' ? `creative:${r.cid}` : r.name;

  /* page host: keeps the leaving page for its exit animation, then mounts the new one */
  function PageHost({ route, render, keyOf = routeKey, soft }) {
    const key = keyOf(route);
    const dir = useStore((s) => s.dir);
    const [pages, setPages] = useState([{ key, route }]);
    useLayoutEffect(() => {
      setPages((ps) => (ps[ps.length - 1].key === key ? ps.map((p) => (p.key === key ? { key, route } : p)) : [...ps.filter((p) => !p.leaving).map((p) => ({ ...p, leaving: true })), { key, route }]));
    }, [key, route]);
    return html`<div className="main">${pages.map((p) => html`<${Page} key=${p.key} leaving=${p.leaving} dir=${dir} soft=${soft} onGone=${() => setPages((ps) => ps.filter((x) => x.key !== p.key))}>${render(p.route)}</${Page}>`)}</div>`;
  }
  function Page({ leaving, dir, soft, onGone, children }) {
    const ref = useRef(null);
    useLayoutEffect(() => {
      if (leaving) motion.exit(ref.current, { x: soft ? 0 : -dir * 16, ms: motion.D.s }).then(onGone);
      else motion.enter(ref.current, { x: soft ? 0 : dir * 24, y: soft ? 6 : 0, ms: motion.D.m });
    }, [leaving]);
    return html`<div className="page" ref=${ref} style=${{ pointerEvents: leaving ? 'none' : 'auto', zIndex: leaving ? 0 : 1 }}>${children}</div>`;
  }

  /* ---------- popovers ---------- */
  function Popover({ id, style, children, origin = 'top right', width }) {
    const open = useStore((s) => s.popover === id);
    const [shown, setShown] = useState(open);
    const ref = useRef(null);
    useEffect(() => { if (open) setShown(true); else if (shown) motion.exit(ref.current, { ms: motion.D.xs }).then(() => setShown(false)); }, [open]);
    useLayoutEffect(() => { if (open && ref.current) motion.anim(ref.current, [{ opacity: 0, transform: 'translateY(-4px) scale(.96)' }, { opacity: 1, transform: 'none' }], motion.D.s, motion.E.spring); }, [open, shown]);
    useEffect(() => {
      if (!open) return;
      const close = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest('[data-pop="' + id + '"]')) set({ popover: null }); };
      const esc = (e) => { if (e.key === 'Escape') set({ popover: null }); };
      setTimeout(() => document.addEventListener('mousedown', close), 0); document.addEventListener('keydown', esc);
      return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
    }, [open]);
    if (!shown) return null;
    return html`<div className="popover" ref=${ref} role="dialog" style=${{ transformOrigin: origin, width, ...style }}>${children}</div>`;
  }
  const togglePop = (id) => set((s) => ({ popover: s.popover === id ? null : id }));

  /* ---------- approvals (shared) ---------- */
  const resolvers = {};
  function requestApproval(a) {
    const id = 'ap' + Math.random().toString(36).slice(2, 7);
    const item = { id, created: Date.now(), ttl: 300, ...a };
    set((s) => ({ approvals: [...s.approvals, item] }));
    if (get().settings.notifyApproval) toast(a.title, { action: { label: 'Review', run: () => { if (a.cid) nav({ name: 'creative', pid: 'hs', cid: a.cid, view: 'canvas' }); else set({ popover: 'activity' }); } } });
    setTimeout(() => { const bell = document.querySelector('[data-bell]'); if (bell) motion.pop(bell); }, 50);
    return new Promise((r) => { resolvers[id] = r; });
  }
  function resolveApproval(id, decision) {
    const a = get().approvals.find((x) => x.id === id); if (!a) return;
    const el = document.querySelector(`[data-approval="${id}"]`);
    const finish = () => {
      set((s) => ({ approvals: s.approvals.filter((x) => x.id !== id) }));
      if (decision === 'always' && a.rule) set((s) => ({ permissions: [{ id: 'p' + Date.now(), icon: a.ruleIcon || 'terminal', label: a.ruleLabel || a.title, rule: a.rule, at: 'Just now' }, ...s.permissions] }));
      resolvers[id] && resolvers[id](decision); delete resolvers[id];
    };
    if (el) motion.exit(el, { y: -6, ms: motion.D.s }).then(finish); else finish();
    if (decision === 'always') toast('Saved to “Always allowed” in project settings', { tone: 'ok' });
  }
  function Ring({ created, ttl }) {
    const [t, setT] = useState(Date.now());
    useEffect(() => { const i = setInterval(() => setT(Date.now()), 1000); return () => clearInterval(i); }, []);
    const left = Math.max(0, ttl - (t - created) / 1000), frac = left / ttl;
    const m = Math.floor(left / 60), sec = String(Math.floor(left % 60)).padStart(2, '0');
    return html`<span className="row mono" style=${{ gap: 6, fontSize: 11, color: 'var(--warn)' }}><svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" className="ring-track"/><circle cx="12" cy="12" r="9" className="ring-prog" strokeDasharray="56.5" strokeDashoffset=${56.5 * (1 - frac)} transform="rotate(-90 12 12)"/></svg>${m}:${sec}</span>`;
  }
  function ApprovalCard({ a, context }) {
    const [cmd, setCmd] = useState(false);
    const ref = useRef(null);
    useLayoutEffect(() => { motion.enter(ref.current, { y: 10 }).then(() => motion.pulse(ref.current).then(() => motion.pulse(ref.current))); }, []);
    return html`<div ref=${ref} data-approval=${a.id} style=${{ borderRadius: 12, background: 'var(--warnBg)', boxShadow: 'inset 0 0 0 1px var(--warnLine)', padding: 12, display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div className="row"><span className="dot" style=${{ color: '#FF5A1F' }}></span><b style=${{ fontWeight: 700 }}>${a.title}</b><span style=${{ marginLeft: 'auto' }}><${Ring} created=${a.created} ttl=${a.ttl} /></span></div>
      ${context ? html`<span className="muted" style=${{ fontSize: 12, marginTop: -4 }}>${context}</span>` : null}
      <span style=${{ lineHeight: 1.5 }}>${a.plain}</span>
      <div className="row" style=${{ flexWrap: 'wrap', gap: 6 }}>${(a.chips || []).map((c) => html`<span key=${c.t} className=${'pill ' + (c.tone || 'ok')} style=${{ fontWeight: 500 }}>${c.t}</span>`)}
        ${a.cmd ? html`<button className="chip" onClick=${() => setCmd(!cmd)}><${Icon} n="code" s=${11} />${cmd ? 'Hide command' : 'Show command'}</button>` : null}</div>
      ${cmd ? html`<pre className="mono" style=${{ margin: 0, padding: '8px 10px', borderRadius: 8, background: 'var(--panel)', fontSize: 11.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 160, overflow: 'auto' }}>${a.cmd}</pre>` : null}
      ${a.agentSays ? html`<span className="muted" style=${{ fontSize: 12 }}>The agent says: “${a.agentSays}”</span>` : null}
      <div className="row"><button className="btn sm ink grow" onClick=${() => resolveApproval(a.id, 'allow')}>${a.paid ? 'Pay and continue' : 'Allow'}</button>${a.rule ? html`<button className="btn sm outline" onClick=${() => resolveApproval(a.id, 'always')}>Always here</button>` : null}<button className="btn sm ghost" onClick=${() => resolveApproval(a.id, 'deny')}>Deny</button></div>
    </div>`;
  }

  /* ---------- top bars ---------- */
  function RunningBadge() {
    const jobs = useStore((s) => s.jobs);
    if (!jobs.length) return null;
    return html`<button className="btn ghost" data-pop="activity" onClick=${() => togglePop('activity')}><${Spinner} />${jobs.length} running</button>`;
  }
  function Bell() {
    const n = useStore((s) => s.approvals.length); const isOpen = useStore((s) => s.popover === 'activity');
    return html`<div style=${{ position: 'relative' }}><button className=${'btn icon ' + (isOpen ? '' : 'ghost')} data-bell data-pop="activity" aria-label=${`Activity, ${n} waiting`} onClick=${() => togglePop('activity')} style=${{ position: 'relative' }}><${Icon} n="bell" s=${16} />${n ? html`<span className="count" style=${{ position: 'absolute', right: 3, top: 3, boxShadow: '0 0 0 2px var(--panel)' }}>${n}</span>` : null}</button>
      <${Popover} id="activity" width=${440} style=${{ right: 0, top: 40, padding: 0 }}><${ActivityPanel} /></${Popover}></div>`;
  }
  function ActivityPanel() {
    const approvals = useStore((s) => s.approvals); const jobs = useStore((s) => s.jobs); const done = useStore((s) => s.done); const tokens = useStore((s) => s.tokens);
    const [tab, setTab] = useState(approvals.length ? 'needs' : 'running');
    return html`<div>
      <div className="row" style=${{ padding: 8, borderBottom: '1px solid var(--line2)', gap: 2 }}>
        <div className="seg" style=${{ background: 'transparent', padding: 0 }}>
          <button className=${tab === 'needs' ? 'on' : ''} onClick=${() => setTab('needs')}>Needs you ${approvals.length ? html`<span className="count">${approvals.length}</span>` : html`<span className="faint">0</span>`}</button>
          <button className=${tab === 'running' ? 'on' : ''} onClick=${() => setTab('running')}>Running <span className="faint">${jobs.length}</span></button>
          <button className=${tab === 'done' ? 'on' : ''} onClick=${() => setTab('done')}>Done <span className="faint">${done.length}</span></button>
        </div>
      </div>
      <div style=${{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 460, overflow: 'auto' }} className="scroll">
        ${tab === 'needs' && (approvals.length ? approvals.map((a) => html`<${ApprovalCard} key=${a.id} a=${a} context=${a.where} />`) : html`<${Empty} icon="check" title="Nothing waiting for you" sub="Requests from the agent show up here and as a banner." />`)}
        ${tab === 'running' && (jobs.length ? jobs.map((j) => html`<div key=${j.id} className="row" style=${{ gap: 10, padding: 6, alignItems: 'flex-start' }}><div style=${{ width: 26, height: 46, borderRadius: 4, overflow: 'hidden', flex: 'none' }}><img src=${j.img} alt="" style=${{ width: '100%', height: '100%', objectFit: 'cover' }} /></div><div className="col grow" style=${{ gap: 5 }}><span className="row"><b className="b">${j.title}</b><span className="mono muted" style=${{ marginLeft: 'auto', fontSize: 11 }}>${j.progress}%</span></span><span className="muted" style=${{ fontSize: 12 }}>${j.step}</span><div className="bar"><i style=${{ width: j.progress + '%' }}></i></div></div></div>`) : html`<${Empty} icon="clock" title="Nothing running" sub="Generations and analyses show their progress here." />`)}
        ${tab === 'done' && done.map((d) => html`<div key=${d.id} className="row" style=${{ height: 34, padding: '0 6px', gap: 10 }}><span className=${d.ok ? 'ok' : 'warn'}><${Icon} n=${d.ok ? 'check' : 'warn'} s=${14} w=${2} /></span><span className="grow ell">${d.text}</span><span className="faint" style=${{ fontSize: 11 }}>${d.at}</span></div>`)}
      </div>
      <div className="row" style=${{ justifyContent: 'space-between', padding: '10px 14px', borderTop: '1px solid var(--line2)', background: 'var(--bg)', fontSize: 12 }}><span className="muted">Today · ${tokens.toFixed(1)}k tokens</span><a href="#" onClick=${(e) => { e.preventDefault(); nav({ name: 'appSettings', section: 'usage' }); }}>Usage</a></div>
    </div>`;
  }
  function Empty({ icon, title, sub }) {
    return html`<div className="col" style=${{ alignItems: 'center', gap: 6, padding: '22px 12px', textAlign: 'center' }}><span style=${{ width: 36, height: 36, borderRadius: 10, background: 'var(--field)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="muted"><${Icon} n=${icon} s=${16} /></span><b className="b">${title}</b><span className="muted" style=${{ fontSize: 12, maxWidth: 280 }}>${sub}</span></div>`;
  }
  function Avatar() {
    return html`<div style=${{ position: 'relative' }}><button className="avatar" data-pop="me" onClick=${() => togglePop('me')} aria-label="Account menu">AL</button>
      <${Popover} id="me" width=${220} style=${{ right: 0, top: 38 }}>
        <button className="navitem" onClick=${() => nav({ name: 'appSettings', section: 'general' })}><${Icon} n="gear" />Settings</button>
        <button className="navitem" onClick=${() => nav({ name: 'appSettings', section: 'usage' })}><${Icon} n="chart" />Usage</button>
        <div style=${{ height: 1, background: 'var(--line2)', margin: '6px 4px' }}></div>
        <button className="navitem" onClick=${() => { set({ popover: null }); nav({ name: 'welcome', step: 1 }); }}><${Icon} n="sparkle" />Replay setup</button>
        <button className="navitem" onClick=${() => { set({ popover: null }); nav({ name: 'pairing' }); }}><${Icon} n="terminal" />Browser pairing page</button>
      </${Popover}></div>`;
  }
  function Tokens() { const t = useStore((s) => s.tokens); return html`<button className="btn ghost mono" style=${{ fontSize: 12 }} onClick=${() => nav({ name: 'appSettings', section: 'usage' })}>${t.toFixed(1)}k tokens</button>`; }

  function GlobalTop({ title }) {
    return html`<div className="topbar"><${Logo} onClick=${() => nav({ name: 'projects' })} /><span className="bb">Motion Studio</span>${title ? html`<span className="faint">/</span><b className="b">${title}</b>` : null}
      <div className="grow" style=${{ display: 'flex', justifyContent: 'center' }}><label className="search" style=${{ width: 420, background: 'var(--field)', boxShadow: 'none' }}><${Icon} n="search" s=${14} /><input placeholder="Search projects, creatives, assets" aria-label="Search" /><span className="kbd">⌘K</span></label></div>
      <${RunningBadge} /><${Bell} /><${Avatar} /></div>`;
  }
  function ProjectSwitcher({ pid }) {
    const ps = useStore((s) => s.projects); const p = ps.find((x) => x.id === pid) || ps[0];
    return html`<div style=${{ position: 'relative' }}><button className="btn ghost" data-pop="switch" onClick=${() => togglePop('switch')} style=${{ color: 'var(--text)', fontWeight: 600, paddingLeft: 6 }}><span className="hs">${p.id === 'hs' ? 'HS' : p.name[0]}</span>${p.name}<${Icon} n="chevron" s=${12} c="var(--faint)" /></button>
      <${Popover} id="switch" width=${260} origin="top left" style=${{ left: 0, top: 40 }}>
        <span className="cap" style=${{ padding: '4px 8px 6px', display: 'block' }}>Projects</span>
        ${ps.map((x) => html`<button key=${x.id} className=${'navitem' + (x.id === pid ? ' on' : '')} onClick=${() => nav({ name: 'project', pid: x.id, tab: 'creatives' })}><span className="hs" style=${{ background: x.palette[0], color: x.palette[3] }}>${x.id === 'hs' ? 'HS' : x.name[0]}</span>${x.name}${x.id === pid ? html`<span style=${{ marginLeft: 'auto' }}><${Icon} n="check" s=${13} /></span>` : null}</button>`)}
        <div style=${{ height: 1, background: 'var(--line2)', margin: '6px 4px' }}></div>
        <button className="navitem" onClick=${() => nav({ name: 'projects', focusNew: true })}><${Icon} n="plus" />New project</button>
      </${Popover}></div>`;
  }
  function ProjectTop({ pid, tab }) {
    const tabs = [['creatives', 'Creatives'], ['brand', 'Brand'], ['assets', 'Assets'], ['references', 'References'], ['settings', 'Settings']];
    return html`<div className="topbar"><${Logo} onClick=${() => nav({ name: 'projects' })} /><${ProjectSwitcher} pid=${pid} />
      <nav className="tabs" aria-label="Project sections">${tabs.map(([k, l]) => html`<button key=${k} className=${'tab' + (tab === k ? ' on' : '')} onClick=${() => set({ route: { ...get().route, tab: k }, dir: 1 })}>${l}</button>`)}</nav>
      <div className="grow"></div><${RunningBadge} /><${Bell} /><${Tokens} /><${Avatar} /></div>`;
  }

  /* ---------- projects ---------- */
  function Projects({ route }) {
    const ps = useStore((s) => s.projects); const cr = useStore((s) => s.creatives); const nWaiting = useStore((s) => s.approvals.length);
    const ref = MS.useEnter([]);
    const [name, setName] = useState('');
    const inputRef = useRef(null);
    useEffect(() => { if (route.focusNew && inputRef.current) { inputRef.current.focus(); motion.flash(inputRef.current); } }, [route.focusNew]);
    const recent = [cr[0], cr[1], cr[2]];
    const create = () => {
      if (!name.trim()) { motion.flash(inputRef.current); return; }
      const id = 'p' + Date.now();
      set((s) => ({ projects: [...s.projects, { id, name: name.trim(), site: 'Add a website to learn the brand', updated: 'Just now', creatives: 0, assets: 0, palette: ['#171717', '#6B6B6B', '#E5E5E3', '#F5F5F4'], word: name.trim(), fresh: true }] }));
      setName(''); toast(`Project “${name.trim()}” created`, { tone: 'ok', action: { label: 'Open', run: () => nav({ name: 'project', pid: id, tab: 'brand' }) } });
    };
    const state = (c) => c.state === 'needs-you' ? html`<span className="row warn" style=${{ fontSize: 11, gap: 6 }}><span className="dot" style=${{ color: '#FF5A1F' }}></span>Waiting for your OK</span>` : c.state === 'running' ? html`<span className="col" style=${{ gap: 4 }}><span className="muted" style=${{ fontSize: 11 }}>Rendering · ${c.progress}%</span><span className="bar"><i style=${{ width: c.progress + '%' }}></i></span></span>` : html`<span className="row ok" style=${{ fontSize: 11, gap: 6 }}><span className="dot"></span>Ready · ${c.updated}</span>`;
    return html`<div className="app"><${GlobalTop} />
      <div className="grow scroll" style=${{ overflow: 'auto' }}><div ref=${ref} style=${{ width: 1200, maxWidth: 'calc(100% - 48px)', margin: '0 auto', padding: '32px 0', display: 'flex', flexDirection: 'column', gap: 28 }}>
        <div className="col" style=${{ gap: 12 }} data-enter>
          <div className="row" style=${{ justifyContent: 'space-between' }}><h2 style=${{ margin: 0, fontSize: 15 }}>Jump back in</h2><span className="muted" style=${{ fontSize: 12 }}>Recent creatives</span></div>
          <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 12 }}>
            ${recent.map((c) => html`<button key=${c.id} className="card hov row" style=${{ gap: 12, padding: 10, alignItems: 'stretch', textAlign: 'left', border: 0 }} onClick=${() => nav({ name: 'creative', pid: 'hs', cid: c.id, view: 'canvas' })}>
              <div style=${{ width: c.outputs[0] && fmt(c.outputs[0].fid).kind === 'image' ? 78 : 44, height: 78, borderRadius: 6, overflow: 'hidden', flex: 'none' }}><img src=${c.outputs[0] ? c.outputs[0].img : ''} alt="" style=${{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>
              <div className="col grow" style=${{ gap: 4, paddingTop: 2 }}><b className="b">${c.title}</b><span className="muted" style=${{ fontSize: 12 }}>Half Story · ${c.outputs.length} format${c.outputs.length === 1 ? '' : 's'}</span><span style=${{ marginTop: 'auto' }}>${state(c)}</span></div></button>`)}
            <button className="card hov row" style=${{ justifyContent: 'center', gap: 8, border: 0, boxShadow: 'none', outline: '1.5px dashed var(--line)', outlineOffset: -1, color: 'var(--muted)' }} onClick=${() => nav({ name: 'newCreative', pid: 'hs' })}><${Icon} n="plus" />New creative in Half Story</button>
          </div>
        </div>
        <div className="col" style=${{ gap: 14 }}>
          <div className="row" data-enter><h1 style=${{ margin: 0, fontSize: 22, letterSpacing: '-.015em' }}>Projects</h1><span className="mono faint" style=${{ fontSize: 12 }}>${ps.length}</span><div className="grow"></div><button className="btn ink" onClick=${() => { inputRef.current.focus(); motion.flash(inputRef.current); }}><${Icon} n="plus" s=${13} w=${1.8} />New project</button></div>
          <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 16 }}>
            ${ps.map((p) => html`<${ProjectCard} key=${p.id} p=${p} waiting=${p.id === 'hs' ? nWaiting : 0} />`)}
            <div className="col" data-enter style=${{ borderRadius: 14, border: '1.5px dashed var(--line)', padding: 22, gap: 14, justifyContent: 'center' }}>
              <span style=${{ width: 40, height: 40, borderRadius: 10, background: 'var(--field)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><${Icon} n="plus" s=${18} /></span>
              <div className="col" style=${{ gap: 4 }}><b style=${{ fontSize: 15 }}>Start a new project</b><span className="muted" style=${{ lineHeight: 1.5 }}>Give it a name and a website. Claude learns the colors, fonts, logos and voice for you.</span></div>
              <form className="row" onSubmit=${(e) => { e.preventDefault(); create(); }}><label className="sr" htmlFor="np">Project name</label><input id="np" ref=${inputRef} className="input grow" style=${{ height: 34 }} placeholder="Project name" value=${name} onInput=${(e) => setName(e.target.value)} /><button className="btn ink" type="submit">Create</button></form>
            </div>
          </div>
        </div>
      </div></div></div>`;
  }
  function ProjectCard({ p, waiting }) {
    const ref = useRef(null);
    useLayoutEffect(() => { motion.enter(ref.current, { y: p.fresh ? 16 : 8, scale: p.fresh ? .96 : 1 }); }, []);
    return html`<button ref=${ref} className="card hov col" style=${{ overflow: 'hidden', border: 0, padding: 0, textAlign: 'left', boxShadow: '0 0 0 1px var(--line)' }} onClick=${() => nav({ name: 'project', pid: p.id, tab: 'creatives' })}>
      <div style=${{ position: 'relative', height: 176, width: '100%', background: p.cover ? '#1B1913' : p.palette[p.palette.length - 2] || 'var(--field)', display: p.cover ? 'grid' : 'flex', gridTemplateColumns: '1.3fr 1fr 1fr', gap: 2, alignItems: 'center', justifyContent: 'center' }}>
        ${p.cover ? p.cover.map((src, i) => html`<img key=${i} src=${src} alt="" style=${{ width: '100%', height: '100%', objectFit: 'cover' }} />`) : html`<span style=${{ fontSize: 40, fontWeight: 700, letterSpacing: '-.03em', color: p.palette[0] }}>${p.word}</span>`}
        <div style=${{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 5, display: 'flex' }}>${p.palette.map((c, i) => html`<span key=${i} style=${{ flex: 1, background: c }}></span>`)}</div>
        ${waiting ? html`<span className="pill" style=${{ position: 'absolute', left: 10, top: 10, background: 'rgba(255,255,255,.94)', color: '#D9480F' }}><span className="dot" style=${{ color: '#FF5A1F' }}></span>${waiting} approval${waiting > 1 ? 's' : ''} waiting</span>` : null}
      </div>
      <div className="col" style=${{ padding: '14px 16px 16px', gap: 10, width: '100%' }}>
        <div className="row" style=${{ gap: 10 }}><span className="hs" style=${{ width: 32, height: 32, borderRadius: 8, fontSize: 13, background: p.palette[0], color: p.palette[3] || '#fff' }}>${p.id === 'hs' ? 'HS' : p.name[0]}</span><div className="col"><b style=${{ fontSize: 15 }}>${p.name}</b><span className="muted" style=${{ fontSize: 12 }}>${p.site}</span></div><span className="faint" style=${{ marginLeft: 'auto', fontSize: 12 }}>${p.updated}</span></div>
        <div className="row muted" style=${{ gap: 14, fontSize: 12 }}><span><b style=${{ color: 'var(--text)' }}>${p.creatives}</b> creatives</span><span><b style=${{ color: 'var(--text)' }}>${p.assets}</b> assets</span></div>
      </div></button>`;
  }

  /* ---------- project shell and creatives list ---------- */
  function ProjectShell({ route }) {
    const tab = route.tab || 'creatives';
    return html`<div className="app"><${ProjectTop} pid=${route.pid} tab=${tab} />
      <${PageHost} route=${route} keyOf=${(r) => r.tab || 'creatives'} soft=${true} render=${(r) => { const T = { creatives: Creatives, brand: MS.BrandPage, assets: MS.AssetsPage, references: MS.ReferencesPage, settings: MS.ProjectSettingsPage }[r.tab || 'creatives']; return T ? html`<${T} route=${r} />` : null; }} /></div>`;
  }
  function Creatives({ route }) {
    const list = useStore((s) => s.creatives); const approvals = useStore((s) => s.approvals);
    const [filter, setFilter] = useState('all');
    const ref = MS.useEnter([filter]);
    if (route.pid !== 'hs') return html`<div className="dots" style=${{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="card col" style=${{ width: 460, padding: 28, gap: 12, alignItems: 'flex-start' }} data-enter><b style=${{ fontSize: 18 }}>No creatives yet</b><span className="muted" style=${{ lineHeight: 1.5 }}>Start with the brand so every creative looks right, or jump straight to your first brief.</span><div className="row"><button className="btn outline" onClick=${() => set({ route: { ...route, tab: 'brand' } })}>Set up the brand</button><button className="btn ink" onClick=${() => nav({ name: 'newCreative', pid: route.pid })}>New creative</button></div></div></div>`;
    const st = (c) => (c.id === 'crime' && approvals.some((a) => a.cid === 'crime')) ? 'needs-you' : (c.state === 'needs-you' ? 'ready' : c.state);
    const shown = list.filter((c) => filter === 'all' || (filter === 'needs' && st(c) === 'needs-you') || (filter === 'running' && st(c) === 'running') || (filter === 'ready' && st(c) === 'ready') || (filter === 'draft' && st(c) === 'draft'));
    const cnt = (k) => list.filter((c) => (k === 'needs' ? st(c) === 'needs-you' : st(c) === k)).length;
    return html`<div className="scroll" style=${{ height: '100%', overflow: 'auto' }}><div ref=${ref} style=${{ width: 1240, maxWidth: 'calc(100% - 48px)', margin: '0 auto', padding: '28px 0', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="row" style=${{ gap: 12 }}>
        <h1 style=${{ margin: 0, fontSize: 22, letterSpacing: '-.015em' }}>Creatives</h1>
        <div className="seg" role="tablist" style=${{ marginLeft: 8 }}>
          ${[['all', 'All', list.length], ['needs', 'Needs you', cnt('needs')], ['running', 'In progress', cnt('running')], ['ready', 'Ready', cnt('ready')], ['draft', 'Drafts', cnt('draft')]].map(([k, l, n]) => html`<button key=${k} role="tab" aria-selected=${filter === k} className=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${l} ${k === 'needs' && n ? html`<span className="count">${n}</span>` : html`<span className="faint" style=${{ fontWeight: 400 }}>${n}</span>`}</button>`)}
        </div>
        <div className="grow"></div>
        <label className="search" style=${{ width: 220 }}><${Icon} n="search" s=${14} /><input placeholder="Search creatives" aria-label="Search creatives" /></label>
        <button className="btn ink" onClick=${() => nav({ name: 'newCreative', pid: 'hs' })}><${Icon} n="plus" s=${13} w=${1.8} />New creative</button>
      </div>
      ${shown.length ? html`<div style=${{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 16 }}>${shown.map((c, i) => html`<${CreativeCard} key=${c.id} c=${c} st=${st(c)} i=${i} />`)}</div>` : html`<${Empty} icon="check" title="Nothing here" sub="Try another filter." />`}
    </div></div>`;
  }
  function CreativeCard({ c, st, i }) {
    const allApprovals = useStore((s) => s.approvals); const approvals = allApprovals.filter((a) => a.cid === c.id);
    const open = () => nav({ name: 'creative', pid: 'hs', cid: c.id, view: 'canvas' });
    const thumbs = c.outputs.filter((o) => !o.follows);
    return html`<div className="card hov col" data-enter data-delay=${i * 40} style=${{ overflow: 'hidden', boxShadow: st === 'needs-you' ? '0 0 0 1.5px #FF5A1F, 0 12px 30px var(--shadow)' : undefined }} onClick=${open} role="link" tabIndex="0" onKeyDown=${(e) => e.key === 'Enter' && open()}>
      <div className="dots" style=${{ height: 210, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundSize: '14px 14px', position: 'relative' }}>
        ${thumbs.length ? thumbs.map((o, k) => { const f = fmt(o.fid); const h = f.kind === 'image' && f.w === f.h ? (thumbs.length > 1 ? 120 : 164) : 164; const w = Math.round(h * f.w / f.h); return html`<div key=${k} style=${{ width: w, height: h, borderRadius: 3, overflow: 'hidden', boxShadow: '0 6px 16px var(--shadow)', position: 'relative' }}><img src=${o.img} alt="" style=${{ width: '100%', height: '100%', objectFit: 'cover', filter: st === 'running' ? 'saturate(.6)' : st === 'failed' ? 'opacity(.5)' : 'none' }} />${st === 'running' ? html`<span className="shimmer"></span>` : null}</div>`; }) : [0, 1, 2].map((k) => html`<div key=${k} style=${{ width: k === 2 ? 112 : 74, height: k === 2 ? 150 : 160, borderRadius: 12, border: '1.5px dashed var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: 'var(--faint)' }}>${['6.9″', '6.5″', 'iPad 13″'][k]}</div>`)}
        ${c.outputs.some((o) => o.follows) ? html`<span className="faint" style=${{ fontSize: 10, position: 'absolute', right: 14, bottom: 10 }}>+${c.outputs.filter((o) => o.follows).length} linked</span>` : null}
        ${st === 'failed' ? html`<span style=${{ position: 'absolute', width: 36, height: 36, borderRadius: '50%', background: 'var(--panel)', color: 'var(--warn)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px var(--shadow)' }}><${Icon} n="warn" s=${16} w=${1.6} /></span>` : null}
      </div>
      <div className="col" style=${{ padding: '12px 14px 14px', gap: 10, borderTop: '1px solid var(--line2)' }}>
        <div className="row"><b style=${{ fontSize: 14 }}>${c.title}</b><span className="faint" style=${{ marginLeft: 'auto', fontSize: 12 }}>${c.updated}</span></div>
        <div className="row" style=${{ gap: 6, flexWrap: 'wrap' }}>${c.outputs.length ? c.outputs.map((o, k) => { const f = fmt(o.fid); return html`<span key=${k} className="tag" style=${{ height: 22, paddingLeft: 4 }}><${ChannelChip} k=${f.ch} />${f.name}${o.star ? ` ★ v${o.star}` : ''}</span>`; }) : html`<span className="tag" style=${{ height: 22, paddingLeft: 4 }}><${ChannelChip} k="AS" />App Store · 3 screenshots</span>`}</div>
        ${st === 'needs-you' && approvals[0] ? html`<div className="row" style=${{ padding: '8px 8px 8px 10px', borderRadius: 10, background: 'var(--warnBg)', boxShadow: 'inset 0 0 0 1px var(--warnLine)' }}><span className="dot" style=${{ color: '#FF5A1F' }}></span><span style=${{ fontSize: 12 }}><b>${approvals[0].title}</b></span><button className="btn sm ink" style=${{ marginLeft: 'auto' }} onClick=${(e) => { e.stopPropagation(); open(); }}>Review</button></div>` : null}
        ${st === 'running' ? html`<div className="col" style=${{ gap: 6, padding: '8px 10px', borderRadius: 10, background: 'var(--field)' }}><span className="row" style=${{ justifyContent: 'space-between', fontSize: 12 }}><span>${c.step}</span><span className="mono muted">${c.progress}% · ~1 min</span></span><div className="bar"><i style=${{ width: c.progress + '%' }}></i></div></div>` : null}
        ${st === 'ready' && c.id !== 'crime' ? html`<span className="row ok" style=${{ fontSize: 12 }}><span className="dot"></span>Ready · exported to ~/Desktop/Half Story</span>` : null}
        ${st === 'ready' && c.id === 'crime' ? html`<span className="row ok" style=${{ fontSize: 12 }}><span className="dot"></span>Ready · Reel ★ v5, Image ★ v2</span>` : null}
        ${st === 'failed' ? html`<div className="row"><span className="warn" style=${{ fontSize: 12 }}>${c.error}</span><button className="btn sm outline" style=${{ marginLeft: 'auto' }} onClick=${(e) => { e.stopPropagation(); MS.retryLoop && MS.retryLoop(); }}>Try again</button></div>` : null}
        ${st === 'draft' ? html`<div className="row"><span className="muted" style=${{ fontSize: 12 }}>Brief saved · nothing generated yet</span><button className="btn sm ink" style=${{ marginLeft: 'auto' }} onClick=${(e) => { e.stopPropagation(); nav({ name: 'newCreative', pid: 'hs', draft: true }); }}>Generate</button></div>` : null}
      </div></div>`;
  }

  /* ---------- prototype dock ---------- */
  function Dock() {
    const [open, setOpen] = useState(false);
    const [slow, setSlow] = useState(false);
    const theme = useStore((s) => s.theme);
    const jump = [['Setup', { name: 'welcome', step: 1 }], ['Projects', { name: 'projects' }], ['Creatives', { name: 'project', pid: 'hs', tab: 'creatives' }], ['Creative canvas', { name: 'creative', pid: 'hs', cid: 'crime', view: 'canvas' }], ['Video editor', { name: 'creative', pid: 'hs', cid: 'crime', view: 'video' }], ['Image editor', { name: 'creative', pid: 'hs', cid: 'crime', view: 'image' }], ['New creative', { name: 'newCreative', pid: 'hs' }], ['Brand', { name: 'project', pid: 'hs', tab: 'brand' }], ['Assets', { name: 'project', pid: 'hs', tab: 'assets' }], ['References', { name: 'project', pid: 'hs', tab: 'references' }], ['Project settings', { name: 'project', pid: 'hs', tab: 'settings' }], ['App settings', { name: 'appSettings', section: 'general' }], ['Browser pairing', { name: 'pairing' }]];
    return html`<div style=${{ position: 'fixed', left: 14, bottom: 64, zIndex: 90 }}>
      ${open ? html`<div className="popover" style=${{ position: 'absolute', bottom: 44, left: 0, width: 250 }}>
        <span className="cap" style=${{ display: 'block', padding: '4px 8px 6px' }}>Jump to</span>
        ${jump.map(([l, r]) => html`<button key=${l} className="navitem" onClick=${() => { setOpen(false); nav(r); }}>${l}</button>`)}
        <div style=${{ height: 1, background: 'var(--line2)', margin: '6px 4px' }}></div>
        <div className="row" style=${{ padding: '4px 8px', justifyContent: 'space-between' }}><span>Slow motion 0.25×</span><${Toggle} sm on=${slow} label="Slow motion" onChange=${(v) => { setSlow(v); motion.setSpeed(v ? 4 : 1); }} /></div>
        <div className="row" style=${{ padding: '4px 8px', justifyContent: 'space-between' }}><span>Dark theme</span><${Toggle} sm on=${theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)} label="Dark theme" onChange=${(v) => MS.setTheme(v ? 'dark' : 'light')} /></div>
        <button className="navitem" onClick=${() => location.reload()}><${Icon} n="refresh" />Reset the demo</button>
      </div>` : null}
      <button className="btn outline" style=${{ boxShadow: '0 0 0 1px var(--line), 0 8px 20px var(--shadow)', borderRadius: 999 }} onClick=${() => setOpen(!open)}><${Icon} n="sparkle" s=${13} />Prototype</button></div>`;
  }
  MS.setTheme = (t) => { set({ theme: t }); if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); };

  /* ---------- root ---------- */
  function Root() {
    const route = useStore((s) => s.route);
    const render = (r) => {
      if (r.name === 'projects') return html`<${Projects} route=${r} />`;
      if (r.name === 'project') return html`<${ProjectShell} route=${r} />`;
      const C = { creative: MS.CreativePage, newCreative: MS.NewCreativePage, appSettings: MS.AppSettingsPage, welcome: MS.WelcomePage, pairing: MS.PairingPage }[r.name];
      return C ? html`<${C} route=${r} />` : html`<div style=${{ padding: 40 }}>Coming soon</div>`;
    };
    return html`<${MS.React.Fragment}><${PageHost} route=${route} render=${render} /><${MS.Toasts} /><${Dock} /><${MS.ModalHost} /></${MS.React.Fragment}>`;
  }

  Object.assign(MS, { nav, PageHost, Popover, togglePop, requestApproval, resolveApproval, ApprovalCard, Ring, Bell, RunningBadge, Tokens, Avatar, GlobalTop, ProjectTop, Empty, fmt, Root });
})();
