// Draws text, stickers and shapes into 2D canvases that the compositor uploads as layers.
// Sizes in clip data are pixels at a 1080p frame height and get scaled to the render size.

import { easing } from './animation.js';

export const FONTS = [
  // All from Google Fonts (SIL Open Font License).
  ['Montserrat', '400;700;800;900'],
  ['Poppins', '400;600;800'],
  ['Bebas Neue', '400'],
  ['Anton', '400'],
  ['Oswald', '400;600;700'],
  ['Archivo Black', '400'],
  ['Bangers', '400'],
  ['Luckiest Guy', '400'],
  ['Permanent Marker', '400'],
  ['Pacifico', '400'],
  ['Lobster', '400'],
  ['Dancing Script', '400;700'],
  ['Caveat', '400;700'],
  ['Playfair Display', '400;700;900'],
  ['DM Serif Display', '400'],
  ['Cinzel', '400;700'],
  ['Abril Fatface', '400'],
  ['Righteous', '400'],
  ['Monoton', '400'],
  ['Press Start 2P', '400'],
  ['VT323', '400'],
  ['Orbitron', '400;700;900'],
  ['Audiowide', '400'],
  ['Russo One', '400'],
  ['Rubik Mono One', '400'],
  ['Space Mono', '400;700'],
  ['Nunito', '400;700;900'],
  ['Quicksand', '400;700'],
  ['Comfortaa', '400;700'],
  ['Kanit', '400;700;900'],
  ['Barlow Condensed', '400;700;900'],
  ['Shadows Into Light', '400'],
  ['Satisfy', '400'],
  ['Great Vibes', '400'],
  ['Creepster', '400'],
  ['Fredoka', '400;600;700'],
];

export function googleFontsHref() {
  const fam = FONTS.map(([f, w]) => 'family=' + f.replace(/ /g, '+') + ':wght@' + w).join('&');
  return 'https://fonts.googleapis.com/css2?' + fam + '&display=swap';
}

