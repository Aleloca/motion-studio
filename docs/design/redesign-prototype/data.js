/* Sample data: the Half Story project from the visual test, plus one example project. */
(function () {
  const IMG = {
    r1: '/_blob/70aba4542bfddbb91c98a5cf0db6977d', r25: '/_blob/3c803e0e433518772326ea24bdf390d5', r45: '/_blob/8feafb73f4fe1fe4f457579ff8bf46ff',
    r6: '/_blob/e9d04d5bd9e9d41eac06ce70657e4998', sq: '/_blob/b2168e819be8600d3f39fb6ccff4c943', pt: '/_blob/95dd18dc60ee556af494120319eee11e',
  };
  const FORMATS = [
    { id: 'ig-reel', ch: 'IG', channel: 'Instagram', name: 'Reel', kind: 'video', w: 1080, h: 1920, ratio: '9:16', note: '≤ 90 s' },
    { id: 'ig-feed', ch: 'IG', channel: 'Instagram', name: 'Feed video', kind: 'video', w: 1080, h: 1350, ratio: '4:5', note: '≤ 60 s' },
    { id: 'ig-square', ch: 'IG', channel: 'Instagram', name: 'Square image', kind: 'image', w: 1080, h: 1080, ratio: '1:1' },
    { id: 'ig-portrait', ch: 'IG', channel: 'Instagram', name: 'Portrait image', kind: 'image', w: 1080, h: 1350, ratio: '4:5' },
    { id: 'ig-story', ch: 'IG', channel: 'Instagram', name: 'Story image', kind: 'image', w: 1080, h: 1920, ratio: '9:16' },
    { id: 'tt-video', ch: 'TT', channel: 'TikTok', name: 'TikTok video', kind: 'video', w: 1080, h: 1920, ratio: '9:16', note: '≤ 3 min', linkable: true },
    { id: 'yt-shorts', ch: 'YT', channel: 'YouTube', name: 'Shorts', kind: 'video', w: 1080, h: 1920, ratio: '9:16', note: '≤ 60 s', linkable: true },
    { id: 'yt-video', ch: 'YT', channel: 'YouTube', name: 'YouTube video', kind: 'video', w: 1920, h: 1080, ratio: '16:9', note: '1080p' },
    { id: 'yt-4k', ch: 'YT', channel: 'YouTube', name: 'YouTube 4K', kind: 'video', w: 3840, h: 2160, ratio: '16:9', note: '2160p' },
    { id: 'yt-thumb', ch: 'YT', channel: 'YouTube', name: 'Thumbnail', kind: 'image', w: 1280, h: 720, ratio: '16:9' },
    { id: 'fb-feed', ch: 'FB', channel: 'Facebook', name: 'Feed 1:1', kind: 'video', w: 1080, h: 1080, ratio: '1:1' },
    { id: 'fb-story', ch: 'FB', channel: 'Facebook', name: 'Story', kind: 'video', w: 1080, h: 1920, ratio: '9:16' },
    { id: 'fb-cover', ch: 'FB', channel: 'Facebook', name: 'Cover', kind: 'image', w: 1640, h: 624, ratio: '2.6:1' },
    { id: 'li-post', ch: 'LI', channel: 'LinkedIn', name: 'Post', kind: 'image', w: 1200, h: 1200, ratio: '1:1' },
    { id: 'li-video', ch: 'LI', channel: 'LinkedIn', name: 'Video', kind: 'video', w: 1920, h: 1080, ratio: '16:9' },
    { id: 'x-video', ch: 'X', channel: 'X', name: 'Video', kind: 'video', w: 1920, h: 1080, ratio: '16:9' },
    { id: 'pin', ch: 'PIN', channel: 'Pinterest', name: 'Pin', kind: 'image', w: 1000, h: 1500, ratio: '2:3' },
    { id: 'as-69', ch: 'AS', channel: 'App Store', name: 'iPhone 6.9″', kind: 'image', w: 1320, h: 2868, ratio: '0.46' },
    { id: 'gp-feature', ch: 'GP', channel: 'Google Play', name: 'Feature graphic', kind: 'image', w: 1024, h: 500, ratio: '2:1' },
  ];
  const reelVersions = [
    { n: 1, at: '15:00', by: 'Agent', note: 'First render from the brief', img: IMG.r1 },
    { n: 2, at: '15:35', by: 'Agent', note: 'Smaller logo, longer end card', img: IMG.r25 },
    { n: 3, at: '15:41', by: 'Agent', note: 'TikTok and Shorts added', img: IMG.r45 },
    { n: 4, at: '15:55', by: 'Agent', note: 'Slower push-in', img: IMG.r25 },
    { n: 5, at: '16:02', by: 'Agent', note: 'Rain overlay', img: IMG.r45 },
    { n: 6, at: '16:12', by: 'You', note: 'Warmer sepia grade', img: IMG.r6 },
    { n: 7, at: '16:20', by: 'You', note: 'Headline moved up', img: IMG.r45 },
  ];
  const creative = {
    id: 'crime', title: 'A crime a week', updated: '5 min ago', state: 'needs-you',
    brief: { goal: "A short teaser for this week's case. Open on the crime scene, let the orange leaf be the only color, then cut to Calder at night and close on the logo.", message: 'A crime a week. A whole city to question.', length: 6 },
    outputs: [
      { fid: 'ig-reel', versions: reelVersions, star: 5, editing: 7, img: IMG.r45 },
      { fid: 'tt-video', follows: 'ig-reel' },
      { fid: 'yt-shorts', follows: 'ig-reel' },
      { fid: 'ig-square', versions: [{ n: 1, at: '15:00', by: 'Agent', note: 'First render', img: IMG.sq }, { n: 2, at: '15:35', by: 'Agent', note: 'Logo smaller', img: IMG.sq }], star: 2, editing: 2, img: IMG.sq },
    ],
    chat: [
      { id: 'c1', who: 'you', at: '15:31', text: 'Make the logo a bit smaller and hold the final frame one second longer.', ref: 'Reel · 0:05' },
      { id: 'c2', who: 'agent', at: '15:32', text: 'Scaling the wordmark to 82% and extending the end card to 2 seconds.' },
      { id: 'c3', who: 'agent', at: '15:35', text: 'Reel v2 is ready. The logo now leaves room for the tagline.' },
    ],
    comments: [{ id: 'k1', fid: 'ig-reel', t: 5.0, x: 46, y: 63, text: 'Make the logo a bit smaller and hold this frame one second longer.', done: true }],
  };
  const creatives = [
    creative,
    { id: 'case092', title: 'Case 092 teaser', updated: 'Started 2 min ago', state: 'running', progress: 62, step: 'Rendering 210 frames', outputs: [{ fid: 'ig-reel', img: IMG.r25 }] },
    { id: 'weekly', title: 'Weekly case post', updated: '2 h ago', state: 'ready', outputs: [{ fid: 'ig-square', img: IMG.sq, star: 1 }, { fid: 'li-post', img: IMG.sq, star: 1 }] },
    { id: 'loop', title: 'Calder at night loop', updated: 'Yesterday', state: 'failed', error: 'The video came out 9 s long; TikTok expects 7 s', outputs: [{ fid: 'tt-video', img: IMG.r1 }] },
    { id: 'appstore', title: 'App Store screenshots', updated: 'Draft', state: 'draft', outputs: [] },
  ];
  const brand = {
    summary: 'A weekly noir detective game set in the city of Calder. Monochrome sepia ink on aged paper, with a single clue-orange accent.',
    colors: [
      { id: 'ink', name: 'Ink black', hex: '1B1913', role: 'Background' }, { id: 'sepia', name: 'Sepia shadow', hex: '342C1E', role: 'Secondary' },
      { id: 'umber', name: 'Faded umber', hex: '856E51', role: 'Secondary' }, { id: 'paper', name: 'Aged paper', hex: 'DAC5A3', role: 'Text on dark' },
      { id: 'parch', name: 'Parchment', hex: 'FBE8C3', role: 'Headlines' }, { id: 'clue', name: 'Clue orange', hex: 'E86808', role: 'Accent · once per frame' },
      { id: 'white', name: 'Logo white', hex: 'FFFFFF', role: 'Logo only' },
    ],
    fonts: [
      { id: 'nr', family: 'Newsreader', role: 'Headings + body', styles: '400 · 400 italic', sample: 'A crime a week.', sub: 'This week in Calder.', css: 'var(--serif)' },
    ],
    voice: 'Measured, atmospheric noir. Short, declarative sentences with dry understatement. Speaks to the player as a detective and invites them to deduce.',
    dos: ['Anchor messaging on the weekly ritual: a new case every Monday.', 'Keep visuals sepia; orange only marks the clue.', 'Write short lines in pairs or triplets.', 'Address the player as the detective (“you”).', 'Be plain about the use of AI when asked.', 'Mention mobile and browser, six languages.'],
    donts: ['Never reveal case solutions or correct answers.', 'Loud, hype-driven or urgent marketing language.', 'Graphic violence: suggest with silhouettes and clues.', 'Bright, saturated multi-colour palettes or glossy 3D.', 'Recolouring or distorting the wordmark.'],
    sources: [{ url: 'half-story.com', at: 'today 14:18', found: 25, applied: 22 }],
    history: ['14:23 · You renamed “Clue orange”', '14:20 · You applied 22 of 25 suggestions', '14:18 · Analysis of half-story.com'],
  };
  const assets = [
    { id: 'a1', name: 'Wordmark, white', file: 'brand/half-story-logo-white.svg', kind: 'logo', origin: 'website', desc: 'Distressed wordmark for dark backgrounds', tags: ['logo', 'svg'], size: 'SVG · 250×31' },
    { id: 'a2', name: 'App icon', file: 'brand/half-story-app-icon.png', kind: 'logo', origin: 'website', desc: 'Noir detective in a fedora with an orange hat band', tags: ['logo', 'detective'], size: '144×144 · 18 KB' },
    { id: 'a3', name: 'Crime scene splash', file: 'brand/home-splash-scene.jpg', kind: 'image', origin: 'website', desc: 'Silhouette in a doorway, an orange leaf as the clue', tags: ['sepia', 'crime-scene'], size: '900×1350 · 212 KB', img: IMG.r25 },
    { id: 'a4', name: 'Case 091 cover', file: 'brand/case-091-artwork.webp', kind: 'image', origin: 'website', desc: 'Art Deco building in Calder at night', tags: ['sepia', 'city'], size: '1536×1024 · 388 KB', img: IMG.r6 },
    { id: 'a5', name: 'Abdul Wahab, portrait', file: 'abdul_wahab.png', kind: 'image', origin: 'uploaded', desc: 'Vertical (2:3) ink-and-sepia-wash portrait of a middle-aged man with curly greying black hair, in a light beige blazer over a dark collarless shirt and a cord necklace with an orange bead, glancing thoughtfully to the side.', tags: ['portrait', 'illustration', 'ink sketch', 'sepia', 'character'], size: '1024×1536 · 2.0 MB', img: IMG.pt },
    { id: 'a6', name: 'Newsreader Regular', file: 'fonts/Newsreader-400.ttf', kind: 'font', origin: 'google', desc: 'Google Fonts · OFL', tags: ['font'], size: 'TTF · 412 KB', sample: 'A crime a week.' },
    { id: 'a7', name: 'Newsreader Italic', file: 'fonts/Newsreader-400-italic.ttf', kind: 'font', origin: 'google', desc: 'Google Fonts · OFL', tags: ['font'], size: 'TTF · 436 KB', sample: 'This week in Calder.', italic: true },
  ];
  const references = [
    { id: 'r1', type: 'image', img: IMG.r25, h: 360, note: 'The single orange leaf is the whole palette idea.', src: 'half-story.com', on: true },
    { id: 'r2', type: 'note', note: 'Typewriter clicks for the text reveals, never a music bed louder than the rain.', src: 'You · today 15:02' },
    { id: 'r3', type: 'image', img: IMG.r6, h: 200, note: 'Art Deco lines, rain and one warm light source.', src: 'half-story.com', on: true },
    { id: 'r4', type: 'link', title: 'Noir title sequences, a study', note: 'Slow push-ins, type that appears letter by letter.', src: 'vimeo.com', badge: 'Video · 1:42' },
    { id: 'r5', type: 'image', img: IMG.pt, h: 320, note: 'Character sheets should feel like this: loose hatching, one orange detail.', src: 'Uploaded' },
    { id: 'r6', type: 'link', title: 'Art Deco signage, 1930s', note: 'Board with 48 pins · lettering for street scenes', src: 'pinterest.com', deco: true },
  ];
  const permissions = [
    { id: 'p1', icon: 'folder', label: 'Save files in your export folder', rule: 'Edit(//Users/you/Desktop/Half Story/**)', at: 'Today 15:43' },
    { id: 'p2', icon: 'terminal', label: 'Compress images with pngquant', rule: 'Bash(pngquant:*)', at: 'Today 14:51' },
    { id: 'p3', icon: 'globe', label: 'Read pages on half-story.com', rule: 'WebFetch(domain:half-story.com)', at: 'Today 14:13' },
    { id: 'p4', icon: 'key', label: 'Generate images with OpenAI without asking', rule: 'Paid · about $0.04–0.19 per image', at: 'Yesterday', paid: true },
  ];
  const projects = [
    { id: 'hs', name: 'Half Story', site: 'half-story.com', updated: '5 min ago', creatives: 5, assets: 7, palette: ['#1B1913', '#342C1E', '#856E51', '#DAC5A3', '#FBE8C3', '#E86808'], cover: [IMG.sq, IMG.r45, IMG.r25] },
    { id: 'nw', name: 'Northwind Coffee', site: 'Example project', updated: 'Yesterday', creatives: 2, assets: 11, palette: ['#2F4A3A', '#6E8B5E', '#C9A66B', '#EFE7DA', '#B5532E'], word: 'Northwind' },
  ];
  window.MSDATA = { IMG, FORMATS, creatives, brand, assets, references, permissions, projects };
})();
