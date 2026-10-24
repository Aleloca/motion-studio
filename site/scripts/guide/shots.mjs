// The guide's screenshots, in order: each step builds on the state the previous ones left (see guide-shots.mjs). Three
// projects, the brands of the site's hero: KOVA (most screens), TIDEFALL (creative variants) and Fernwise (subtitles, video
// analysis).
const P = 'kova';
const api = (p) => `/api/projects/${p}`;
/** Slugs made along the way. */
const state = {};
const esc = (app) => app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))).then(() => app.sleep(600));

/** Polls `fn` (async, truthy when done) every 500 ms. */
async function until(fn, what, timeout = 120_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Uploads local files into a project's Assets. */
async function upload(demo, project, files) {
  const { readFileSync } = await import('node:fs');
  const { basename } = await import('node:path');
  const form = new FormData();
  for (const f of files) form.append('files', new Blob([readFileSync(f)]), basename(f));
  return demo.api('POST', `${api(project)}/assets`, form);
}

/** Waits until the creative has `n` versions and no job runs on it. */
async function versions(demo, creative, n, project = P) {
  return until(async () => {
    const d = await demo.api('GET', `${api(project)}/creatives/${creative}`);
    return d.versions.length >= n && !d.job ? d : null;
  }, `${creative} v${n}`, 240_000);
}

/** Runs the brand analysis of a website and applies the whole proposal. */
async function brandFrom(demo, project, url, { apply = true } = {}) {
  await demo.api('POST', `${api(project)}/brand/sources`, { kind: 'website', url });
  await demo.api('POST', `${api(project)}/brand/analyze`, {});
  const proposal = await until(async () => (await demo.api('GET', `${api(project)}/brand`)).proposals.find((p) => p.status === 'open'), 'brand proposal');
  if (apply) await demo.api('POST', `${api(project)}/brand/proposals/${proposal.id}/apply`, { acceptedIds: proposal.changes.map((c) => c.id), applyGuidelines: true });
  return proposal;
}

/** Moves the editor's playhead to a fraction of the ruler. */
const seek = async (app, at) => { await app.mouse('.ms-tl-ruler', '', { dx: at }); await app.sleep(1500); };
/** Selects a clip of the scene list whose text contains `text`. */
async function pickClip(app, text) {
  const n = await app.waitFor((t) => { const i = [...document.querySelectorAll('.ms-sc-clip')].findIndex((e) => e.innerText.includes(t)); return i >= 0 ? i + 1 : 0; }, { args: [text], what: `clip "${text}"` });
  await app.mouse('.ms-sc-clip', '', { nth: n - 1 });
  await app.sleep(1200);
}

const KOVA_BRIEF = {
  goal: 'A launch film for KOVA Air, our new noise-cancelling earbuds: from the noise of the city to silence, then the specs as numbers.',
  message: 'Silence, engineered.', formats: ['instagram-reel-9x16', 'instagram-post-1x1', 'youtube-16x9'], durationSec: 16,
  assets: ['assets/kova-air-hero.png'], notes: 'Dark, precise, cyan accents. Show the specs as numbers.',
};

export const SHOTS = [
  {
    name: 'welcome',
    async run({ app, shot }) {
      await app.go('#/welcome');
      await app.waitFor(() => document.querySelectorAll('[class*=welcome]').length > 0);
      await app.sleep(2500);
      await shot('welcome-check');
    },
  },
  {
    name: 'workspace',
    async run({ demo, app }) {
      await demo.api('PUT', '/api/workspace', { path: demo.dirs.workspace });
      await demo.api('PUT', '/api/settings', { theme: 'light' });
      await demo.api('POST', '/api/projects', { name: 'KOVA', description: 'KOVA Labs: the launch of KOVA Air, noise-cancelling earbuds' });
      await demo.api('POST', '/api/projects', { name: 'TIDEFALL', description: 'TIDEFALL festival, Vol. 04: three nights by the sea' });
      await demo.api('POST', '/api/projects', { name: 'Fernwise', description: 'Fernwise money app: the 2026 year in review' });
      await app.reload();
    },
  },
  {
    name: 'settings',
    async run({ app, shot }) {
      for (const s of ['general', 'system', 'paid', 'transcription', 'notifications']) {
        await app.go(`#/settings/${s}`, { settle: 2500 });
        await shot(`settings-${s}`);
      }
    },
  },
  {
    name: 'brand',
    async run({ demo, app, shot }) {
      await app.go(`#/p/${P}/brand`, { settle: 2000 });
      await shot('brand-empty');
      await brandFrom(demo, P, 'https://kova-labs.example', { apply: false });
      await app.reload();
      await app.go(`#/p/${P}/brand`, { settle: 2500 });
      await shot('brand-proposal');
      const proposal = (await demo.api('GET', `${api(P)}/brand`)).proposals.find((p) => p.status === 'open');
      await demo.api('POST', `${api(P)}/brand/proposals/${proposal.id}/apply`, { acceptedIds: proposal.changes.map((c) => c.id), applyGuidelines: true });
      await brandFrom(demo, 'tidefall', 'https://tidefall-festival.example');
      await brandFrom(demo, 'fernwise', 'https://fernwise.example');
      await app.reload();
      await app.go(`#/p/${P}/brand`, { settle: 2500 });
      await shot('brand-kit');
    },
  },
  {
    name: 'assets',
    async run({ demo, app, media, shot }) {
      await upload(demo, P, media.kova);
      await upload(demo, 'fernwise', media.fernwise);
      await app.go(`#/p/${P}/assets`, { settle: 3000 });
      await shot('assets');
    },
  },
  {
    name: 'new-creative',
    async run({ app, shot }) {
      // With the agent: a read-only agent fills the form from a chat.
      await app.go(`#/p/${P}/new`, { settle: 2500 });
      const box = 'textarea[placeholder^="Tell the agent"]';
      // The switch is pressed again until the panel is there (the first press can land before the form is ready).
      await app.waitFor((sel) => {
        if (document.querySelector(sel)) return true;
        [...document.querySelectorAll('[role=radio]')].find((b) => b.textContent.trim() === 'With the agent')?.click();
        return false;
      }, { args: [box], timeout: 30_000 });
      await app.sleep(2000);
      await app.fill(box, 'A 16 second launch film for KOVA Air, for Instagram and YouTube. Dark and precise.');
      await app.click('Send', { selector: '.ms-nc-panel .ms-composer-send' });
      await app.waitText('press Generate', { timeout: 60_000 });
      await app.sleep(2500);
      await shot('brief-agent');
      // Back to the form, now filled in: the fields the agent wrote carry its mark.
      await app.click('Fill it in yourself');
      await app.sleep(1500);
      await shot('new-creative');
    },
  },
  {
    name: 'generate',
    async run({ demo, app, shot }) {
      const { slug } = await demo.api('POST', `${api(P)}/creatives`, { title: 'KOVA Air launch', brief: KOVA_BRIEF, generate: true });
      state.launch = slug;
      await versions(demo, slug, 1);
      await app.go(`#/p/${P}/c/${slug}`, { settle: 6000 });
      await shot('canvas');
    },
  },
  {
    name: 'creative',
    async run({ demo, app, shot }) {
      const c = state.launch;
      await app.go(`#/p/${P}/c/${c}`, { settle: 4000 });
      await shot('chat', { selector: '.ms-chat-col', pad: 0 });
      await app.click('Brief', { exact: true });
      await app.sleep(800);
      await shot('brief-tab', { selector: '.ms-chat-col', pad: 0 });
      await app.click('Chat', { exact: true });
      // The agent at work: the turn waits (GUIDE_HOLD) after its first step.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(demo.hold, 'hold');
      await app.fill('textarea[placeholder^="Describe what to change"]', 'Make the closing line shorter and more confident.');
      await app.click('Send', { selector: '.ms-chat-col .ms-composer-send' });
      await app.waitText('Stop', { timeout: 30_000 });
      await app.sleep(2500);
      await app.fill('.ms-chat-col textarea', 'Also slow down the specs a little.');
      await app.sleep(500);
      await shot('agent-working');
      await app.click('Stop options');
      await app.sleep(600);
      await shot('stop-menu', { selector: '.ms-chat-col', pad: 0 });
      await esc(app);
      writeFileSync(demo.hold, 'go');
      await versions(demo, c, 2);
      await app.fill('.ms-chat-col textarea', '');
      await app.sleep(7000);
      await shot('canvas-v2');
    },
  },
  {
    name: 'editor',
    async run({ demo, app, shot }) {
      const c = state.launch;
      await app.go(`#/p/${P}/c/${c}/f/youtube-16x9`, { settle: 6000 });
      // 4.3 s: "Silence, engineered." over the earbuds.
      await seek(app, 0.27);
      await shot('editor');
      // The closing line, at 10.5 s.
      await seek(app, 0.656);
      await pickClip(app, 'Only what matters');
      await shot('editor-inspector');
      await app.fill('textarea[aria-label="Content"]', 'Only what matters. Always.');
      await app.sleep(1500);
      await shot('editor-draft');
      await app.click('Save as v3');
      await versions(demo, c, 3);
      await app.sleep(3000);
      // The SVG content of the case drawing.
      await seek(app, 0.6);
      await pickClip(app, 'Case');
      await app.js(() => [...document.querySelectorAll('.ms-chat-col *')].find((e) => /^SVG content/.test(e.textContent?.trim() ?? '') && e.children.length < 3)?.scrollIntoView({ block: 'start' }));
      await app.sleep(1200);
      await shot('svg-editor');
      // A comment on a spot of the frame, at 4.3 s.
      await seek(app, 0.27);
      await app.click('Comment a spot');
      await app.mouse('.ms-fv-stage, .ms-ed-stage, [class*=stage]', '', { dx: 0.7, dy: 0.45 });
      await app.sleep(1000);
      await app.fill('[role=dialog] textarea', 'Let the earbuds come in a little later, after the headline.');
      await shot('comment-spot');
      await app.click('Add comment');
      await app.sleep(1500);
      await shot('comment-chip', { selector: '.ms-chat-col' });
    },
  },
  {
    name: 'versions',
    async run({ app, shot }) {
      await app.click('YouTube · Video 16:9', { selector: 'button' });
      await app.sleep(1000);
      await shot('versions');
      await app.click('Compare');
      await app.sleep(3000);
      await app.mouse('[role=dialog] [role=slider]', '', { dx: 0.88 }).catch(() => {});
      await app.sleep(6000);
      await shot('compare');
      await esc(app);
    },
  },
  {
    name: 'export',
    async run({ app, shot }) {
      const c = state.launch;
      await app.go(`#/p/${P}/c/${c}`, { settle: 4000 });
      await app.click('Export', { exact: true });
      await app.sleep(2500);
      await shot('export');
      await esc(app);
      await app.click('More actions');
      await app.sleep(800);
      await shot('creative-menu');
      await esc(app);
    },
  },
  {
    name: 'chat-tools',
    async run({ app, shot }) {
      const c = state.launch;
      await app.go(`#/p/${P}/c/${c}`, { settle: 4000 });
      await app.click('Attach files');
      await app.sleep(800);
      await shot('composer-attach', { selector: '.ms-chat-col' });
      await esc(app);
      await app.click('Services:', { selector: 'button' });
      await app.sleep(800);
      await shot('services');
      await esc(app);
    },
  },
  {
    name: 'languages',
    async run({ demo, app, shot }) {
      const c = state.launch;
      const d = await demo.api('GET', `${api(P)}/creatives/${c}`);
      await demo.api('PUT', `${api(P)}/creatives/${c}`, { brief: { ...d.creative.brief, locales: { primary: 'en', extra: ['it', 'de', 'ja'] } } });
      await app.go(`#/p/${P}/c/${c}/f/instagram-reel-9x16`, { settle: 5000 });
      await seek(app, 0.27);
      await app.click('Languages', { selector: 'button' });
      await app.sleep(1500);
      await shot('languages');
      await esc(app);
      await app.click('More actions');
      await app.sleep(800);
      await shot('format-menu');
      await esc(app);
    },
  },
  {
    name: 'brief-editor',
    async run({ app, shot }) {
      await app.go(`#/p/${P}/c/${state.launch}`, { settle: 4000 });
      await app.click('Brief', { exact: true });
      await app.click('Edit the brief');
      await app.sleep(1500);
      await shot('brief-editor');
      await esc(app);
    },
  },
  {
    name: 'approval',
    async run({ demo, app, shot }) {
      // The agent asks to read a page of another site: a permission card in the chat and at the top right.
      const { writeFileSync } = await import('node:fs');
      const c = state.launch;
      writeFileSync(demo.approve, 'ask');
      await app.go(`#/p/${P}/c/${c}`, { settle: 4000 });
      await app.click('Chat', { exact: true, within: '.ms-chat-col' });
      // The boards' own renders finish first, so the cards read Ready, not Rendering…
      await app.waitFor(() => ![...document.querySelectorAll('.ms-cv-board-state')].some((e) => e.textContent.includes('Rendering')), { timeout: 180_000, what: 'renders done' });
      await app.sleep(1500);
      await app.fill('textarea[placeholder^="Describe what to change"]', 'Use the approved claims from the press kit.');
      await app.click('Send', { selector: '.ms-chat-col .ms-composer-send' });
      await app.waitText('Always here', { timeout: 60_000 });
      await app.sleep(2000);
      await app.js(() => [...document.querySelectorAll('.ms-chat-col button')].find((b) => b.textContent.trim() === 'Always here')?.scrollIntoView({ block: 'center' }));
      await app.sleep(800);
      await shot('approval');
      await app.click('Review', { exact: true });
      await app.sleep(1500);
      await shot('approval-review');
      await esc(app);
      await app.click('Deny', { exact: true, within: '.ms-chat-col' });
      await versions(demo, c, 4);
      await app.sleep(2000);
    },
  },
  {
    name: 'variants',
    async run({ demo, app, shot }) {
      const brief = {
        goal: 'The line-up announcement for TIDEFALL Vol. 04: three directions to choose from.', message: 'Three nights by the sea.',
        formats: ['instagram-reel-9x16', 'youtube-16x9'], durationSec: 12, assets: [], notes: '',
      };
      const { slug } = await demo.api('POST', `${api('tidefall')}/creatives`, { title: 'Line-up announcement', brief, generate: false });
      state.group = slug;
      await demo.api('POST', `${api('tidefall')}/creatives/${slug}/variants`, { count: 3, directions: ['Sunset pink, as on the poster', 'Cool night blues', 'Acid green'] });
      await demo.api('POST', `${api('tidefall')}/creatives/${slug}/variants/run`, { targets: 'all-active', request: null });
      for (const v of [slug, `${slug}~b`, `${slug}~c`]) await versions(demo, v, 1, 'tidefall');
      await app.go(`#/p/tidefall/c/${slug}`, { settle: 8000 });
      await shot('variants');
      await app.click('More actions');
      await app.sleep(800);
      await shot('group-menu');
      await esc(app);
      await app.click('+ Variant');
      await app.sleep(1200);
      await shot('add-variant');
      await esc(app);
      await app.click('Final selection');
      await app.sleep(1500);
      await shot('final-selection');
      await esc(app);
    },
  },
  {
    name: 'identity',
    async run({ demo, app, shot }) {
      await app.go(`#/p/${P}/new`, { settle: 2500 });
      // A brief session is still open from the brief agent: start over.
      await app.click('Start over', { timeout: 4000 }).catch(() => {});
      await app.sleep(1200);
      await app.click('Identity', { selector: 'button' });
      await app.sleep(1000);
      await app.click('Logo', { selector: 'button, [role=checkbox]' });
      await app.sleep(1500);
      await app.js(() => [...document.querySelectorAll('.ms-nc-left .ms-nc-sec')].at(-1)?.scrollIntoView({ block: 'end' }));
      await app.sleep(800);
      await shot('identity-start');
      // The set, made from the brand's mark and rendered on this computer by the app's own Chrome.
      const brief = {
        goal: 'The KOVA Air favicon and app icon, from the brand mark.', message: '', formats: ['identity-favicon', 'identity-app-icon'],
        durationSec: null, assets: [], notes: '', identity: { start: 'brand', colors: 'brand', concepts: 1 },
      };
      const { slug } = await demo.api('POST', `${api(P)}/creatives`, { title: 'KOVA icons', brief, generate: true });
      await versions(demo, slug, 1);
      await demo.api('POST', `${api(P)}/creatives/${slug}/versions/1/render`, {});
      await until(async () => !(await demo.api('GET', `${api(P)}/creatives/${slug}`)).job && (await demo.api('GET', `${api(P)}/creatives/${slug}`)).versions[0].outputs.length >= 2, 'identity render', 240_000);
      await app.go(`#/p/${P}/c/${slug}/f/identity-favicon`, { settle: 5000 });
      await app.click('Sizes', { exact: true });
      await app.sleep(3000);
      await shot('identity-sizes');
    },
  },
  {
    name: 'store-pack',
    async run({ demo, app, shot }) {
      await app.go(`#/p/${P}/new`, { settle: 2500 });
      await app.click('App Store', { selector: 'button' });
      await app.sleep(800);
      await app.click('Add the store pack to the formats');
      await app.sleep(1500);
      await shot('store-pack');
      await esc(app);
      const storePack = {
        app: { name: 'KOVA', tagline: 'Control your KOVA Air' }, stores: ['appstore', 'playstore'],
        devices: { appstore: ['iphone-69'], playstore: ['phone'] }, preview: false,
        screenshots: [{ caption: 'Noise cancelling, your way', screen: null }, { caption: '36 hours with the case', screen: null }, { caption: 'Find your buds', screen: null }],
      };
      const { slug } = await demo.api('POST', `${api(P)}/creatives/store-pack`, { title: 'KOVA app store pack', storePack, generate: true });
      await versions(demo, slug, 1);
      await app.go(`#/p/${P}/c/${slug}`, { settle: 7000 });
      await shot('store-pack-canvas');
      await app.click('Export', { exact: true });
      await app.sleep(3000);
      await shot('store-pack-export');
      await esc(app);
    },
  },
  {
    name: 'fernwise',
    async run({ demo, app, shot }) {
      // A video with a voice-over, and its subtitles (seeded: the demo has no transcription engine).
      const brief = {
        goal: 'The Fernwise year in review: where 2026 went, the savings curve, then the app.', message: 'Where did 2026 go?',
        formats: ['youtube-16x9', 'instagram-reel-9x16'], durationSec: 12, assets: [], notes: 'Calm, clear voice-over.',
      };
      const { slug } = await demo.api('POST', `${api('fernwise')}/creatives`, { title: 'Year in money', brief, generate: true });
      await versions(demo, slug, 1, 'fernwise');
      const { join } = await import('node:path');
      demo.seed('seed-subtitles.ts', join(demo.dirs.workspace, 'fernwise'), slug);
      await app.go(`#/p/fernwise/c/${slug}/subtitles/en`, { settle: 6000 });
      await app.mouse('.ms-subs-cue, [class*=cue]', 'Fernwise', {}).catch(() => {});
      await app.sleep(1500);
      await shot('subtitles');
      // The talk to camera in Assets: Analyse, the transcription choice, then the analysis.
      await app.go('#/p/fernwise/assets', { settle: 3000 });
      await app.js(() => document.querySelector('.ms-acard[data-file="founder-interview.mp4"] .ms-acard-open').click());
      await app.sleep(2000);
      await app.click('Analyse', { exact: true, within: '.ms-assets-detail' });
      await app.waitText('Continue without transcription', { timeout: 60_000 });
      await app.sleep(1500);
      await shot('transcription-choice');
      await app.click('Continue without transcription');
      await until(async () => (await demo.api('GET', `${api('fernwise')}/video-analyses/view?file=${encodeURIComponent('assets/founder-interview.mp4')}`)).state === 'ready', 'video analysis', 240_000);
      await app.go('#/p/fernwise/assets', { settle: 3000 });
      await app.js(() => document.querySelector('.ms-acard[data-file="founder-interview.mp4"] .ms-acard-open').click());
      await app.sleep(2500);
      await app.js(() => document.querySelector('.ms-assets-detail [class*=analysis]')?.scrollIntoView({ block: 'start' }));
      await app.sleep(800);
      await shot('video-analysis');
      await esc(app);
    },
  },
  {
    name: 'project',
    async run({ app, shot }) {
      for (const [label, name] of [['General', 'project-settings'], ['Agent and approvals', 'project-agent']]) {
        await app.go(`#/p/${P}/settings`, { settle: 2000 });
        await app.click(label, { within: '.ms-set-nav' });
        await app.sleep(1200);
        await shot(name);
      }
      await app.go(`#/p/${P}/references`, { settle: 2500 });
      await shot('references');
      await app.go('#/settings/usage', { settle: 3000 });
      await shot('settings-usage');
      await app.click('Activity', { selector: 'button' });
      await app.sleep(800);
      await app.click('Done', { within: '.ms-activity' });
      await app.sleep(1000);
      await shot('activity');
      await esc(app);
    },
  },
  {
    name: 'asset-detail',
    async run({ app, shot }) {
      await app.go(`#/p/${P}/assets`, { settle: 3000 });
      await app.js(() => document.querySelector('.ms-acard[data-file="kova-air-loop.mp4"] .ms-acard-open').click());
      await app.sleep(2500);
      await shot('asset-detail');
      await esc(app);
      await app.go(`#/p/${P}/assets`, { settle: 2000 });
      await app.click('Generate', { selector: 'button', exact: true });
      await app.sleep(1500);
      await shot('generate');
      await esc(app);
    },
  },
  {
    name: 'archive',
    async run({ demo, app, shot }) {
      const brief = { goal: 'A teaser for the KOVA Air pre-orders.', message: 'Pre-order now.', formats: ['instagram-post-1x1'], durationSec: 16, assets: [], notes: '' };
      const { slug } = await demo.api('POST', `${api(P)}/creatives`, { title: 'Pre-order teaser', brief, generate: true });
      await versions(demo, slug, 1);
      await app.go(`#/p/${P}/c/${slug}`, { settle: 4000 });
      await app.click('More actions');
      // Archiving asks nothing: the creative leaves the lists at once.
      await app.click('Archive', { selector: '[role=menuitem], button' });
      await app.sleep(2000);
      await app.go(`#/p/${P}`, { settle: 4000 });
      await shot('creatives');
      await app.click('Archived', { selector: 'button, a' });
      await app.sleep(1500);
      await shot('archived');
      await esc(app);
      await app.go(`#/p/${P}/c/${state.launch}`, { settle: 4000 });
      await app.click('More actions');
      await app.click('Delete', { selector: '[role=menuitem], button' });
      await app.sleep(1500);
      await shot('delete-confirm');
      await app.click('Cancel', { selector: '[role=dialog] button' });
      await app.sleep(600);
      await app.go('#/projects', { settle: 3000 });
      await shot('projects');
    },
  },
  {
    name: 'dark',
    async run({ demo, app, shot }) {
      await demo.api('PUT', '/api/settings', { theme: 'dark' });
      await app.reload();
      await app.go(`#/p/tidefall/c/${state.group}`, { settle: 7000 });
      await shot('dark-variants');
      await app.go(`#/p/${P}/c/${state.launch}/f/youtube-16x9`, { settle: 6000 });
      await seek(app, 0.45);
      await shot('dark-editor');
      await demo.api('PUT', '/api/settings', { theme: 'light' });
      await app.reload();
    },
  },
];