// ---------- per-letter text animations ----------

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const S = () => ({ dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, op: 1, blur: 0, color: null });
const backOut = easing('backout');
const outE = easing('ease-out');
const inE = easing('ease-in');
const elastic = (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1);
const bounceOut = (x) => {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
};
const hrand = (i, k = 0) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// q runs 0 -> 1 for each letter. For "in" 1 means fully shown; for "out" 1 means gone.
export const TEXT_ANIMS = [
  { id: 'typewriter', name: 'Typewriter', cat: 'in', window: 1, fn: (q) => ({ ...S(), op: q >= 1 ? 1 : 0 }) },
  { id: 'fadeLetters', name: 'Fade Letters', cat: 'in', window: 4, fn: (q) => ({ ...S(), op: q }) },
  { id: 'popLetters', name: 'Pop Letters', cat: 'in', window: 3, fn: (q) => { const k = backOut(q); return { ...S(), sx: k, sy: k, op: clamp01(q * 3) }; } },
  { id: 'riseLetters', name: 'Rise', cat: 'in', window: 4, fn: (q) => { const k = outE(q); return { ...S(), dy: (1 - k) * 0.7, op: q }; } },
  { id: 'dropLetters', name: 'Drop & Bounce', cat: 'in', window: 3, fn: (q) => ({ ...S(), dy: -(1 - bounceOut(q)) * 1.6, op: clamp01(q * 4) }) },
  { id: 'blurLetters', name: 'Blur Letters', cat: 'in', window: 5, fn: (q) => ({ ...S(), blur: (1 - q) * 18, op: q, sx: 1 + (1 - q) * 0.4, sy: 1 + (1 - q) * 0.4 }) },
  { id: 'spinLetters', name: 'Spin Letters', cat: 'in', window: 3, fn: (q) => { const k = outE(q); return { ...S(), rot: (1 - k) * -180, sx: k, sy: k, op: q }; } },
  { id: 'zoomLetters', name: 'Zoom Letters', cat: 'in', window: 3, fn: (q) => { const k = outE(q); return { ...S(), sx: 3 - 2 * k, sy: 3 - 2 * k, op: q }; } },
  { id: 'slideLetters', name: 'Slide Letters', cat: 'in', window: 4, fn: (q) => { const k = outE(q); return { ...S(), dx: (1 - k) * 1.2, op: q }; } },
  { id: 'elasticLetters', name: 'Elastic', cat: 'in', window: 3, fn: (q) => { const k = elastic(q); return { ...S(), sy: k, sx: 0.6 + 0.4 * k, op: clamp01(q * 3) }; } },
  { id: 'flickerLetters', name: 'Flicker On', cat: 'in', window: 6, order: 'random', fn: (q, i) => ({ ...S(), op: q >= 1 ? 1 : hrand(i, Math.floor(q * 12)) < q ? 1 : 0 }) },
  { id: 'glitchLetters', name: 'Glitch In', cat: 'in', window: 4, fn: (q, i) => ({ ...S(), dx: (hrand(i, Math.floor(q * 20)) - 0.5) * (1 - q) * 1.5, dy: (hrand(i + 9, Math.floor(q * 20)) - 0.5) * (1 - q) * 0.6, op: q > 0.1 ? 1 : 0 }) },
  { id: 'wordPop', name: 'Word by Word', cat: 'in', window: 1.5, unit: 'word', fn: (q) => { const k = backOut(q); return { ...S(), sx: k, sy: k, op: clamp01(q * 4) }; } },
  { id: 'randomFade', name: 'Random Fade', cat: 'in', window: 5, order: 'random', fn: (q) => ({ ...S(), op: q }) },
  { id: 'fadeLettersOut', name: 'Fade Letters', cat: 'out', window: 4, fn: (q) => ({ ...S(), op: 1 - q }) },
  { id: 'eraseLetters', name: 'Erase', cat: 'out', window: 1, reverse: true, fn: (q) => ({ ...S(), op: q >= 1 ? 0 : 1 }) },
  { id: 'sinkLetters', name: 'Sink', cat: 'out', window: 4, fn: (q) => { const k = inE(q); return { ...S(), dy: k * 0.8, op: 1 - q }; } },
  { id: 'popLettersOut', name: 'Pop Out', cat: 'out', window: 3, fn: (q) => { const k = 1 - inE(q); return { ...S(), sx: k, sy: k, op: 1 - clamp01((q - 0.6) * 2.5) }; } },
  { id: 'blurLettersOut', name: 'Blur Out', cat: 'out', window: 5, fn: (q) => ({ ...S(), blur: q * 18, op: 1 - q }) },
  { id: 'scatter', name: 'Scatter', cat: 'out', window: 6, order: 'random', fn: (q, i) => { const k = inE(q); return { ...S(), dx: (hrand(i, 1) - 0.5) * 4 * k, dy: (hrand(i, 2) - 0.5) * 4 * k, rot: (hrand(i, 3) - 0.5) * 360 * k, op: 1 - q }; } },
  { id: 'wave', name: 'Wave', cat: 'loop', fn: (t, i, n, period) => ({ ...S(), dy: Math.sin((t / period) * Math.PI * 2 - i * 0.55) * 0.18 }) },
  { id: 'bounceLetters', name: 'Bounce', cat: 'loop', fn: (t, i, n, period) => { const k = ((t / period) * 2 - i * 0.12) % 1; const kk = k < 0 ? k + 1 : k; return { ...S(), dy: -Math.abs(Math.sin(kk * Math.PI)) * 0.25 }; } },
  { id: 'jitter', name: 'Jitter', cat: 'loop', fn: (t, i) => { const f = Math.floor(t * 12); return { ...S(), dx: (hrand(i, f) - 0.5) * 0.08, dy: (hrand(i + 5, f) - 0.5) * 0.08, rot: (hrand(i + 2, f) - 0.5) * 8 }; } },
  { id: 'rainbow', name: 'Rainbow', cat: 'loop', fn: (t, i, n, period) => ({ ...S(), color: `hsl(${((t / period) * 360 + i * 25) % 360}, 90%, 62%)` }) },
  { id: 'pulseLetters', name: 'Pulse', cat: 'loop', fn: (t, i, n, period) => { const k = 1 + Math.max(0, Math.sin((t / period) * Math.PI * 2 - i * 0.4)) * 0.18; return { ...S(), sx: k, sy: k }; } },
  { id: 'flicker', name: 'Flicker', cat: 'loop', fn: (t, i) => ({ ...S(), op: hrand(i, Math.floor(t * 10)) > 0.12 ? 1 : 0.2 }) },
  { id: 'swingLetters', name: 'Swing', cat: 'loop', fn: (t, i, n, period) => ({ ...S(), rot: Math.sin((t / period) * Math.PI * 2 - i * 0.5) * 12 }) },
  { id: 'karaoke', name: 'Karaoke', cat: 'loop', whole: true, fn: (t, i, n, period, text) => ({ ...S(), color: i < (t / period) * n ? text.highlight || '#ffd84d' : null }) },
  { id: 'highlightWord', name: 'Word Highlight', cat: 'loop', whole: true, unit: 'word', fn: (t, i, n, period, text) => { const cur = Math.floor((t / period) * n); return { ...S(), color: i === cur ? text.highlight || '#ffd84d' : null, sx: i === cur ? 1.12 : 1, sy: i === cur ? 1.12 : 1 }; } },
];

