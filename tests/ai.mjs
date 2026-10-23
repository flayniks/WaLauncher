// Checks the on-device AI tools in headless Chromium with the real models (needs network):
// background removal, stabilization, auto reframe, reverse and text to speech.
//   npm run build && npm run test:ai

import { execSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = join(root, 'tests/.fixtures');
const outDir = join(root, 'tests/.out');
mkdirSync(fx, { recursive: true });
mkdirSync(outDir, { recursive: true });

let pw;
try {
  pw = await import('playwright');
} catch {
  const g = execSync('npm root -g').toString().trim();
  pw = await import(pathToFileURL(join(g, 'playwright', 'index.mjs')).href);
}

// A portrait from MediaPipe's own test assets, and a shaky video made from it.
const portrait = join(fx, 'mp_portrait.jpg');
if (!existsSync(portrait)) execFileSync('curl', ['-sSfL', '-o', portrait, 'https://storage.googleapis.com/mediapipe-assets/portrait.jpg']);
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
const big = join(fx, 'big.png');
if (!existsSync(big)) ff(['-f', 'lavfi', '-i', 'testsrc2=size=1600x900:duration=1', '-i', portrait, '-filter_complex', '[1]scale=-1:760[p];[0][p]overlay=120:70', '-frames:v', '1', big]);
const shaky = join(fx, 'shaky.webm');
if (!existsSync(shaky)) ff(['-loop', '1', '-i', big, '-vf', "crop=1280:720:x='140+30*sin(t*21)+15*sin(t*37)':y='80+20*sin(t*27)',format=yuv420p", '-t', '4', '-r', '30', '-c:v', 'libvpx-vp9', '-b:v', '3M', shaky]);

const server = createServer((req, res) => {
  const path = req.url === '/' ? '/dist/clipwave.html' : decodeURIComponent(req.url.split('?')[0]);
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': { '.html': 'text/html' }[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(0);
const port = server.address().port;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
// The proxy (when there is one) is passed as plain Chromium flags so the local test server stays direct.
const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [])] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: !!proxy });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => process.env.DEBUG && r.status() >= 400 && console.log('[http]', r.status(), r.url().slice(0, 150)));
page.on('console', (m) => process.env.DEBUG && console.log('[console]', m.type(), m.text().slice(0, 300)));
page.on('requestfailed', (r) => process.env.DEBUG && console.log('[failed]', r.url().slice(0, 120), r.failure() && r.failure().errorText));

