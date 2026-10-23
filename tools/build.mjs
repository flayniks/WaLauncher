// Bundles the editor into one self-contained HTML file: dist/clipwave.html.
// Also writes dist/clipwave.body.html, the same page without the outer document tags, for hosts that add their own.
//   node tools/build.mjs           build once
//   node tools/build.mjs --watch   rebuild on change

import * as esbuild from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const watch = process.argv.includes('--watch');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const UI_FONTS = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap';

function page(js, css, full) {
  const head = `<title>Clipwave</title>
<meta name="description" content="Clipwave: a free video editor with effects, transitions, keyframes, captions and MP4 export, running in your browser.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${UI_FONTS}">
<style>${css}</style>`;
  const body = `<div id="app"></div>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`;
  if (!full) return `${head}\n${body}\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1114">
<!-- Clipwave ${pkg.version}. Built from https://github.com/flayniks/WaLauncher -->
${head}
</head>
<body>
${body}
</body>
</html>
`;
}

const writeHtml = {
  name: 'write-html',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      const files = result.outputFiles || [];
      const js = files.find((f) => f.path.endsWith('.js'));
      const css = files.find((f) => f.path.endsWith('.css'));
      if (!js) return;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'clipwave.html'), page(js.text, css ? css.text : '', true));
      writeFileSync(join(out, 'clipwave.body.html'), page(js.text, css ? css.text : '', false));
      const kb = Math.round((js.text.length + (css ? css.text.length : 0)) / 1024);
      console.log(`built dist/clipwave.html (${kb} KB)`);
    });
  },
};

const options = {
  entryPoints: [join(root, 'src/main.js')],
  bundle: true,
  format: 'iife',
  target: ['chrome110', 'firefox115', 'safari16.4'],
  minify: !watch,
  sourcemap: false,
  write: false,
  outdir: out,
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [writeHtml],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching src/ …');
} else {
  await esbuild.build(options);
}