export const textAnimById = new Map(TEXT_ANIMS.map((a) => [a.id, a]));

function permutation(n, seed = 7) {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(hrand(i, seed) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- layout ----------

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (s) => (segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s));

export function fontString(t, px) {
  return `${t.italic ? 'italic ' : ''}${t.weight || 700} ${px}px "${t.font || 'Montserrat'}", "Segoe UI", system-ui, sans-serif`;
}

function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const raw of text.split('\n')) {
    if (!maxW || ctx.measureText(raw).width <= maxW) {
      out.push(raw);
      continue;
    }
    const words = raw.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (line && ctx.measureText(test.trimEnd()).width > maxW) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line = test;
    }
    out.push(line.trimEnd());
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexA(hex, a) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const cache = new Map();

// Web fonts load on first use. When one arrives, cached drawings are dropped and the app is told to redraw.
const requested = new Set();
function ensureFont(font) {
  if (typeof document === 'undefined' || !document.fonts || requested.has(font)) return;
  requested.add(font);
  try {
    if (document.fonts.check(font)) return;
  } catch {
    return;
  }
  document.fonts.load(font).then((faces) => {
    if (!faces.length) return;
    cache.clear();
    window.dispatchEvent(new Event('clipwave:fonts'));
  }, () => {});
}

// Waits for every font used by a project (before an export).
export async function loadProjectFonts(project) {
  if (!document.fonts) return;
  const fonts = new Set();
  for (const t of project.tracks) for (const c of t.clips) if (c.text) fonts.add(fontString(c.text, 48));
  await Promise.all([...fonts].map((f) => document.fonts.load(f).catch(() => null)));
  cache.clear();
}

