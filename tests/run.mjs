// End-to-end check in headless Chromium: loads the built app, compiles every shader, imports media,
// edits a timeline and exports an MP4 that ffprobe can read.
//   npm run build && npm test

import { execSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

// Fixtures
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
if (!existsSync(join(fx, 'a.mp4'))) ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(fx, 'a.mp4')]);
// Open-source Chromium builds have no H.264, so the same clip is also made as VP9 in MP4.
if (!existsSync(join(fx, 'a-vp9.mp4'))) ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libvpx-vp9', '-b:v', '2M', '-c:a', 'libopus', '-shortest', join(fx, 'a-vp9.mp4')]);
if (!existsSync(join(fx, 'b.webm'))) ff(['-f', 'lavfi', '-i', 'mandelbrot=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4', '-t', '4', '-c:v', 'libvpx-vp9', '-b:v', '1M', '-c:a', 'libopus', join(fx, 'b.webm')]);
if (!existsSync(join(fx, 'c.png'))) ff(['-f', 'lavfi', '-i', 'smptehdbars=size=800x600', '-frames:v', '1', join(fx, 'c.png')]);
if (!existsSync(join(fx, 'd.mp3'))) ff(['-f', 'lavfi', '-i', "aevalsrc=exprs='0.5*sin(2*PI*220*t)*lt(mod(t,0.5),0.12)':d=6", '-c:a', 'libmp3lame', join(fx, 'd.mp3')]);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = req.url === '/' ? '/dist/clipwave.html' : decodeURIComponent(req.url.split('?')[0]);
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(0);
const port = server.address().port;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (process.env.DEBUG) console.log('[console]', m.type(), m.text()); });
page.on('framenavigated', (f) => console.log('[navigated]', f.url()));
page.on('crash', () => console.log('[crash]'));

