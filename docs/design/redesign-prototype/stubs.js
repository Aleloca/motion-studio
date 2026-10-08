/* Placeholders for flows that arrive in the next updates of the prototype. */
(function () {
  const { html, nav } = MS;
  const Soon = (title, back) => function () {
    return html`<div className="dots" style=${{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="card col" style=${{ width: 420, padding: 26, gap: 10 }}><b style=${{ fontSize: 17 }}>${title}</b><span className="muted">This screen arrives in the next update of the prototype.</span><button className="btn ink" style=${{ alignSelf: 'flex-start' }} onClick=${() => nav(back || { name: 'projects' })}>Back</button></div></div>`;
  };
  const keep = (k, v) => { if (!MS[k]) MS[k] = v; };
  keep('BrandPage', Soon('Brand'));
  keep('AssetsPage', Soon('Assets'));
  keep('ReferencesPage', Soon('References'));
  keep('ProjectSettingsPage', Soon('Project settings'));
  keep('NewCreativePage', Soon('New creative', { name: 'project', pid: 'hs', tab: 'creatives' }));
  keep('AppSettingsPage', Soon('Settings'));
  keep('WelcomePage', Soon('Setup'));
  keep('PairingPage', Soon('Browser pairing'));
})();