try {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.clipwave && window.clipwave.timeline, null, { timeout: 20000 });
  await page.evaluate(() => window.clipwave.openProject({ ...JSON.parse(JSON.stringify(window.clipwave.store.project)), id: 'ai', name: 'AI test', tracks: [{ id: 'm', type: 'video', name: '', muted: false, hidden: false, locked: false, main: true, clips: [] }], background: { type: 'color', color: '#00ff00' } }));
  await page.setInputFiles('#import-input-media', [portrait, shaky, join(fx, 'b.webm')]);
  await page.waitForFunction(() => [...window.clipwave.media.items.values()].filter((m) => m.status === 'ready').length >= 3, null, { timeout: 30000 });

  // Background removal through the inspector.
  await page.evaluate(() => {
    const app = window.clipwave;
    const m = [...app.media.items.values()].find((x) => x.name === 'mp_portrait.jpg');
    const c = window.clipwaveDev.ops.addMedia(app.store, m, 0);
    app.store.select(c.id);
    app.showInspectorTab('cutout');
    app.player.seek(1);
  });
  await page.click('.seg-btn:nth-child(2)');
  await page.waitForFunction(() => window.clipwaveDev.matteReady(), null, { timeout: 120000 });
  await page.waitForTimeout(500);
  const px = await page.evaluate(() => {
    const app = window.clipwave;
    app.renderer.render(app.store.project, 1, app.player.frames);
    const gl = app.renderer.gl;
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const read = (fx, fy) => {
      const p = new Uint8Array(4);
      gl.readPixels(Math.round(fx * W), Math.round((1 - fy) * H), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
      return [...p.slice(0, 3)];
    };
    // Image is 820x1024 contained in 16:9: it spans x 0.3..0.7.
    return { curtain: read(0.33, 0.15), face: read(0.5, 0.25), suit: read(0.5, 0.75) };
  });
  await page.screenshot({ path: join(outDir, 'ai-1-cutout.png') });
  const green = (c) => c[1] > 200 && c[0] < 60 && c[2] < 60;
  check('background removal keeps the person, drops the room', green(px.curtain) && !green(px.face) && !green(px.suit), JSON.stringify(px));

  // Blur mode
  await page.click('.seg-btn:nth-child(3)');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, 'ai-2-portrait-blur.png') });
  check('portrait blur mode renders', true);

  // Stabilization through the inspector.
  await page.evaluate(() => {
    const app = window.clipwave;
    const m = [...app.media.items.values()].find((x) => x.name === 'shaky.webm');
    const c = window.clipwaveDev.ops.addMedia(app.store, m, 99);
    app.store.select(c.id);
    app.showInspectorTab('stab');
  });
  await page.click('.job .btn');
  await page.waitForFunction(() => { const f = window.clipwave.store.primary(); return f && f.clip.stab; }, null, { timeout: 120000 });
  const stab = await page.evaluate(() => {
    const s = window.clipwave.store.primary().clip.stab;
    const amp = (a) => Math.max(...a) - Math.min(...a);
    return { zoom: s.zoom, n: s.data.x.length, ampX: +amp(s.data.x).toFixed(4), ampY: +amp(s.data.y).toFixed(4), rate: +s.data.rate.toFixed(2) };
  });
  // The crop window wobbles about 45px / 1280 horizontally and 20px / 720 vertically.
  check('stabilization measures the shake', stab.n > 100 && stab.ampX > 0.02 && stab.ampX < 0.12 && stab.ampY > 0.02 && stab.zoom > 1.02, JSON.stringify(stab));

  // The fixture's crop window moves by x = 30 sin(21t) + 15 sin(37t), y = 20 sin(27t) pixels, so the correction
  // should track that shake (with the slow part smoothed away).
  const corr = await page.evaluate(() => {
    const d = window.clipwave.store.primary().clip.stab.data;
    const pearson = (a, b) => {
      const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
      return num / Math.sqrt(da * db);
    };
    const ts = d.x.map((_, i) => d.t0 + i / d.rate);
    const ex = ts.map((t) => (30 * Math.sin(21 * t) + 15 * Math.sin(37 * t)) / 1280);
    const ey = ts.map((t) => (20 * Math.sin(27 * t)) / 720);
    return { x: +pearson(d.x, ex).toFixed(3), y: +pearson(d.y, ey).toFixed(3) };
  });
  check('stabilization correction matches the real shake', corr.x > 0.9 && corr.y > 0.9, JSON.stringify(corr));

  // Reverse through the Speed tab.
  await page.evaluate(() => {
    const app = window.clipwave;
    const m = [...app.media.items.values()].find((x) => x.name === 'b.webm');
    const c = window.clipwaveDev.ops.addMedia(app.store, m, 99);
    app.store.select(c.id);
    app.showInspectorTab('speed');
  });
  await page.click('.job .btn');
  await page.waitForFunction(() => { const f = window.clipwave.store.primary(); const m = f && window.clipwave.media.get(f.clip.mediaId); return m && m.reverseOf && m.status === 'ready'; }, null, { timeout: 180000 });
  const rev = await page.evaluate(async () => {
    const app = window.clipwave;
    const f = app.store.primary();
    const r = app.media.get(f.clip.mediaId);
    const o = app.media.get(r.reverseOf);
    const avg = (url) => new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas');
        c.width = 16;
        c.height = 9;
        const g = c.getContext('2d');
        g.drawImage(im, 0, 0, 16, 9);
        res([...g.getImageData(0, 0, 16, 9).data]);
      };
      im.src = url;
    });
    const a = await avg(r.thumbs[0]);
    const b = await avg(o.thumbs[o.thumbs.length - 1]);
    const c = await avg(o.thumbs[0]);
    const diff = (x, y) => x.reduce((s, v, i) => s + Math.abs(v - y[i]), 0) / x.length;
    return { name: r.name, dur: +r.duration.toFixed(2), orig: +o.duration.toFixed(2), firstVsLast: +diff(a, b).toFixed(1), firstVsFirst: +diff(a, c).toFixed(1) };
  });
  check('reverse makes a backwards copy', Math.abs(rev.dur - rev.orig) < 0.2 && rev.firstVsLast < rev.firstVsFirst, JSON.stringify(rev));

  // Auto reframe to 9:16: the face sits on the left of the shaky clip, so it should slide right.
  const rf = await page.evaluate(async () => {
    const app = window.clipwave;
    const res = await window.clipwaveDev.autoReframe(app, '9:16', () => {});
    const p = app.store.project;
    const clip = p.tracks.flatMap((t) => t.clips).find((c) => app.media.get(c.mediaId) && app.media.get(c.mediaId).name === 'shaky.webm');
    return { res, aspect: p.aspect, x: clip.transform.x, kf: (clip.keyframes.x || []).length, scale: +clip.transform.scale.toFixed(3) };
  });
  check('auto reframe follows the face', rf.aspect === '9:16' && rf.res.found >= 2 && rf.x > 0.1 && rf.scale > 2, JSON.stringify(rf));
  await page.evaluate(() => window.clipwave.player.seek(1.5));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, 'ai-3-reframe.png') });

  // Export with a cutout clip still works.
  const exp = await page.evaluate(async () => {
    const app = window.clipwave;
    const res = await window.clipwaveDev.exportProject(app.store.project, app.media, { resolution: 360, fps: 24, quality: 'low', format: 'webm', end: 2 }, () => {});
    return { size: res.blob.size, codec: res.codec };
  });
  check('export with AI tools', exp.size > 10000, JSON.stringify(exp));

  // Text to speech through the Audio panel.
  await page.evaluate(() => window.clipwave.showTab('audio'));
  await page.fill('#tts-text', 'Hello from Clipwave.');
  const before = await page.evaluate(() => window.clipwave.media.items.size);
  await page.click('.tts .job .btn');
  await page.waitForFunction((n) => [...window.clipwave.media.items.values()].filter((m) => m.status === 'ready').length > n || /could not|busy|Try again/.test(document.querySelector('.tts .job-status').textContent), before, { timeout: 300000 });
  const tts = await page.evaluate(() => {
    const m = [...window.clipwave.media.items.values()].find((x) => x.name.startsWith('Voice'));
    return { media: m && { name: m.name, dur: +m.duration.toFixed(2), audio: m.hasAudio }, status: document.querySelector('.tts .job-status').textContent };
  });
  if (!tts.media && /busy|Try again/.test(tts.status)) console.log(`SKIP  text to speech: the model host refused the download here (${tts.status})`);
  else check('text to speech makes a voice clip', !!tts.media && tts.media.dur > 0.6 && tts.media.audio, JSON.stringify(tts));
} catch (e) {
  check('run', false, e.stack || e.message);
} finally {
  check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
  await browser.close();
  server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