try {
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => window.clipwave && window.clipwave.timeline, null, { timeout: 20000 });
  check('app boots', true);
  await page.screenshot({ path: join(outDir, '1-welcome.png') });

  // Every effect and transition shader compiles.
  const shaderReport = await page.evaluate(() => {
    const g = window.clipwave.renderer.g;
    const d = window.clipwaveDev;
    const bad = [];
    for (const e of d.EFFECTS) if (!g.program('fx:' + e.id, d.effectSource(e))) bad.push('fx:' + e.id);
    for (const t of d.TRANSITIONS) if (!g.program('tr:' + t.id, d.transitionSource(t))) bad.push('tr:' + t.id);
    return { bad, effects: d.EFFECTS.length, transitions: d.TRANSITIONS.length };
  });
  check(`shaders compile (${shaderReport.effects} effects, ${shaderReport.transitions} transitions)`, shaderReport.bad.length === 0, shaderReport.bad.join(', '));

  // Fresh project, import media.
  await page.evaluate(() => window.clipwave.openProject({ ...JSON.parse(JSON.stringify(window.clipwave.store.project)), id: 'test', name: 'Test edit', tracks: [{ id: 'm', type: 'video', name: '', muted: false, hidden: false, locked: false, main: true, clips: [] }], background: { type: 'blur', color: '#000000', blur: 0.6 } }));
  const h264 = await page.evaluate(async () => (await VideoDecoder.isConfigSupported({ codec: 'avc1.64001f' })).supported && (await AudioDecoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 1 })).supported);
  const aFile = h264 ? 'a.mp4' : 'a-vp9.mp4';
  console.log(`      (this browser ${h264 ? 'has' : 'has no'} H.264/AAC; using ${aFile})`);
  await page.setInputFiles('#import-input-media', [join(fx, aFile), join(fx, 'b.webm'), join(fx, 'c.png'), join(fx, 'd.mp3')]);
  await page.waitForFunction(() => [...window.clipwave.media.items.values()].filter((m) => m.status !== 'loading').length >= 4, null, { timeout: 30000 });
  const media = await page.evaluate(() => [...window.clipwave.media.items.values()].map((m) => ({ name: m.name, status: m.status, type: m.type, dur: +m.duration.toFixed(2), w: m.width, h: m.height, thumbs: m.thumbs.length, audio: m.hasAudio })));
  check('media import', media.length === 4 && media.every((m) => m.status === 'ready' && m.dur > 0), JSON.stringify(media));

  // Build an edit through the same operations the UI uses.
  await page.evaluate(async () => {
    const app = window.clipwave;
    const { ops } = window.clipwaveDev;
    const items = [...app.media.items.values()];
    const by = (n) => items.find((m) => m.name === n);
    ops.addMedia(app.store, by('a.mp4') || by('a-vp9.mp4'), 0);
    ops.addMedia(app.store, by('b.webm'), 99);
    ops.addMedia(app.store, by('c.png'), 99);
    ops.addMedia(app.store, by('d.mp3'), 0);
    const main = app.store.project.tracks.find((t) => t.main);
    ops.setTransition(app.store, main.clips[1].id, 'CrossZoom', 0.8);
    ops.setTransition(app.store, main.clips[2].id, 'cube', 0.6);
    app.store.select(main.clips[0].id);
    ops.applyEffectToClip(app.store, main.clips[0].id, 'vhs');
    ops.setClipAnim(app.store, main.clips[2].id, 'loop', 'kenBurnsIn');
    ops.splitAt(app.store, 2.5);
    const t = ops.addText(app.store, 0.5);
    app.store.commit('style', (p) => {
      const tt = p.tracks.flatMap((x) => x.clips).find((c) => c.id === t.id);
      tt.text.content = 'Hello Clipwave';
      tt.text.anim = { in: { id: 'popLetters', duration: 1 }, loop: { id: 'wave', duration: 1.2 } };
      tt.anim = { out: { id: 'fadeOut', duration: 0.5 } };
    });
    ops.addEffectClip(app.store, 'lightleak', 5);
    ops.addFilterClip(app.store, 'teal-orange', 8);
  });
  const proj = await page.evaluate(() => {
    const p = window.clipwave.store.project;
    return { tracks: p.tracks.map((t) => `${t.type}${t.main ? '*' : ''}:${t.clips.length}`), main: p.tracks.find((t) => t.main).clips.map((c) => [c.type, +c.start.toFixed(2), +c.duration.toFixed(2)]) };
  });
  check('timeline edit', proj.main.length === 4 && proj.main[1][1] === 2.5, JSON.stringify(proj));

  // Preview renders and plays.
  await page.evaluate(() => window.clipwave.player.seek(1));
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, '2-editor.png') });
  await page.evaluate(() => window.clipwave.player.seek(4.8));
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, '3-transition.png') });
  await page.evaluate(() => window.clipwave.player.play());
  await page.waitForTimeout(1500);
  const playing = await page.evaluate(() => ({ t: window.clipwave.player.time, playing: window.clipwave.player.playing }));
  await page.evaluate(() => window.clipwave.player.pause());
  check('playback advances', playing.t > 4.8 + 0.8, JSON.stringify(playing));

  // The decoder fallback used when a <video> element can't open a file.
  const dec = await page.evaluate(async () => {
    const app = window.clipwave;
    const p = app.player;
    for (const m of app.media.items.values()) m.elementFailed = true;
    for (const id of [...p.els.keys()]) p.dropElement(id);
    p.seek(1);
    await new Promise((r) => setTimeout(r, 1500));
    const centerPixel = () => {
      app.renderer.render(app.store.project, p.time, p.frames);
      const gl = app.renderer.gl;
      const px = new Uint8Array(4);
      gl.readPixels(gl.drawingBufferWidth >> 1, gl.drawingBufferHeight >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [...px];
    };
    const still = centerPixel();
    const modes = [...p.els.values()].map((e) => e.mode || 'element');
    p.play();
    await new Promise((r) => setTimeout(r, 1200));
    const shown = [...p.els.values()].filter((e) => e.dec).map((e) => e.dec.shown);
    p.pause();
    for (const m of app.media.items.values()) m.elementFailed = false;
    for (const id of [...p.els.keys()]) p.dropElement(id);
    return { still, modes, shown };
  });
  check('decoder fallback shows and plays frames', dec.modes.includes('decoder') && dec.still.slice(0, 3).some((v) => v > 20) && dec.shown.some((s) => s > 1.3), JSON.stringify(dec));

  // Undo / redo
  const undo = await page.evaluate(() => {
    const s = window.clipwave.store;
    const n = s.undoStack.length;
    s.undo();
    const a = s.undoStack.length;
    s.redo();
    return [n, a, s.undoStack.length];
  });
  check('undo and redo', undo[1] === undo[0] - 1 && undo[2] === undo[0], JSON.stringify(undo));

  // Library panels render.
  for (const tab of ['audio', 'text', 'stickers', 'effects', 'transitions', 'filters', 'templates', 'captions', 'media']) {
    await page.evaluate((t) => window.clipwave.showTab(t), tab);
    await page.waitForTimeout(tab === 'effects' || tab === 'transitions' ? 900 : 150);
    if (tab === 'effects' || tab === 'text') await page.screenshot({ path: join(outDir, `4-${tab}.png`) });
  }
  check('library panels', true);

  // Real pointer and keyboard interaction.
  const clipBox = (pred) => page.evaluate((src) => {
    const app = window.clipwave;
    const tl = app.timeline;
    const fn = new Function('c', 't', 'return ' + src);
    const rows = tl.rows();
    for (const r of rows) for (const c of r.track.clips) if (fn(c, r.track)) {
      const cr = tl.canvas.getBoundingClientRect();
      const x = cr.left + tl.timeToX(c.start) - tl.scroller.scrollLeft;
      const y = cr.top + r.y - tl.scroller.scrollTop;
      return { id: c.id, x, y, w: c.duration * tl.pps, h: r.h, duration: c.duration };
    }
    return null;
  }, pred.toString().replace(/^\(c, t\) => /, ''));
  await page.evaluate(() => { window.clipwave.timeline.fit(); window.clipwave.player.seek(0.2); });
  await page.waitForTimeout(200);
  let box = await clipBox((c, t) => t.main && c.type === 'video');
  await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
  const selected = await page.evaluate(() => window.clipwave.store.selection[0]);
  check('click selects a clip', selected === box.id);
  const tabs = await page.$$eval('.insp-tabs button', (bs) => bs.map((b) => b.textContent));
  for (let i = 0; i < tabs.length; i++) {
    await page.click(`.insp-tabs button:nth-child(${i + 1})`);
    await page.waitForTimeout(60);
  }
  check('inspector tabs for video', tabs.length >= 6, tabs.join(', '));
  // Hover an animation chip so its preview runs, then apply one.
  await page.click('.insp-tabs button:nth-child(2)');
  await page.hover('.anim-chip:nth-child(5)');
  await page.click('.anim-chip:nth-child(5)');
  const animOk = await page.evaluate((id) => !!window.clipwave.store.project.tracks.flatMap((t) => t.clips).find((c) => c.id === id).anim.in, box.id);
  check('apply animation from inspector', animOk);
  // Load a .cube LUT (an inverting 2x2x2 cube) from the Adjust tab.
  const cube = join(fx, 'invert.cube');
  writeFileSync(cube, 'TITLE "invert"\nLUT_3D_SIZE 2\n' + [0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${1 - r} ${1 - g} ${1 - b}`))).join('\n') + '\n');
  await page.click('.insp-tabs button:nth-child(3)');
  await page.setInputFiles('#lut-input', cube);
  await page.waitForFunction((id) => { const c = window.clipwave.store.project.tracks.flatMap((t) => t.clips).find((x) => x.id === id); return c.lut && c.lut.id; }, box.id, { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, '4b-lut.png') });
  check('load a .cube LUT', true);
  // Trim the right edge.
  box = await clipBox((c, t) => t.main && c.type === 'video');
  await page.mouse.move(box.x + box.w - 3, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w - 40, box.y + box.h / 2, { steps: 6 });
  await page.mouse.up();
  const trimmed = await page.evaluate((id) => window.clipwave.store.project.tracks.flatMap((t) => t.clips).find((c) => c.id === id).duration, box.id);
  check('trim by dragging the edge', trimmed < box.duration - 0.05, `${box.duration.toFixed(2)}s -> ${trimmed.toFixed(2)}s`);
  // Keyboard split + undo.
  const before = await page.evaluate(() => window.clipwave.store.project.tracks.find((t) => t.main).clips.length);
  await page.evaluate(() => window.clipwave.player.seek(1.2));
  await page.mouse.click(box.x + 20, box.y + box.h / 2);
  await page.keyboard.press('s');
  const afterSplit = await page.evaluate(() => window.clipwave.store.project.tracks.find((t) => t.main).clips.length);
  await page.keyboard.press('Control+z');
  const afterUndo = await page.evaluate(() => window.clipwave.store.project.tracks.find((t) => t.main).clips.length);
  check('S splits, Ctrl+Z undoes', afterSplit === before + 1 && afterUndo === before, `${before} -> ${afterSplit} -> ${afterUndo}`);
  // Context menu.
  await page.mouse.click(box.x + 30, box.y + box.h / 2, { button: 'right' });
  const menuItems = await page.$$eval('.ctx-menu button', (bs) => bs.length);
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 300);
  check('right-click menu', menuItems > 5, menuItems + ' items');
  // Text: select it, move it on the preview with the handle box.
  await page.evaluate(() => window.clipwave.player.seek(2));
  await page.waitForTimeout(200);
  const tbox = await clipBox((c) => c.type === 'text');
  await page.mouse.click(tbox.x + 10, tbox.y + tbox.h / 2);
  await page.waitForTimeout(100);
  for (let i = 0; i < 6; i++) {
    const b = await page.$(`.insp-tabs button:nth-child(${i + 1})`);
    if (b) { await b.click(); await page.waitForTimeout(60); }
  }
  const stage = await page.$eval('.pv-stage', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const x0 = await page.evaluate((id) => window.clipwave.store.project.tracks.flatMap((t) => t.clips).find((c) => c.id === id).transform.x, tbox.id);
  await page.mouse.move(stage.x + stage.w / 2, stage.y + stage.h / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.w / 2 + 120, stage.y + stage.h / 2 + 30, { steps: 8 });
  await page.mouse.up();
  const x1 = await page.evaluate((id) => window.clipwave.store.project.tracks.flatMap((t) => t.clips).find((c) => c.id === id).transform.x, tbox.id);
  check('drag text on the preview', x1 > x0 + 0.05, `x ${x0.toFixed(3)} -> ${x1.toFixed(3)}`);
  await page.screenshot({ path: join(outDir, '5-text-selected.png') });
  // Typing into a slider readout.
  await page.click('.insp-tabs button:nth-child(5)');
  const numField = await page.$('.slider-row .num');
  await numField.fill('50%');
  await numField.press('Enter');
  check('type a value into a readout', true);
  // Sound effect from the Audio panel.
  const nMedia = await page.evaluate(() => window.clipwave.media.items.size);
  await page.evaluate(() => window.clipwave.showTab('audio'));
  await page.click('.chip-btn');
  await page.waitForFunction((n) => window.clipwave.media.items.size > n, nMedia, { timeout: 10000 });
  check('generated sound effect', true);
  // Export dialog opens from the button.
  await page.click('.export-btn');
  const dlg = await page.$('.modal');
  await page.screenshot({ path: join(outDir, '6-export-dialog.png') });
  await page.click('.modal footer .btn:not(.primary)');
  check('export dialog', !!dlg);
  // Effects on hover animate; transitions apply to a cut from the panel.
  await page.evaluate(() => window.clipwave.showTab('transitions'));
  await page.waitForTimeout(800);
  await page.hover('.tile-grid .tile:nth-child(3)');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, '7-transitions.png') });

  // Export
  const exp = await page.evaluate(async () => {
    const app = window.clipwave;
    const t0 = performance.now();
    let last = 0;
    const res = await window.clipwaveDev.exportProject(app.store.project, app.media, { resolution: 480, fps: 30, quality: 'medium', format: 'mp4' }, (f, msg) => { if (f - last > 0.1 || msg !== 'Rendering') { last = f; console.log('export', msg, f.toFixed(2)); } });
    const buf = new Uint8Array(await res.blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { b64: btoa(s), ext: res.ext, codec: res.codec, audio: res.audioCodec, size: buf.length, secs: (performance.now() - t0) / 1000, w: res.width, h: res.height };
  });
  const file = join(outDir, 'export.' + exp.ext);
  writeFileSync(file, Buffer.from(exp.b64, 'base64'));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  const dur = +probe.format.duration;
  const expected = await page.evaluate(() => {
    const p = window.clipwave.store.project;
    return p.tracks.reduce((m, t) => Math.max(m, t.clips.reduce((mm, c) => Math.max(mm, c.start + c.duration), 0)), 0);
  });
  check(`export ${exp.ext} (${exp.codec}${exp.audio ? '+' + exp.audio : ''}, ${(exp.size / 1e6).toFixed(2)} MB in ${exp.secs.toFixed(1)}s)`, !!v && !!a && Math.abs(dur - expected) < 0.25 && v.width === exp.w, `video ${v && v.codec_name} ${v && v.width}x${v && v.height}, audio ${a && a.codec_name}, ${dur.toFixed(2)}s of ${expected.toFixed(2)}s`);
  // Pull frames to look at.
  for (const [i, t] of [[1, 1.0], [2, 4.6], [3, 9]]) {
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', join(outDir, `export-frame-${i}.png`)]);
    } catch {
      /* ignore */
    }
  }
  // Template flow and phone layout.
  await page.evaluate(() => window.clipwave.showTab('templates'));
  await page.click('.tpl-card');
  await page.click('.modal footer .btn.primary');
  await page.waitForTimeout(500);
  const tpl = await page.evaluate(() => ({ name: window.clipwave.store.project.name, clips: window.clipwave.store.project.tracks.reduce((n, t) => n + t.clips.length, 0) }));
  check('project template', tpl.clips >= 4, JSON.stringify(tpl));
  await page.evaluate(() => window.clipwave.player.seek(0.8));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, '8-template.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, '9-phone.png') });
  await page.evaluate(() => window.clipwave.toggleDrawer('lib'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, '10-phone-library.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('phone layout has no sideways scroll', !overflow);
} catch (e) {
  check('run', false, e.stack || e.message);
} finally {
  const real = errors.filter((e) => !/favicon|fonts\.g/.test(e));
  check('no page errors', real.length === 0, real.slice(0, 5).join(' | '));
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
