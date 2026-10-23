// The compositor. Renders one frame of a project at a time into its canvas.
// Tracks are drawn bottom to top; effect tracks apply to everything already drawn below them.

import { GL } from './gl.js';
import * as SH from './shaders.js';
import { effectById, effectSource, effectUniforms, hexToRgb } from './effects.js';
import { transitionById, transitionSource, transitionUniforms } from './transitions.js';
import { gradeFor, IDENTITY_GRADE } from './filters.js';
import { clipAnimStates, transformAt } from './animation.js';
import { renderText, renderShape } from './text.js';
import { transitionInfo, sourceTime, clipEnd } from '../model.js';
import { LUTS, LUT_SHADER } from '../luts.js';
import { computeMatte, matteReady, MATTE_SHADER } from '../ai.js';
import { stabAt } from '../stabilize.js';

const BLEND_INDEX = Object.fromEntries(SH.BLEND_MODES.map(([k], i) => [k, i]));
const MASK_INDEX = Object.fromEntries(SH.MASK_TYPES.map(([k], i) => [k, i]));

// 2D affine matrices as [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x, y) => [1, 0, 0, 1, x, y];
const scaleM = (x, y) => [x, 0, 0, y, 0, 0];
const rotate = (deg) => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
};
const skew = (ax, ay) => [1, Math.tan((ay * Math.PI) / 180), Math.tan((ax * Math.PI) / 180), 1, 0, 0];
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