// Renders a text or sticker clip. `scale` converts 1080p reference pixels to render pixels.
// Returns {canvas, w, h} or null for empty text.
export function renderText(clip, local, scale, frameW) {
  const t = clip.text;
  if (!t) return null;
  let content = t.content || '';
  if (t.uppercase) content = content.toUpperCase();
  if (!content.trim()) return null;
  const ta = t.anim || {};
  const animated = (ta.in && ta.in.id) || (ta.out && ta.out.id) || (ta.loop && ta.loop.id);

  const key = animated ? null : JSON.stringify([t, scale, frameW]);
  if (key && cache.has(key)) return cache.get(key);

  const px = Math.max(1, (t.size || 96) * scale);
  const meas = measureCtx();
  meas.font = fontString(t, px);
  ensureFont(fontString(t, 48));
  const ls = (t.letterSpacing || 0) * scale;
  try { meas.letterSpacing = ls + 'px'; } catch { /* older browsers */ }
  const maxW = t.wrap ? t.wrap * frameW : 0;
  const lines = wrapLines(meas, content, maxW);
  const lineH = px * (t.lineHeight || 1.2);
  const widths = lines.map((l) => meas.measureText(l).width);
  const textW = Math.max(1, ...widths);
  const textH = lineH * lines.length;

  const stroke = (t.stroke && t.stroke.width) ? t.stroke.width * scale : 0;
  const sh = t.shadow && t.shadow.enabled ? t.shadow : null;
  const glow = t.glow && t.glow.size ? t.glow.size * scale : 0;
  const bg = t.bg && t.bg.enabled ? t.bg : null;
  const bgPad = bg ? (bg.padding ?? 0.35) * px : 0;
  let pad = Math.ceil(stroke + glow * 2 + bgPad + px * 0.12 + 4);
  if (sh) pad += Math.ceil((sh.blur || 0) * scale + Math.max(Math.abs(sh.x || 0), Math.abs(sh.y || 0)) * scale);
  if (animated) pad += Math.ceil(px * 0.9);
  const W = Math.ceil(textW + pad * 2);
  const H = Math.ceil(textH + pad * 2);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.font = meas.font;
  try { ctx.letterSpacing = ls + 'px'; } catch { /* ignore */ }
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const align = t.align || 'center';
  const lineX = (i) => (align === 'left' ? pad : align === 'right' ? W - pad - widths[i] : (W - widths[i]) / 2);
  const m = meas.measureText('Hg');
  const ascent = m.actualBoundingBoxAscent || px * 0.8;
  const descent = m.actualBoundingBoxDescent || px * 0.2;
  const baseY = (i) => pad + i * lineH + (lineH - (ascent + descent)) / 2 + ascent;

  // background
  if (bg) {
    ctx.fillStyle = hexA(bg.color || '#000000', bg.opacity ?? 0.75);
    const r = (bg.radius ?? 0.25) * px;
    if (bg.mode === 'line') {
      lines.forEach((l, i) => {
        if (!l) return;
        roundRect(ctx, lineX(i) - bgPad, pad + i * lineH - bgPad * 0.35, widths[i] + bgPad * 2, lineH + bgPad * 0.7, r);
        ctx.fill();
      });
    } else {
      const x0 = Math.min(...lines.map((_, i) => lineX(i)));
      roundRect(ctx, x0 - bgPad, pad - bgPad * 0.6, textW + bgPad * 2, textH + bgPad * 1.2, r);
      ctx.fill();
    }
  }

  let fill = t.color || '#ffffff';
  if (t.gradient && t.gradient.enabled) {
    const a = ((t.gradient.angle ?? 90) * Math.PI) / 180;
    const cx = W / 2, cy = H / 2, rx = (Math.cos(a) * textW) / 2, ry = (Math.sin(a) * textH) / 2;
    const g = ctx.createLinearGradient(cx - rx, cy - ry, cx + rx, cy + ry);
    g.addColorStop(0, t.gradient.from || '#ff6ec4');
    g.addColorStop(1, t.gradient.to || '#7873f5');
    fill = g;
  }

  const drawRun = (str, x, y, colorOverride) => {
    if (glow) {
      ctx.save();
      ctx.shadowColor = t.glow.color || '#ffffff';
      ctx.shadowBlur = glow;
      ctx.fillStyle = colorOverride || fill;
      ctx.fillText(str, x, y);
      ctx.fillText(str, x, y);
      ctx.restore();
    }
    if (sh) {
      ctx.save();
      ctx.shadowColor = sh.color || 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = (sh.blur || 0) * scale;
      ctx.shadowOffsetX = (sh.x || 0) * scale;
      ctx.shadowOffsetY = (sh.y || 0) * scale;
      ctx.fillStyle = stroke ? t.stroke.color || '#000' : colorOverride || fill;
      if (stroke) {
        ctx.strokeStyle = t.stroke.color || '#000';
        ctx.lineWidth = stroke * 2;
        ctx.strokeText(str, x, y);
      } else ctx.fillText(str, x, y);
      ctx.restore();
    }
    if (stroke) {
      ctx.strokeStyle = t.stroke.color || '#000';
      ctx.lineWidth = stroke * 2;
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = colorOverride || fill;
    ctx.fillText(str, x, y);
  };

  if (!animated) {
    lines.forEach((l, i) => drawRun(l, lineX(i), baseY(i), null));
    const out = { canvas, w: W, h: H, pad };
    if (cache.size > 200) cache.clear();
    cache.set(key, out);
    return out;
  }

  // Per-letter layout.
  const glyphs = [];
  let wordIndex = 0;
  lines.forEach((l, li) => {
    const gs = graphemes(l);
    let prefix = '';
    let prevSpace = true;
    for (const g of gs) {
      const x = lineX(li) + meas.measureText(prefix).width + (prefix ? 0 : 0);
      const gw = meas.measureText(g).width;
      const isSpace = /\s/.test(g);
      if (!isSpace && prevSpace && glyphs.length) wordIndex++;
      prevSpace = isSpace;
      glyphs.push({ g, x, y: baseY(li), w: gw, word: wordIndex, space: isSpace });
      prefix += g;
    }
    prevSpace = true;
    wordIndex++;
  });
  const visible = glyphs.filter((g) => !g.space);
  const n = visible.length;
  const words = visible.length ? visible[visible.length - 1].word + 1 : 0;
  const dur = clip.duration;
  const states = visible.map(() => S());

  const applyStaggered = (def, p, isOut) => {
    const unitCount = def.unit === 'word' ? words : n;
    const order = def.order === 'random' ? permutation(unitCount) : null;
    const W2 = def.window || 3;
    visible.forEach((gl, k) => {
      let idx = def.unit === 'word' ? gl.word : k;
      if (order) idx = order[idx % order.length];
      if (def.reverse) idx = unitCount - 1 - idx;
      const q = clamp01((p * (unitCount - 1 + W2) - idx) / W2);
      merge(states[k], def.fn(q, idx, unitCount));
    });
    return isOut;
  };

  if (ta.in && ta.in.id) {
    const def = textAnimById.get(ta.in.id);
    const d = Math.min(ta.in.duration || 1, dur);
    if (def && local < d) applyStaggered(def, clamp01(local / d), false);
  }
  if (ta.out && ta.out.id) {
    const def = textAnimById.get(ta.out.id);
    const d = Math.min(ta.out.duration || 1, dur);
    if (def && local > dur - d) applyStaggered(def, clamp01((local - (dur - d)) / d), true);
  }
  if (ta.loop && ta.loop.id) {
    const def = textAnimById.get(ta.loop.id);
    if (def) {
      const period = def.whole ? Math.max(0.1, dur) : Math.max(0.1, ta.loop.duration || 1.2);
      const unitCount = def.unit === 'word' ? words : n;
      visible.forEach((gl, k) => merge(states[k], def.fn(def.whole ? local : local % period, def.unit === 'word' ? gl.word : k, unitCount, period, t)));
    }
  }

  visible.forEach((gl, k) => {
    const s = states[k];
    if (s.op <= 0.001 || s.sx === 0 || s.sy === 0) return;
    ctx.save();
    ctx.globalAlpha = clamp01(s.op);
    const cx = gl.x + gl.w / 2;
    const cy = gl.y - ascent / 2;
    ctx.translate(cx + s.dx * px, cy + s.dy * px);
    ctx.rotate((s.rot * Math.PI) / 180);
    ctx.scale(s.sx, s.sy);
    if (s.blur > 0.3) ctx.filter = `blur(${(s.blur * scale).toFixed(1)}px)`;
    drawRun(gl.g, -gl.w / 2, ascent / 2, s.color);
    ctx.restore();
  });
  return { canvas, w: W, h: H, pad };
}

function merge(a, b) {
  a.dx += b.dx;
  a.dy += b.dy;
  a.sx *= b.sx;
  a.sy *= b.sy;
  a.rot += b.rot;
  a.op *= b.op;
  a.blur += b.blur;
  if (b.color) a.color = b.color;
}

let _meas = null;
function measureCtx() {
  if (!_meas) _meas = document.createElement('canvas').getContext('2d');
  return _meas;
}

export function clearTextCache() {
  cache.clear();
}

// ---------- shapes ----------

export const SHAPES = [
  ['rect', 'Rectangle'],
  ['roundrect', 'Rounded'],
  ['circle', 'Circle'],
  ['triangle', 'Triangle'],
  ['star', 'Star'],
  ['heart', 'Heart'],
  ['arrow', 'Arrow'],
  ['bubble', 'Speech bubble'],
  ['line', 'Line'],
  ['ring', 'Ring'],
];

function shapePath(ctx, kind, x, y, w, h) {
  ctx.beginPath();
  switch (kind) {
    case 'rect':
      ctx.rect(x, y, w, h);
      break;
    case 'roundrect':
      roundRect(ctx, x, y, w, h, Math.min(w, h) * 0.18);
      break;
    case 'circle':
    case 'ring':
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case 'triangle':
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.45 : 1;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const px = x + w / 2 + Math.cos(a) * (w / 2) * r;
        const py = y + h / 2 + Math.sin(a) * (h / 2) * r;
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      }
      ctx.closePath();
      break;
    case 'heart': {
      const cx = x + w / 2;
      ctx.moveTo(cx, y + h * 0.3);
      ctx.bezierCurveTo(cx, y, x, y, x, y + h * 0.32);
      ctx.bezierCurveTo(x, y + h * 0.62, cx, y + h * 0.8, cx, y + h);
      ctx.bezierCurveTo(cx, y + h * 0.8, x + w, y + h * 0.62, x + w, y + h * 0.32);
      ctx.bezierCurveTo(x + w, y, cx, y, cx, y + h * 0.3);
      ctx.closePath();
      break;
    }
    case 'arrow':
      ctx.moveTo(x, y + h * 0.35);
      ctx.lineTo(x + w * 0.6, y + h * 0.35);
      ctx.lineTo(x + w * 0.6, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w * 0.6, y + h);
      ctx.lineTo(x + w * 0.6, y + h * 0.65);
      ctx.lineTo(x, y + h * 0.65);
      ctx.closePath();
      break;
    case 'bubble':
      roundRect(ctx, x, y, w, h * 0.78, Math.min(w, h) * 0.2);
      ctx.moveTo(x + w * 0.22, y + h * 0.7);
      ctx.lineTo(x + w * 0.16, y + h);
      ctx.lineTo(x + w * 0.42, y + h * 0.74);
      ctx.closePath();
      break;
    case 'line':
      ctx.rect(x, y + h * 0.42, w, h * 0.16);
      break;
    default:
      ctx.rect(x, y, w, h);
  }
}

export function renderShape(clip, scale) {
  const s = clip.shape;
  if (!s) return null;
  const key = JSON.stringify([s, scale]);
  if (cache.has(key)) return cache.get(key);
  const w = Math.max(2, (s.w || 400) * scale);
  const h = Math.max(2, (s.h || 400) * scale);
  const sw = (s.strokeWidth || 0) * scale;
  const pad = Math.ceil(sw + 4);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w + pad * 2);
  canvas.height = Math.ceil(h + pad * 2);
  const ctx = canvas.getContext('2d');
  shapePath(ctx, s.kind, pad, pad, w, h);
  if (s.kind === 'ring') {
    ctx.lineWidth = Math.max(sw, Math.min(w, h) * 0.08);
    ctx.strokeStyle = s.fill || '#ffffff';
    ctx.stroke();
  } else {
    if (s.fill && s.fillOn !== false) {
      ctx.fillStyle = hexA(s.fill, s.fillOpacity ?? 1);
      ctx.fill();
    }
    if (sw > 0) {
      ctx.lineWidth = sw;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = s.stroke || '#000000';
      ctx.stroke();
    }
  }
  const out = { canvas, w: canvas.width, h: canvas.height, pad };
  cache.set(key, out);
  return out;
}
