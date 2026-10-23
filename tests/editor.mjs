// Checks the AI editor, auto edits and online search in headless Chromium.
// The Claude loop runs against a scripted stand-in for the API, so no key is needed; search uses the real
// Openverse API (needs internet).
//   npm run build && npm run test:editor

import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const ff = (args) => execSync(['ffmpeg', '-y', '-loglevel', 'error', ...args].map((a) => `'${a}'`).join(' '));
if (!existsSync(join(fx, 'talk.webm'))) ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=9', '-f', 'lavfi', '-i', "aevalsrc=exprs=0.5*sin(2*PI*300*t)*sin(2*PI*3*t)*lt(mod(t\\,3)\\,1.5):d=9", '-c:v', 'libvpx-vp9', '-b:v', '1M', '-c:a', 'libopus', '-shortest', join(fx, 'talk.webm')]);

const server = createServer((req, res) => {
  const path = req.url === '/' ? '/dist/clipwave.html' : decodeURIComponent(req.url.split('?')[0]);
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': { '.html': 'text/html' }[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(0);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(proxy ? [`--proxy-server=${proxy}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [])] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: !!proxy });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => process.env.DEBUG && m.type() !== 'debug' && console.log('[console]', m.text().slice(0, 200)));
page.on('requestfailed', (r) => process.env.DEBUG && console.log('[failed]', r.url().slice(0, 100), r.failure() && r.failure().errorText));

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.clipwave && window.clipwave.timeline, null, { timeout: 20000 });
  await page.evaluate(() => window.clipwave.openProject({ ...JSON.parse(JSON.stringify(window.clipwave.store.project)), id: 'ed', name: 'Editor test', tracks: [{ id: 'm', type: 'video', name: '', muted: false, hidden: false, locked: false, main: true, clips: [] }] }));
  await page.setInputFiles('#import-input-media', [join(fx, 'talk.webm'), join(fx, 'b.webm'), join(fx, 'c.png'), join(fx, 'd.mp3')]);
  await page.waitForFunction(() => [...window.clipwave.media.items.values()].filter((m) => m.status === 'ready').length >= 4, null, { timeout: 30000 });
  await page.waitForFunction(() => { const m = [...window.clipwave.media.items.values()].find((x) => x.name === 'd.mp3'); return m && m.beats; }, null, { timeout: 20000 });

  // Offline AI: remove silences through the chat.
  await page.evaluate(() => {
    const app = window.clipwave;
    const m = [...app.media.items.values()].find((x) => x.name === 'talk.webm');
    const c = window.clipwaveDev.ops.addMedia(app.store, m, 0);
    app.store.select(c.id);
    app.showTab('ai');
  });
  await page.fill('#ai-input', 'remove the silences');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.clipwave.library.ai.running, null, { timeout: 60000 });
  const sil = await page.evaluate(() => {
    const main = window.clipwave.store.project.tracks.find((t) => t.main);
    return { clips: main.clips.length, total: +main.clips.reduce((s, c) => s + c.duration, 0).toFixed(2), reply: window.clipwave.library.ai.log.at(-1).text, undo: window.clipwave.store.undoStack.at(-1).label };
  });
  // 9s with sound in 0-1.5, 3-4.5, 6-7.5: about 4.5s of sound plus padding.
  check('AI editor: remove silences', sil.clips === 3 && sil.total > 4.4 && sil.total < 6, JSON.stringify(sil));
  await page.screenshot({ path: join(outDir, 'ed-1-silences.png') });

  // Cut to the beat with the click track on the audio track.
  await page.evaluate(() => {
    const app = window.clipwave;
    const d = [...app.media.items.values()].find((x) => x.name === 'd.mp3');
    window.clipwaveDev.ops.addMedia(app.store, d, 0);
    for (const n of ['b.webm', 'c.png']) window.clipwaveDev.ops.addMedia(app.store, [...app.media.items.values()].find((x) => x.name === n), 99);
  });
  await page.click('.chip-grid.quick .chip-btn:nth-child(2)');
  await page.waitForFunction(() => !window.clipwave.library.ai.running, null, { timeout: 60000 });
  const beat = await page.evaluate(() => {
    const p = window.clipwave.store.project;
    const main = p.tracks.find((t) => t.main);
    return { clips: main.clips.length, starts: main.clips.slice(0, 5).map((c) => +c.start.toFixed(2)), reply: window.clipwave.library.ai.log.at(-1).text };
  });
  check('AI editor: cut to the beat', beat.clips >= 5, JSON.stringify(beat));

  // Highlight reel
  await page.fill('#ai-input', 'make a 6 second highlight reel');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.clipwave.library.ai.running, null, { timeout: 120000 });
  const hl = await page.evaluate(() => ({ reply: window.clipwave.library.ai.log.at(-1).text, clips: window.clipwave.store.project.tracks.find((t) => t.main).clips.length }));
  check('AI editor: highlight reel', hl.clips >= 2 && /reel/.test(hl.reply), JSON.stringify(hl));

  // One undo step per request.
  const undo = await page.evaluate(() => {
    const s = window.clipwave.store;
    const before = s.project.tracks.find((t) => t.main).clips.length;
    s.undo();
    return { before, after: s.project.tracks.find((t) => t.main).clips.length };
  });
  check('AI edit undoes in one step', undo.after !== undo.before, JSON.stringify(undo));

  // Claude loop against a scripted API: get_project, then add_text, then a final answer.
  const claude = await page.evaluate(async () => {
    localStorage.setItem('clipwave:anthropic-key', 'sk-ant-test-key');
    const calls = [];
    const realFetch = window.fetch;
    let n = 0;
    window.fetch = async (url, init) => {
      if (!String(url).includes('api.anthropic.com')) return realFetch(url, init);
      const body = JSON.parse(init.body);
      const headers = new Headers(init.headers);
      calls.push({ model: body.model, tools: body.tools.length, beta: headers.get('anthropic-beta'), key: headers.get('x-api-key'), fallbacks: body.fallbacks, cached: !!(body.system && body.system[0].cache_control), msgs: body.messages.length, effort: body.output_config && body.output_config.effort, lastRole: body.messages.at(-1).role, lastIsToolResult: Array.isArray(body.messages.at(-1).content) && body.messages.at(-1).content[0].type === 'tool_result' });
      n++;
      const base = { id: 'msg_' + n, type: 'message', role: 'assistant', model: body.model, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
      let msg;
      if (n === 1) msg = { ...base, stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me look at the timeline.' }, { type: 'tool_use', id: 'tu_1', name: 'get_project', input: {} }] };
      else if (n === 2) msg = { ...base, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_2', name: 'add_text', input: { text: 'Hello from Claude', start: 0.5, duration: 2, style: 'Bold Title' } }, { type: 'tool_use', id: 'tu_3', name: 'set_filter', input: { filter_id: 'vivid', clip_id: 'all' } }] };
      else msg = { ...base, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Added a bold title and made the colors pop.' }] };
      return new Response(JSON.stringify(msg), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_' + n } });
    };
    const app = window.clipwave;
    app.library.ai = null;
    app.showTab('ai');
    document.getElementById('ai-input').value = 'add a title and make it colorful';
    document.getElementById('ai-input').dispatchEvent(new Event('input'));
    document.querySelector('.ai-compose .btn.primary').click();
    while (app.library.ai.running) await new Promise((r) => setTimeout(r, 50));
    window.fetch = realFetch;
    const text = app.store.project.tracks.flatMap((t) => t.clips).find((c) => c.text && c.text.content === 'Hello from Claude');
    const filtered = app.store.project.tracks.flatMap((t) => t.clips).filter((c) => c.filter && c.filter.id === 'vivid').length;
    return { calls, text: !!text, filtered, log: app.library.ai.log.map((l) => `${l.role}:${l.status || ''}:${l.text}`), history: app.library.ai.history.length, undo: app.store.undoStack.at(-1).label };
  });
  const c0 = claude.calls[0] || {};
  check('Claude request is well formed', c0.model === 'claude-opus-5-5' && c0.tools >= 25 && c0.cached && c0.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(c0.beta || '') && c0.key === 'sk-ant-test-key' && c0.effort === 'medium', JSON.stringify(c0));
  check('Claude tool loop runs the edit', claude.calls.length === 3 && claude.calls[1].lastIsToolResult && claude.text && claude.filtered >= 1 && claude.history === 6 && claude.undo === 'AI edit', JSON.stringify({ calls: claude.calls.length, text: claude.text, filtered: claude.filtered, history: claude.history, log: claude.log }));
  await page.screenshot({ path: join(outDir, 'ed-2-claude.png') });
  await page.evaluate(() => localStorage.removeItem('clipwave:anthropic-key'));

  // Search: songs list and a photo added through the Openverse full-size copy.
  await page.evaluate(() => window.clipwave.showTab('search'));
  await page.fill('#stock-q', 'piano');
  await page.press('#stock-q', 'Enter');
  await page.waitForFunction(() => !/Searching/.test(document.querySelector('.search-status').textContent) && document.querySelector('.search-status').textContent, null, { timeout: 45000 }).catch(() => {});
  const songs = await page.evaluate(() => ({ status: document.querySelector('.search-status').textContent, rows: document.querySelectorAll('.song-row').length }));
  check('song search', songs.rows > 0, JSON.stringify(songs));
  await page.screenshot({ path: join(outDir, 'ed-3-songs.png') });
  const beforeSong = await page.evaluate(() => window.clipwave.media.items.size);
  await page.click('.song-row .add');
  await page.waitForFunction((n) => window.clipwave.media.items.size > n && [...window.clipwave.media.items.values()].every((m) => m.status !== 'loading'), beforeSong, { timeout: 90000 });
  const song = await page.evaluate(() => {
    const m = [...window.clipwave.media.items.values()].sort((a, b) => b.added - a.added)[0];
    return { name: m.name, type: m.type, dur: m.duration, credit: m.credit && m.credit.attribution.slice(0, 80) };
  });
  check('song search adds a song with its credit', song.type === 'audio' && song.dur > 1 && !!song.credit, JSON.stringify(song));
  await page.click('.seg-btn:nth-child(3)');
  await page.waitForFunction(() => document.querySelectorAll('.photo').length > 0 || (!/Searching/.test(document.querySelector('.search-status').textContent) && document.querySelector('.search-status').textContent), null, { timeout: 45000 });
  const before = await page.evaluate(() => window.clipwave.media.items.size);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(outDir, 'ed-4-photos.png') });
  await page.click('.photo');
  await page.waitForFunction((n) => window.clipwave.media.items.size > n && [...window.clipwave.media.items.values()].every((m) => m.status !== 'loading'), before, { timeout: 60000 });
  const photo = await page.evaluate(() => {
    const m = [...window.clipwave.media.items.values()].sort((a, b) => b.added - a.added)[0];
    return { name: m.name, type: m.type, w: m.width, credit: m.credit && m.credit.attribution.slice(0, 80) };
  });
  check('photo search adds a photo with its credit', photo.type === 'image' && photo.w > 100 && !!photo.credit, JSON.stringify(photo));
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