const ADJUST_KEYS = ['exposure', 'brightness', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint', 'highlights', 'shadows', 'hue', 'fade', 'vignette', 'grain', 'sharpen'];
const hasAdjust = (a) => a && ADJUST_KEYS.some((k) => a[k]);

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.g = new GL(canvas, opts);
    this.tex = new Map(); // clip id -> {t, src}
    this.accum = null;
    this.frameIndex = 0;
    this.lutTex = new Map();
    this.maskTex = new Map();
  }

  // GPU copy of a loaded LUT, made once per renderer.
  lutTexture(id) {
    const lut = LUTS.get(id);
    if (!lut) return null;
    let t = this.lutTex.get(id);
    if (t) return t;
    const gl = this.gl;
    t = this.g.texture();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lut.size * lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    t.w = lut.size * lut.size;
    t.h = lut.size;
    t.n = lut.size;
    this.lutTex.set(id, t);
    return t;
  }

  get gl() {
    return this.g.gl;
  }

  resize(w, h) {
    w = Math.max(2, Math.round(w));
    h = Math.max(2, Math.round(h));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.accum) {
      this.g.release(this.accum[0]);
      this.g.release(this.accum[1]);
      this.accum = null;
    }
  }

  prog(key, src) {
    return this.g.program(key, src);
  }

  // Ping-pong pair for the frame being built.
  swap() {
    this.accum.reverse();
  }

  get cur() {
    return this.accum[0];
  }

  get other() {
    return this.accum[1];
  }

  // project: the project; t: timeline time; frames: { get(clip, srcTime) -> {image, w, h} | null }
  render(project, t, frames) {
    const g = this.g;
    const W = this.canvas.width, H = this.canvas.height;
    this.W = W;
    this.H = H;
    this.ref = Math.min(W, H) / 1080;
    this.project = project;
    this.frames = frames;
    this.t = t;
    this.frameIndex++;
    if (!this.accum) this.accum = [g.acquire(W, H), g.acquire(W, H)];

    this.drawBackground(project, t);

    const tracks = project.tracks;
    for (let i = tracks.length - 1; i >= 0; i--) {
      const track = tracks[i];
      if (track.hidden) continue;
      if (track.type === 'video') this.renderVideoTrack(track, t);
      else if (track.type === 'text') {
        for (const c of track.clips) if (t >= c.start && t < clipEnd(c)) this.drawClip(c, t, this.cur, this.other) && this.swap();
      } else if (track.type === 'effect') {
        for (const c of track.clips) if (t >= c.start && t < clipEnd(c)) this.applyGlobal(c, t);
      }
    }

    // Present
    const copy = this.prog('copy', SH.COPY);
    g.draw(copy, null, { uRect: [1, 1, 0, 0], uDim: 0 }, { uTex: this.cur });
  }

  drawBackground(project, t) {
    const g = this.g;
    const bg = project.background || { type: 'color', color: '#000000' };
    const [r, gg, b] = hexToRgb(bg.color || '#000000');
    g.clear(this.cur, r, gg, b, 1);
    if (bg.type === 'gradient') {
      const fill = this.prog('fill', SH.FILL);
      g.draw(fill, this.cur, { uColor: [...hexToRgb(bg.color), 1], uColor2: [...hexToRgb(bg.color2 || '#000000'), 1], uAngle: ((bg.angle ?? 90) * Math.PI) / 180, uMode: 1 });
      return;
    }
    if (bg.type !== 'blur') return;
    const main = project.tracks.find((tr) => tr.main);
    if (!main) return;
    const clip = main.clips.find((c) => t >= c.start && t < clipEnd(c) && (c.type === 'video' || c.type === 'image'));
    if (!clip) return;
    const src = this.clipSource(clip, t);
    if (!src) return;
    // Cover-fit the frame into a small target, blur it, then stretch it over the background.
    const W = this.W, H = this.H;
    const sw = Math.max(8, Math.round(W / 8)), shh = Math.max(8, Math.round(H / 8));
    const small = g.acquire(sw, shh), small2 = g.acquire(sw, shh);
    const fa = src.w / src.h, ta = W / H;
    const sx = fa > ta ? ta / fa : 1, sy = fa > ta ? 1 : fa / ta;
    const copy = this.prog('copy', SH.COPY);
    g.draw(copy, small, { uRect: [sx, sy, (1 - sx) / 2, (1 - sy) / 2], uDim: 0 }, { uTex: src });
    const blur = this.prog('blur', SH.BLUR);
    const amount = 0.5 + (bg.blur ?? 0.6) * 2.5;
    for (let i = 0; i < 3; i++) {
      g.draw(blur, small2, { uDir: [amount / sw, 0] }, { uTex: small });
      g.draw(blur, small, { uDir: [0, amount / shh] }, { uTex: small2 });
    }
    g.draw(copy, this.cur, { uRect: [1, 1, 0, 0], uDim: 0.15 }, { uTex: small });
    g.release(small);
    g.release(small2);
  }

  renderVideoTrack(track, t) {
    const g = this.g;
    const done = new Set();
    for (const c of track.clips) {
      const info = transitionInfo(track, c);
      if (!info || t < info.start || t >= info.end) continue;
      const def = transitionById.get(info.id);
      const prog = def && this.prog('tr:' + def.id, transitionSource(def));
      if (!prog) continue;
      done.add(info.prev.id);
      done.add(c.id);
      // Each side is the frame so far with one of the two clips drawn on it.
      const W = this.W, H = this.H;
      const fromFb = g.acquire(W, H), toFb = g.acquire(W, H);
      const A = this.drawClip(info.prev, t, this.cur, fromFb) ? fromFb : this.cur;
      const B = this.drawClip(c, t, this.cur, toFb) ? toFb : this.cur;
      const progress = Math.min(1, Math.max(0, (t - info.start) / info.duration));
      g.draw(prog, this.other, transitionUniforms(def, W / H, progress), { from: A, to: B });
      this.swap();
      g.release(fromFb);
      g.release(toFb);
    }
    for (const c of track.clips) {
      if (done.has(c.id)) continue;
      if (t >= c.start && t < clipEnd(c)) if (this.drawClip(c, t, this.cur, this.other)) this.swap();
    }
  }

  // Uploads the clip's raw picture for time t. Returns a texture-like {tex, w, h}.
  clipSource(clip, t) {
    const g = this.g;
    let entry = this.tex.get(clip.id);
    if (!entry) {
      entry = { t: g.texture(), src: null, used: 0 };
      this.tex.set(clip.id, entry);
    }
    entry.used = this.frameIndex;
    if (clip.type === 'video' || clip.type === 'image') {
      const f = this.frames.get(clip, sourceTime(clip, t), t);
      if (!f) return entry.t.w ? entry.t : null;
      if (f.image !== entry.src || f.dynamic) {
        g.upload(entry.t, f.image, f.w, f.h);
        entry.src = f.image;
      }
      return entry.t;
    }
    let r = null;
    const local = t - clip.start;
    if (clip.type === 'text' || clip.type === 'sticker') r = renderText(clip, local, this.ref, this.W);
    else if (clip.type === 'shape') r = renderShape(clip, this.ref);
    if (!r) return null;
    if (r.canvas !== entry.src) {
      g.upload(entry.t, r.canvas, r.w, r.h);
      entry.src = r.canvas;
    }
    return entry.t;
  }

  // Applies background cutout, chroma key, color, effects and animated blur.
  // Returns {tex, w, h, temp} where temp must be released.
  processLayer(clip, src, local, pw, ph, animBlur, raw) {
    const g = this.g;
    let cur = src;
    let temp = null;
    const pass = (prog, uniforms, textures) => {
      const out = g.acquire(pw, ph);
      g.draw(prog, out, uniforms, textures);
      if (temp) g.release(temp);
      temp = out;
      cur = out;
    };
    const cut = clip.cutout;
    if (cut && cut.mode && cut.mode !== 'off' && raw && raw.image) {
      const mk = computeMatte(raw.image, raw.w, raw.h, clip.type === 'image');
      if (mk) {
        const gl = this.gl;
        let mt = this.maskTex.get(clip.id);
        if (!mt) this.maskTex.set(clip.id, (mt = g.texture()));
        gl.bindTexture(gl.TEXTURE_2D, mt.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, mk.w, mk.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, mk.data);
        mt.w = mk.w;
        mt.h = mk.h;
        const crop = raw.crop;
        const thr = cut.threshold ?? 0.5, soft = Math.max(0.01, cut.softness ?? 0.2);
        const uniforms = { uCrop: [crop.l, crop.b, 1 - crop.l - crop.r, 1 - crop.t - crop.b], uLo: thr - soft / 2, uHi: thr + soft / 2, uMode: cut.mode === 'blur' ? 1 : 0 };
        if (cut.mode === 'blur') {
          let blurred = null;
          this.blurInto(cur, (cut.blur ?? 0.5) * 50 * (ph / 1080), pw, ph, (o) => (blurred = o));
          pass(this.prog('matte', MATTE_SHADER), uniforms, { uTex: cur, uMask: mt, uBlurred: blurred });
          g.release(blurred);
        } else pass(this.prog('matte', MATTE_SHADER), uniforms, { uTex: cur, uMask: mt });
      }
    }
    if (clip.chroma && clip.chroma.enabled) {
      const c = clip.chroma;
      pass(this.prog('chroma', SH.CHROMA), { uKey: hexToRgb(c.color), uSimilarity: c.similarity * 0.5, uSmoothness: c.smoothness * 0.5, uSpill: c.spill * 0.5 }, { uTex: cur });
    }
    const grade = gradeFor(clip.filter);
    if (grade || hasAdjust(clip.adjust)) pass(this.prog('color', SH.COLOR), colorUniforms(clip.adjust, grade, pw, ph, local), { uTex: cur });
    const lt = clip.lut && clip.lut.id ? this.lutTexture(clip.lut.id) : null;
    if (lt) pass(this.prog('lut', LUT_SHADER), { uN: lt.n, uMix: clip.lut.intensity ?? 1 }, { uTex: cur, uLut: lt });
    for (const fx of clip.effects || []) {
      if (fx.enabled === false) continue;
      const def = effectById.get(fx.id);
      if (!def) continue;
      if (def.twoPass === 'blur') {
        const r = (fx.params?.radius ?? 0.3) * 40 * (ph / 1080);
        this.blurInto(cur, r, pw, ph, (out) => {
          if (temp) g.release(temp);
          temp = out;
          cur = out;
        });
        continue;
      }
      const prog = this.prog('fx:' + def.id, effectSource(def));
      if (!prog) continue;
      pass(prog, { ...effectUniforms(def, fx.params), uRes: [pw, ph], uTime: local, uProg: clip.duration ? local / clip.duration : 0, uMix: fx.mix ?? 1 }, { uTex: cur });
    }
    if (animBlur > 0.3) {
      this.blurInto(cur, animBlur * (ph / 1080) * 1.5, pw, ph, (out) => {
        if (temp) g.release(temp);
        temp = out;
        cur = out;
      });
    }
    return { tex: cur.tex, w: pw, h: ph, temp };
  }

  // Gaussian blur of radius r pixels (of a pw x ph image). Large radii run on a smaller copy.
  blurInto(src, r, pw, ph, done) {
    const g = this.g;
    const blur = this.prog('blur', SH.BLUR);
    const down = r > 6 ? Math.min(8, r / 4) : 1;
    const bw = Math.max(2, Math.round(pw / down)), bh = Math.max(2, Math.round(ph / down));
    const a = g.acquire(bw, bh), b = g.acquire(bw, bh);
    const copy = this.prog('copy', SH.COPY);
    g.draw(copy, a, { uRect: [1, 1, 0, 0], uDim: 0 }, { uTex: src });
    const rr = r / down;
    const passes = rr > 4 ? 2 : 1;
    const step = rr / (passes * 3.5);
    for (let i = 0; i < passes; i++) {
      g.draw(blur, b, { uDir: [step / bw, 0] }, { uTex: a });
      g.draw(blur, a, { uDir: [0, step / bh] }, { uTex: b });
    }
    g.release(b);
    done(a);
  }

  // Draws a visual clip over `dst` into `out`. Returns false when nothing was drawn.
  drawClip(clip, t, dst, out) {
    const g = this.g;
    const src = this.clipSource(clip, t);
    if (!src || !src.w) return false;
    const local = t - clip.start;
    const W = this.W, H = this.H;
    const isMedia = clip.type === 'video' || clip.type === 'image';

    // Base size on the frame before the clip's own scale.
    const crop = clip.crop || { l: 0, t: 0, r: 0, b: 0 };
    let baseW, baseH;
    if (isMedia) {
      const cw = src.w * Math.max(0.01, 1 - crop.l - crop.r);
      const ch = src.h * Math.max(0.01, 1 - crop.t - crop.b);
      const k = Math.min(W / cw, H / ch);
      baseW = cw * k;
      baseH = ch * k;
    } else {
      baseW = src.w;
      baseH = src.h;
    }

    const states = clipAnimStates(clip, local);
    let animBlur = 0;
    if (states) for (const s of states) animBlur += s.blur || 0;

    // Effects run at the clip's size on the frame (capped by the source size), so they match across resolutions.
    const pw = isMedia ? Math.max(2, Math.min(Math.round(baseW), src.w)) : src.w;
    const ph = isMedia ? Math.max(2, Math.min(Math.round(baseH), src.h)) : src.h;
    const cutout = clip.cutout && clip.cutout.mode && clip.cutout.mode !== 'off' && matteReady();
    const needsProcess = cutout || (clip.chroma && clip.chroma.enabled) || gradeFor(clip.filter) || hasAdjust(clip.adjust) || (clip.lut && clip.lut.id && LUTS.has(clip.lut.id)) || (clip.effects && clip.effects.some((e) => e.enabled !== false)) || animBlur > 0.3;
    let layer = src;
    let temp = null;
    let cropRect = [crop.l, crop.t, 1 - crop.r, 1 - crop.b];
    if (needsProcess) {
      // Processing happens on the cropped picture.
      const cropped = isMedia && (crop.l || crop.t || crop.r || crop.b);
      let input = src;
      let cropTemp = null;
      if (cropped) {
        cropTemp = g.acquire(pw, ph);
        const cw = 1 - crop.l - crop.r, ch = 1 - crop.t - crop.b;
        g.draw(this.prog('copy', SH.COPY), cropTemp, { uRect: [cw, ch, crop.l, crop.b], uDim: 0 }, { uTex: src });
        input = cropTemp;
        cropRect = [0, 0, 1, 1];
      }
      const entry = this.tex.get(clip.id);
      const raw = isMedia && entry ? { image: entry.src, w: src.w, h: src.h, crop: cropped ? crop : { l: 0, t: 0, r: 0, b: 0 } } : null;
      const p = this.processLayer(clip, input, local, pw, ph, animBlur, raw);
      layer = { tex: p.tex, w: p.w, h: p.h };
      temp = p.temp;
      if (cropTemp && cropTemp !== temp) g.release(cropTemp);
    }

    // Transform: frame position -> rotation -> scale/flip -> animation (about its origin) -> base size.
    const tr = transformAt(clip, local);
    let m = translate(W / 2 + tr.x * W, H / 2 + tr.y * H);
    m = mul(m, rotate(tr.rotation));
    m = mul(m, scaleM(tr.scale * (clip.flipH ? -1 : 1), tr.scale * (clip.flipV ? -1 : 1)));
    let opacity = tr.opacity;
    if (states) {
      for (const s of states) {
        const ox = s.ox * baseW, oy = s.oy * baseH;
        let a = translate(ox, oy);
        a = mul(a, translate(s.txE * baseW + s.txP * this.ref, s.tyE * baseH + s.tyP * this.ref));
        a = mul(a, rotate(s.rot));
        a = mul(a, skew(s.skx, s.sky));
        a = mul(a, scaleM(s.sx * Math.cos((s.ry * Math.PI) / 180), s.sy * Math.cos((s.rx * Math.PI) / 180)));
        a = mul(a, translate(-ox, -oy));
        m = mul(m, a);
        opacity *= s.opacity;
      }
    }
    // Stabilization: zoom in a little, then undo the measured shake for this source frame.
    const stab = clip.stab;
    if (stab && stab.enabled && stab.data) {
      const c = stabAt(stab.data, sourceTime(clip, t));
      const z = stab.zoom || 1.1;
      m = mul(m, scaleM(z, z));
      m = mul(m, rotate((c.r * 180) / Math.PI));
      m = mul(m, translate((c.x * baseW) / Math.max(0.01, 1 - crop.l - crop.r), (c.y * baseH) / Math.max(0.01, 1 - crop.t - crop.b)));
    }
    m = mul(m, scaleM(baseW, baseH));
    const inv = invert(m);
    if (!inv || opacity <= 0.001) {
      if (temp) g.release(temp);
      return false;
    }
    const mask = clip.mask || { type: 'none' };
    const prog = this.prog('composite', SH.COMPOSITE);
    g.draw(
      prog,
      out,
      {
        uInv: [inv[0], inv[1], 0, inv[2], inv[3], 0, inv[4], inv[5], 1],
        uCanvas: [W, H],
        uFw: [Math.abs(inv[0]) + Math.abs(inv[2]), Math.abs(inv[1]) + Math.abs(inv[3])],
        uElem: [baseW, baseH],
        uCrop: cropRect,
        uOpacity: Math.max(0, Math.min(1, opacity)),
        uBlend: BLEND_INDEX[clip.blend] || 0,
        uMaskType: MASK_INDEX[mask.type] || 0,
        uMask: [mask.x || 0, mask.y || 0, mask.w ?? 0.6, mask.h ?? 0.6],
        uMaskRot: mask.rotation || 0,
        uMaskFeather: mask.feather ?? 0.02,
        uMaskRound: mask.round || 0,
        uMaskInvert: mask.invert ? 1 : 0,
      },
      { uDst: dst, uSrc: layer },
    );
    if (temp) g.release(temp);
    return true;
  }

  // Effect and filter clips on an effect track change everything drawn below them.
  applyGlobal(clip, t) {
    const g = this.g;
    const local = t - clip.start;
    const W = this.W, H = this.H;
    if (clip.type === 'effect' && clip.effect) {
      const def = effectById.get(clip.effect.id);
      if (!def) return;
      if (def.twoPass === 'blur') {
        const r = (clip.effect.params?.radius ?? 0.3) * 40 * (H / 1080);
        this.blurInto(this.cur, r, W, H, (out) => {
          g.draw(this.prog('copy', SH.COPY), this.other, { uRect: [1, 1, 0, 0], uDim: 0 }, { uTex: out });
          g.release(out);
          this.swap();
        });
        return;
      }
      const prog = this.prog('fx:' + def.id, effectSource(def));
      if (!prog) return;
      g.draw(prog, this.other, { ...effectUniforms(def, clip.effect.params), uRes: [W, H], uTime: local, uProg: local / Math.max(0.001, clip.duration), uMix: clip.effect.mix ?? 1 }, { uTex: this.cur });
      this.swap();
    } else if (clip.type === 'adjust') {
      const grade = gradeFor(clip.filter);
      if (grade || hasAdjust(clip.adjust)) {
        g.draw(this.prog('color', SH.COLOR), this.other, colorUniforms(clip.adjust, grade, W, H, local), { uTex: this.cur });
        this.swap();
      }
      const lt = clip.lut && clip.lut.id ? this.lutTexture(clip.lut.id) : null;
      if (lt) {
        g.draw(this.prog('lut', LUT_SHADER), this.other, { uN: lt.n, uMix: clip.lut.intensity ?? 1 }, { uTex: this.cur, uLut: lt });
        this.swap();
      }
    }
  }

  // Frees textures of clips that were not drawn recently.
  gc() {
    for (const [id, e] of this.tex) {
      if (this.frameIndex - e.used > 120) {
        this.g.deleteTexture(e.t);
        this.tex.delete(id);
      }
    }
  }

  // Reads the current frame back as an ImageBitmap-ready canvas (for snapshots and thumbnails).
  toCanvas() {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    c.getContext('2d').drawImage(this.canvas, 0, 0);
    return c;
  }

  dispose() {
    for (const t of this.lutTex.values()) this.g.deleteTexture(t);
    for (const t of this.maskTex.values()) this.g.deleteTexture(t);
    for (const e of this.tex.values()) this.g.deleteTexture(e.t);
    this.tex.clear();
    this.g.dispose();
  }
}

function colorUniforms(adj = {}, grade, w, h, time) {
  const a = adj || {};
  const G = grade || IDENTITY_GRADE;
  return {
    uRes: [w, h],
    uTime: time,
    uExposure: a.exposure || 0,
    uBrightness: a.brightness || 0,
    uContrast: a.contrast || 0,
    uSaturation: a.saturation || 0,
    uVibrance: a.vibrance || 0,
    uTemperature: a.temperature || 0,
    uTint: a.tint || 0,
    uHighlights: a.highlights || 0,
    uShadows: a.shadows || 0,
    uHue: a.hue || 0,
    uFade: a.fade || 0,
    uVignette: a.vignette || 0,
    uGrain: a.grain || 0,
    uSharpen: a.sharpen || 0,
    uLift: G.lift,
    uGamma: G.gamma,
    uGain: G.gain,
    uShadowTint: G.shadowTint,
    uHighTint: G.highTint,
    uTone: G.tone,
    uGradeSat: G.sat,
    uGradeContrast: G.contrast,
    uGradeFade: G.fade,
    uMono: G.mono,
  };
}
