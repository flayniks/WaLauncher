// Checks the desktop app: launches Electron (on Linux run it under xvfb-run), then checks the page origin, native
// downloads, saving, an MP4 export and that projects survive a restart.
//   node tools/build.mjs && xvfb-run -a node tests/desktop.mjs
// Set CLIPWAVE_EXE to a packaged app (for example release/linux-unpacked/clipwave) to check the build instead.

import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = join(root, 'tests/.fixtures');
const outDir = join(root, 'tests/.out');
mkdirSync(outDir, { recursive: true });

let pw;
try {
  pw = await import('playwright');
} catch {
  const g = execSync('npm root -g').toString().trim();
  pw = await import(pathToFileURL(join(g, 'playwright', 'index.mjs')).href);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const userData = join(tmpdir(), 'clipwave-desktop-test');
rmSync(userData, { recursive: true, force: true });
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const packaged = process.env.CLIPWAVE_EXE;
const launch = () => pw._electron.launch({
  executablePath: packaged || join(root, 'node_modules/electron/dist/electron'),
  args: [
    '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--user-data-dir=${userData}`,
    ...(proxy ? [`--proxy-server=${proxy}`, '--ignore-certificate-errors'] : []),
    ...(packaged ? [] : [root]),
  ],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});

const errors = [];
let electronApp = await launch();
try {
  let page = await electronApp.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => window.clipwave && window.clipwave.timeline, null, { timeout: 30000 });
  const info = await page.evaluate(() => ({ href: location.href, desktop: !!window.clipwaveDesktop, platform: window.clipwaveDesktop && window.clipwaveDesktop.platform, title: document.title, webgl: !!document.createElement('canvas').getContext('webgl2'), node: typeof window.require }));
  check('opens the editor from clipwave://app', info.href === 'clipwave://app/' && info.desktop && /Clipwave$/.test(info.title) && info.webgl, JSON.stringify(info));
  check('page has no Node access', info.node === 'undefined');
  await page.screenshot({ path: join(outDir, 'desktop-1.png') });

  // A host without cross-origin headers: blocked for a web page, fine through the app.
  const net = await page.evaluate(async () => {
    const r = await window.clipwaveDesktop.fetch('https://example.com/');
    let web = 'ok';
    try {
      await fetch('https://example.com/');
    } catch {
      web = 'blocked';
    }
    const bad = await window.clipwaveDesktop.fetch('file:///etc/passwd');
    return { ok: r.ok, status: r.status, html: /Example Domain/.test(new TextDecoder().decode(r.data)), web, bad: bad.ok };
  });
  check('downloads work from any host', net.ok && net.html && net.web === 'blocked' && net.bad === false, JSON.stringify(net));

  // Song search and add, through the app's downloader.
  await page.evaluate(() => window.clipwave.showTab('search'));
  await page.fill('#stock-q', 'guitar');
  await page.press('#stock-q', 'Enter');
  await page.waitForSelector('.song-row', { timeout: 45000 });
  const before = await page.evaluate(() => window.clipwave.media.items.size);
  await page.click('.song-row .add');
  await page.waitForFunction((n) => window.clipwave.media.items.size > n && [...window.clipwave.media.items.values()].every((m) => m.status !== 'loading'), before, { timeout: 120000 });
  const song = await page.evaluate(() => {
    const m = [...window.clipwave.media.items.values()].sort((a, b) => b.added - a.added)[0];
    return { name: m.name, type: m.type, dur: m.duration, credit: !!m.credit };
  });
  check('song search adds a song', song.type === 'audio' && song.dur > 1 && song.credit, JSON.stringify(song));

  // H.264 video decodes in the app (Electron ships the codecs a plain Chromium lacks).
  const mp4 = join(fx, 'a.mp4');
  if (existsSync(mp4)) {
    await page.evaluate(() => window.clipwave.showTab('media'));
    await page.setInputFiles('#import-input-media', [mp4]);
    await page.waitForFunction(() => [...window.clipwave.media.items.values()].some((m) => m.name === 'a.mp4' && m.status !== 'loading'), null, { timeout: 30000 });
    const vid = await page.evaluate(() => { const m = [...window.clipwave.media.items.values()].find((x) => x.name === 'a.mp4'); return { status: m.status, w: m.width, dur: m.duration }; });
    check('imports H.264 MP4', vid.status === 'ready' && vid.w > 0, JSON.stringify(vid));
  }

  // Export an MP4 and save it with the native dialog (stubbed to a fixed path).
  const target = join(outDir, 'desktop-export.mp4');
  rmSync(target, { force: true });
  await electronApp.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, target);
  const exp = await page.evaluate(async () => {
    const app = window.clipwave;
    const p = app.store.project;
    const res = await window.clipwaveDev.exportProject(p, app.media, { resolution: 480, fps: 30, quality: 'medium', format: 'mp4', end: 3 }, () => {});
    await app.saveFile(res.blob, 'test.mp4');
    return { codec: res.codec, audio: res.audioCodec, size: res.blob.size };
  });
  const saved = existsSync(target) ? statSync(target).size : 0;
  check(`exports MP4 (${exp.codec}${exp.audio ? '+' + exp.audio : ''}) and saves it`, saved === exp.size && saved > 1000, JSON.stringify({ ...exp, saved }));

  // Projects persist across restarts.
  const id = await page.evaluate(async () => {
    const app = window.clipwave;
    app.store.commit('Rename', (p) => (p.name = 'Desktop keep'));
    await app.store.save();
    return app.store.project.id;
  });
  await electronApp.close();
  electronApp = await launch();
  page = await electronApp.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => window.clipwave && window.clipwave.timeline, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({ id: window.clipwave.store.project.id, name: window.clipwave.store.project.name }));
  check('project is still there after a restart', after.id === id && after.name === 'Desktop keep', JSON.stringify(after));
  await page.screenshot({ path: join(outDir, 'desktop-2.png') });
} catch (e) {
  check('run', false, e.stack || e.message);
} finally {
  check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
  await electronApp.close().catch(() => {});
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
