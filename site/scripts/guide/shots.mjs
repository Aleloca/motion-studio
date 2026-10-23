// The guide's screenshots, in order: each step builds on the state the previous ones left (see guide-shots.mjs).
const P = 'ember-coffee';
const base = `/api/projects/${P}`;
/** Slugs made along the way. */
const state = {};

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

/** Uploads local files into the project's Assets. */
async function upload(demo, files) {
  const { readFileSync } = await import('node:fs');
  const { basename } = await import('node:path');
  const form = new FormData();
  for (const f of files) form.append('files', new Blob([readFileSync(f)]), basename(f));
  return demo.api('POST', `${base}/assets`, form);
}

/** Waits until the creative has `n` versions and no job runs on it. */
async function versions(demo, creative, n) {
  return until(async () => {
    const d = await demo.api('GET', `${base}/creatives/${creative}`);
    return d.versions.length >= n && !d.job ? d : null;
  }, `${creative} v${n}`, 180_000);
}

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
      await demo.api('POST', '/api/projects', { name: 'Ember Coffee', description: 'Launch of the Ember Coffee app' });
      await demo.api('POST', '/api/projects', { name: 'Spring Menu', description: 'Seasonal drinks, spring 2027' });
      await app.reload();
    },
  },
  {
    name: 'projects',
    async run({ app, shot }) {
      await app.go('#/projects');
      await app.waitText('Ember Coffee');
      await shot('projects');
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
      await demo.api('POST', `${base}/brand/sources`, { kind: 'website', url: 'https://ember-coffee.example' });
      await demo.api('POST', `${base}/brand/analyze`, {});
      const proposal = await until(async () => (await demo.api('GET', `${base}/brand`)).proposals.find((p) => p.status === 'open'), 'brand proposal');
      await app.reload();
      await app.go(`#/p/${P}/brand`, { settle: 2500 });
      await shot('brand-proposal');
      await demo.api('POST', `${base}/brand/proposals/${proposal.id}/apply`, { acceptedIds: proposal.changes.map((c) => c.id), applyGuidelines: true });
      await app.reload();
      await app.go(`#/p/${P}/brand`, { settle: 2500 });
      await shot('brand-kit');
    },
  },
  {
    name: 'assets',
    async run({ demo, app, media, shot }) {
      await upload(demo, media);
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
      await app.fill(box, 'A 6 second launch teaser for the app, for Instagram and YouTube. Bold and warm.');
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
      const brief = {
        goal: 'A launch teaser for the Ember Coffee app: order ahead, skip the line. Open on the bean, then the headline, end on the button.',
        message: 'Brew something bold.', formats: ['instagram-reel-9x16', 'instagram-post-1x1', 'youtube-16x9'], durationSec: 6,
        assets: ['assets/ember-hero.png'], notes: 'Warm and bold. Orange on roast black.',
      };
      const { slug } = await demo.api('POST', `${base}/creatives`, { title: 'App launch teaser', brief, generate: true });
      state.teaser = slug;
      await versions(demo, slug, 1);
      await app.go(`#/p/${P}/c/${slug}`, { settle: 5000 });
      await shot('canvas');
      await app.go(`#/p/${P}`, { settle: 2500 });
      await shot('creatives');
    },
  },
  {
    name: 'creative',
    async run({ demo, app, shot }) {
      const c = state.teaser;
      await app.go(`#/p/${P}/c/${c}`, { settle: 4000 });
      // The chat's panel and the + menu of the composer.
      await shot('chat', { selector: '.ms-chat-col', pad: 0 });
      await app.click('Brief', { exact: true });
      await app.sleep(800);
      await shot('brief-tab', { selector: '.ms-chat-col', pad: 0 });
      await app.click('Chat', { exact: true });
      // The agent at work: the turn waits (GUIDE_HOLD) after its first step.
      const { writeFileSync, rmSync } = await import('node:fs');
      writeFileSync(demo.hold, '');
      await app.fill('textarea[placeholder^="Describe what to change"]', 'Make the headline warmer and more personal.');
      await app.click('Send', { selector: '.ms-chat-col .ms-composer-send' });
      await app.waitText('Stop', { timeout: 30_000 });
      await app.sleep(2500);
      await app.fill('.ms-chat-col textarea', 'Also try a lighter background for the post.');
      await app.sleep(500);
      await shot('agent-working');
      await app.click('Stop options');
      await app.sleep(600);
      await shot('stop-menu', { selector: '.ms-chat-col', pad: 0 });
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.sleep(400);
      rmSync(demo.hold, { force: true });
      await versions(demo, c, 2);
      await app.fill('.ms-chat-col textarea', '');
      await app.sleep(7000);
      await shot('canvas-v2');
    },
  },
  {
    name: 'editor',
    async run({ demo, app, shot }) {
      const c = state.teaser;
      await app.go(`#/p/${P}/c/${c}/f/youtube-16x9`, { settle: 6000 });
      // The playhead at 3.3 s, where every clip is on stage.
      await app.mouse('.ms-tl-ruler', '', { dx: 0.55 });
      await app.sleep(1500);
      await shot('editor');
      await app.mouse('.ms-sc-clip', 'Headline');
      await app.sleep(1200);
      await shot('editor-inspector');
      await app.fill('textarea[aria-label="Content"]', 'Brew something bold, today.');
      await app.sleep(1500);
      await shot('editor-draft');
      await app.click('Save as v3');
      await versions(demo, c, 3);
      await app.sleep(3000);
      // A comment on a spot of the frame, at 3.3 s.
      await app.mouse('.ms-tl-ruler', '', { dx: 0.55 });
      await app.sleep(1200);
      await app.click('Comment a spot');
      await app.mouse('.ms-fv-stage, .ms-ed-stage, [class*=stage]', '', { dx: 0.72, dy: 0.45 });
      await app.sleep(1000);
      await app.fill('[role=dialog] textarea', 'Make the bean a little smaller here, it crowds the headline.');
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
      await app.mouse('[role=dialog] [role=slider]', '', { dx: 0.55 }).catch(() => {});
      await app.sleep(2000);
      await shot('compare');
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.sleep(800);
    },
  },
  {
    name: 'export',
    async run({ app, shot }) {
      const c = state.teaser;
      await app.go(`#/p/${P}/c/${c}`, { settle: 4000 });
      await app.click('Export', { exact: true });
      await app.sleep(2500);
      await shot('export');
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.sleep(800);
      await app.click('More actions');
      await app.sleep(800);
      await shot('creative-menu');
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.sleep(500);
    },
  },
  {
    name: 'chat-tools',
    async run({ app, shot }) {
      const c = state.teaser;
      await app.go(`#/p/${P}/c/${c}`, { settle: 4000 });
      await app.click('Attach files');
      await app.sleep(800);
      await shot('composer-attach', { selector: '.ms-chat-col' });
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.sleep(400);
      await app.click('Services:', { selector: 'button' });
      await app.sleep(800);
      await shot('services');
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.sleep(400);
    },
  },
  {
    name: 'languages',
    async run({ demo, app, shot }) {
      const c = state.teaser;
      const d = await demo.api('GET', `${base}/creatives/${c}`);
      await demo.api('PUT', `${base}/creatives/${c}`, { brief: { ...d.creative.brief, locales: { primary: 'en', extra: ['it', 'de', 'es'] } } });
      await app.go(`#/p/${P}/c/${c}/f/instagram-reel-9x16`, { settle: 5000 });
      await app.mouse('.ms-tl-ruler', '', { dx: 0.55 });
      await app.sleep(1500);
      await app.click('Languages', { selector: 'button' });
      await app.sleep(1500);
      await shot('languages');
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.sleep(600);
      await app.click('More actions');
      await app.sleep(800);
      await shot('format-menu');
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.sleep(400);
    },
  },
  {
    name: 'brief-editor',
    async run({ app, shot }) {
      const c = state.teaser;
      await app.go(`#/p/${P}/c/${c}`, { settle: 4000 });
      await app.click('Brief', { exact: true });
      await app.click('Edit the brief');
      await app.sleep(1500);
      await shot('brief-editor');
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.sleep(600);
    },
  },
  {
    name: 'variants',
    async run({ demo, app, shot }) {
      const brief = {
        goal: 'A spring promo for the new oat latte: three directions to choose from.', message: 'Spring, in a cup.',
        formats: ['instagram-reel-9x16', 'youtube-16x9'], durationSec: 6, assets: [], notes: '',
      };
      const { slug } = await demo.api('POST', `${base}/creatives`, { title: 'Oat latte promo', brief, generate: false });
      state.group = slug;
      await demo.api('POST', `${base}/creatives/${slug}/variants`, { count: 3, directions: ['Dark and bold', 'Light, lots of white space', 'Loud orange'] });
      await demo.api('POST', `${base}/creatives/${slug}/variants/run`, { targets: 'all-active', request: null });
      for (const v of [slug, `${slug}~b`, `${slug}~c`]) await versions(demo, v, 1);
      await app.go(`#/p/${P}/c/${slug}`, { settle: 7000 });
      await shot('variants');
      const esc = async () => { await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await app.sleep(600); };
      await app.click('More actions');
      await app.sleep(800);
      await shot('group-menu');
      await esc();
      await app.click('+ Variant');
      await app.sleep(1200);
      await shot('add-variant');
      await esc();
      await app.click('Final selection');
      await app.sleep(1500);
      await shot('final-selection');
      await esc();
    },
  },
  {
    name: 'identity',
    async run({ app, shot }) {
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
      await app.click('Logo', { selector: 'button, [role=checkbox]' });
      await app.click('App Store', { selector: 'button' });
      await app.sleep(800);
      await app.click('Add the store pack to the formats');
      await app.sleep(1500);
      await shot('store-pack');
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.sleep(600);
    },
  },
  {
    name: 'project',
    async run({ app, shot }) {
      for (const [tab, name] of [['general', 'project-settings'], ['agent', 'project-agent']]) {
        await app.go(`#/p/${P}/settings`, { settle: 2000 });
        await app.click({ general: 'General', agent: 'Agent and approvals', code: 'Linked code' }[tab], { within: '.ms-set-nav' });
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
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.sleep(500);
    },
  },
  {
    name: 'asset-detail',
    async run({ app, shot }) {
      await app.go(`#/p/${P}/assets`, { settle: 3000 });
      await app.js(() => document.querySelector('.ms-acard[data-file="cafe-loop.mp4"] .ms-acard-open').click());
      await app.sleep(2500);
      await shot('asset-detail');
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.sleep(600);
      await app.go(`#/p/${P}/assets`, { settle: 2000 });
      await app.click('Generate', { selector: 'button', exact: true });
      await app.sleep(1500);
      await shot('generate');
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.sleep(600);
    },
  },
  {
    name: 'archive',
    async run({ demo, app, shot }) {
      const brief = { goal: 'A holiday card for the coffee shop windows.', message: 'Warm wishes from Ember.', formats: ['instagram-post-1x1'], durationSec: 6, assets: [], notes: '' };
      const { slug } = await demo.api('POST', `${base}/creatives`, { title: 'Holiday card', brief, generate: true });
      await versions(demo, slug, 1);
      await app.go(`#/p/${P}/c/${slug}`, { settle: 4000 });
      await app.click('More actions');
      // Archiving asks nothing: the creative leaves the lists at once.
      await app.click('Archive', { selector: '[role=menuitem], button' });
      await app.sleep(2000);
      await app.go(`#/p/${P}`, { settle: 3000 });
      await shot('creatives');
      await app.click('Archived', { selector: 'button, a' });
      await app.sleep(1500);
      await shot('archived');
      await app.js(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await app.go(`#/p/${P}/c/${state.teaser}`, { settle: 4000 });
      await app.click('More actions');
      await app.click('Delete', { selector: '[role=menuitem], button' });
      await app.sleep(1500);
      await shot('delete-confirm');
      await app.click('Cancel', { selector: '[role=dialog] button' });
      await app.sleep(600);
    },
  },
  {
    name: 'dark',
    async run({ demo, app, shot }) {
      await demo.api('PUT', '/api/settings', { theme: 'dark' });
      await app.reload();
      await app.go(`#/p/${P}/c/${state.group}`, { settle: 6000 });
      await shot('dark-variants');
      await app.go(`#/p/${P}/c/${state.teaser}/f/youtube-16x9`, { settle: 6000 });
      await app.mouse('.ms-tl-ruler', '', { dx: 0.55 });
      await app.sleep(1500);
      await shot('dark-editor');
      await demo.api('PUT', '/api/settings', { theme: 'light' });
      await app.reload();
    },
  },
];
