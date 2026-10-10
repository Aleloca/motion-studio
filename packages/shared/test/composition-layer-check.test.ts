import { describe, expect, it } from 'vitest';
import { compositionProblemText, staticLayerCheck, staticLayerCheckWork } from '../src/index.ts';

const keys = (html: string) => staticLayerCheck(html).map((p) => p.key);
const apis = (html: string) => staticLayerCheck(html).map((p) => p.params.api);

describe('staticLayerCheck: forbidden APIs (30 cases)', () => {
  it.each([
    ['fetch call', `<script>fetch('/api/x')</script>`, 'composition.layerNetwork', 'fetch'],
    ['fetch with spaces', `<script>fetch   ( u )</script>`, 'composition.layerNetwork', 'fetch'],
    ['window.fetch reference', `<script>const f = window.fetch; f(u)</script>`, 'composition.layerNetwork', 'fetch'],
    ['fetch by string key', `<script>self['fetch'](u)</script>`, 'composition.layerNetwork', 'fetch'],
    ['XMLHttpRequest', `<script>new XMLHttpRequest()</script>`, 'composition.layerNetwork', 'XMLHttpRequest'],
    ['WebSocket', `<script>new WebSocket(addr)</script>`, 'composition.layerNetwork', 'WebSocket'],
    ['EventSource', `<script>new EventSource('/s')</script>`, 'composition.layerNetwork', 'EventSource'],
    ['navigator.sendBeacon', `<script>navigator.sendBeacon('/b', d)</script>`, 'composition.layerNetwork', 'sendBeacon'],
    ['RTCPeerConnection', `<script>new RTCPeerConnection()</script>`, 'composition.layerNetwork', 'RTCPeerConnection'],
    ['WebTransport', `<script>new WebTransport(u)</script>`, 'composition.layerNetwork', 'WebTransport'],
    ['dynamic import of an https URL', `<script type=module>import('https://cdn.example.com/x.js')</script>`, 'composition.layerNetwork', 'import()'],
    ['dynamic import with spaces', `<script>import ( "https://cdn.example.com/x.js" )</script>`, 'composition.layerNetwork', 'import()'],
    ['dynamic import of a data: URL', `<script>import("data:text/javascript,alert(1)")</script>`, 'composition.layerNetwork', 'import()'],
    ['dynamic import of an absolute path', `<script>import('/core/api.js')</script>`, 'composition.layerNetwork', 'import()'],
    ['dynamic import of an expression', `<script>import(base + 'x.js')</script>`, 'composition.layerNetwork', 'import()'],
    ['dynamic import of a template literal', `<script>import(\`./\${x}\`)</script>`, 'composition.layerNetwork', 'import()'],
    ['http URL in an attribute', `<img src="http://example.com/a.png">`, 'composition.layerNetwork', 'http://'],
    ['HTTPS URL in capitals', `<link rel=stylesheet href="HTTPS://example.com/a.css">`, 'composition.layerNetwork', 'https://'],
    ['ws URL in a string', `<script>const u = 'ws://127.0.0.1:4000'</script>`, 'composition.layerNetwork', 'ws://'],
    ['protocol-relative URL in CSS', `<style>body{background:url(//cdn.example.com/x.png)}</style>`, 'composition.layerNetwork', '//'],
    ['protocol-relative URL in an attribute', `<script src='//cdn.example.com/x.js'></script>`, 'composition.layerNetwork', '//'],
    ['Worker', `<script>const w = new Worker('w.js')</script>`, 'composition.layerWorker', 'Worker'],
    ['SharedWorker', `<script>new SharedWorker('w.js')</script>`, 'composition.layerWorker', 'SharedWorker'],
    ['importScripts', `<script>importScripts('a.js')</script>`, 'composition.layerWorker', 'importScripts'],
    ['serviceWorker', `<script>navigator.serviceWorker.register('sw.js')</script>`, 'composition.layerWorker', 'serviceWorker'],
    ['AudioContext', `<script>new AudioContext()</script>`, 'composition.layerAudio', 'AudioContext'],
    ['webkitAudioContext', `<script>new webkitAudioContext()</script>`, 'composition.layerAudio', 'webkitAudioContext'],
    ['OfflineAudioContext', `<script>new OfflineAudioContext(2, 44100, 44100)</script>`, 'composition.layerAudio', 'OfflineAudioContext'],
    ['video autoplay', `<video src="../assets/a.mp4" muted autoplay loop></video>`, 'composition.layerAutoplay', 'autoplay'],
    ['VIDEO AUTOPLAY in capitals', `<VIDEO AUTOPLAY SRC="../assets/a.mp4"></VIDEO>`, 'composition.layerAutoplay', 'autoplay'],
  ])('%s', (_name, html, key, api) => {
    const problems = staticLayerCheck(html);
    expect(problems.map((p) => [p.key, p.params.api])).toContainEqual([key, api]);
  });

  it('also flags audio autoplay and the autoplay property set from script', () => {
    expect(keys('<audio autoplay src="../assets/a.wav"></audio>')).toContain('composition.layerAutoplay');
    expect(keys('<script>v.autoplay = true</script>')).toContain('composition.layerAutoplay');
  });
});

