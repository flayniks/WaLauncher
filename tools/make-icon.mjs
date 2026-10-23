// Renders the app icon (build/icon.png, 1024px) from the Clipwave logo. electron-builder makes the .ico from it.
//   node tools/make-icon.mjs

import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pw;
try {
  pw = await import('playwright');
} catch {
  const g = execSync('npm root -g').toString().trim();
  pw = await import(pathToFileURL(join(g, 'playwright', 'index.mjs')).href);
}

const S = 1024;
const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:${S}px;height:${S}px;display:grid;place-items:center">
  <div style="position:relative;width:${S * 0.86}px;height:${S * 0.86}px;border-radius:${S * 0.2}px;background:linear-gradient(160deg,#1d2128,#0f1114);box-shadow:inset 0 0 0 ${S * 0.008}px rgba(255,255,255,.08);display:grid;place-items:center">
    <div style="width:${S * 0.58}px;height:${S * 0.58}px;border-radius:${S * 0.15}px;background:conic-gradient(from 210deg,#f2b33d,#ff7a59,#b75cff,#4fd1c5,#f2b33d);
      -webkit-mask:radial-gradient(circle at 50% 50%,transparent ${S * 0.105}px,#000 ${S * 0.11}px)"></div>
    <svg viewBox="0 0 100 100" style="position:absolute;width:${S * 0.15}px;height:${S * 0.15}px;left:calc(50% - ${S * 0.065}px);top:calc(50% - ${S * 0.075}px)"><path d="M18 8 L92 50 L18 92 Z" fill="#fff" stroke="#fff" stroke-width="10" stroke-linejoin="round"/></svg>
  </div>
</div></body></html>`;

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: S, height: S } });
await page.setContent(html);
mkdirSync(join(root, 'build'), { recursive: true });
await page.screenshot({ path: join(root, 'build/icon.png'), omitBackground: true });
await browser.close();
console.log('wrote build/icon.png');