describe('staticLayerCheck: clean layers', () => {
  it.each([
    ['the spike outro layer shape', `<!doctype html><style>@font-face{font-family:F;src:url(../assets/f.ttf)}</style><script src="../assets/lib.js"></script><script>const t0 = performance.now(); requestAnimationFrame(draw); window.msTimeline = tl;</script>`],
    ['relative dynamic imports', `<script type=module>import('./a.js'); import("../assets/b.js")</script>`],
    ['prose that mentions fetch and workers', `<p>Go fetch the ball. Workers unite.</p>`],
    ['a video that does not autoplay', `<video src="../assets/a.mp4" muted playsinline></video>`],
    ['a data attribute containing autoplay', `<video data-autoplay="no" src="../assets/a.mp4"></video>`],
    ['an autoplay word outside a media tag', `<p>autoplay is not used here</p>`],
    ['identifiers containing a forbidden word', `<script>const myfetcher = 1; const prefetch = 2; const WorkerPool = 3; const importScriptsNot = 4;</script>`],
    ['a JS line comment', `<script>// a comment\nconst a = 1; // another</script>`],
    ['an HTML comment', `<!-- fetch('/api') new Worker(x) http://example.com -->\n<p>ok</p>`],
    ['a JS line comment hiding an API', `<script>const a = 1; // fetch('/api') or new WebSocket(u)\nconst b = 2;</script>`],
    ['a JS block comment hiding an API', `<script>/* new Worker('w.js')\n new AudioContext() */ const a = 1;</script>`],
    ['a CSS comment hiding a URL', `<style>/* background: url(http://example.com/x.png) */ body { margin: 0 }</style>`],
    ['autoplay switched off from script', `<script>v.autoplay = false; w.autoplay=0; x.autoplay = null;</script>`],
    ['an SVG namespace is a URL in an attribute, but only xmlns', `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>`],
  ])('%s → no problems', (_name, html) => {
    expect(staticLayerCheck(html)).toEqual([]);
  });
});

describe('staticLayerCheck: comments do not hide code around them', () => {
  it.each([
    ['comment markers inside a script string are not comments', `<script>const s = "// not a comment"; fetch(u)</script>`, 'fetch'],
    ['a block-comment opener inside a string', `<script>const s = '/*'; fetch(u); const t = '*/';</script>`, 'fetch'],
    ['code before a line comment', `<script>fetch(a) // why</script>`, 'fetch'],
    ['code after a closed block comment', `<script>/* note */ new WebSocket(u)</script>`, 'WebSocket'],
    ['code after an HTML comment', `<!-- note --><img src="http://example.com/x.png">`, 'http://'],
    ['code after the script ends', `<script>// x</script><img src="https://example.com/a.png">`, 'https://'],
    ['autoplay switched on from script', `<script>v.autoplay = true</script>`, 'autoplay'],
    ['a comparison is not an assignment', `<script>if (v.autoplay == false) {}</script>`, 'autoplay'],
  ])('%s', (_name, html, api) => {
    expect(apis(html)).toContain(api);
  });
  it('lines are still counted across skipped comments', () => {
    expect(staticLayerCheck('<!--\n\n-->\n<script>/*\n*/\nfetch(u)</script>')[0]!.params.line).toBe(6);
  });
});

describe('staticLayerCheck: reporting', () => {
  it('reports the line of the first occurrence, once per API', () => {
    const problems = staticLayerCheck('<p>a</p>\n<script>\nfetch(a)\nfetch(b)\n</script>');
    expect(problems).toEqual([{ key: 'composition.layerNetwork', params: { file: 'layer', line: 3, api: 'fetch' } }]);
  });
  it('names the file when given', () => {
    expect(staticLayerCheck('<script>new Worker(x)</script>', 'layers/outro.html')[0]!.params.file).toBe('layers/outro.html');
  });
  it('caps the number of problems', () => {
    const html = Array.from({ length: 50 }, (_, i) => `http://a${i}.example.com`).join(' ') + ' fetch(x) new WebSocket(y) new Worker(z) new AudioContext()';
    expect(staticLayerCheck(html).length).toBeLessThanOrEqual(20);
  });
  it('every problem is translated in both languages and says what to do', () => {
    const html = `<script>fetch(a); new Worker(b); new AudioContext()</script><video autoplay></video>`;
    for (const p of staticLayerCheck(html, 'layers/x.html')) {
      for (const locale of ['en', 'it'] as const) {
        const text = compositionProblemText(p, locale);
        expect(text).toContain('layers/x.html');
        expect(text).not.toBe(p.key);
      }
    }
    expect(apis('<script>fetch(a)</script>')).toEqual(['fetch']);
  });
});

describe('staticLayerCheck: bounded, linear work', () => {
  const MB = 1024 * 1024;
  const hostile: Array<[string, string]> = [
    ['repeated "import(" with an unterminated string', `import('${'a'.repeat(30)}`],
    ['repeated "<video" with no closing >', '<video '],
    ['repeated "://"', 'a://'],
    ['repeated "//" after quotes', `"//`],
    ['one huge identifier', 'f'],
    ['repeated fetch without call', 'fetch '],
    ['repeated "new" before spaces', 'new      '],
    ['repeated "<" ', '<'],
    ['a long unterminated tag full of attributes', '<video ' + 'data-x=1 '.repeat(10)],
    ['repeated HTML comment openers', '<!--'],
    ['repeated script tags with block comments', '<script>/*'],
    ['repeated script tags with line comments', '<script>//x\n'],
    ['repeated quotes and escapes in a script', `<script>'\\"\\\``],
  ];
  it.each(hostile)('%s: 1 MB costs at most a few steps per character', (_name, unit) => {
    const html = unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
    const { steps, problems } = staticLayerCheckWork(html);
    expect(steps).toBeLessThanOrEqual(8 * html.length);
    expect(problems.length).toBeLessThanOrEqual(20);
  });
  it('1 MB of hostile HTML runs quickly (generous sanity bound; the real check is the work count above)', () => {
    const html = hostile.map(([, u]) => u.repeat(Math.ceil(MB / 9 / u.length))).join('').slice(0, MB);
    const t0 = performance.now();
    staticLayerCheck(html);
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
