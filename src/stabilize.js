// Video stabilization. Frames are decoded small, camera motion between neighbours is measured by block matching
// in four regions (giving shift and roll), the path is smoothed, and the difference is stored as a per-frame
// correction that the renderer applies.

import { Input, BlobSource, ALL_FORMATS, CanvasSink } from 'mediabunny';

const AW = 320; // analysis width in pixels

function gray(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
  return { g, w, h };
}

function half(f) {
  const w = f.w >> 1, h = f.h >> 1;
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * 2 * f.w + x * 2;
      g[y * w + x] = (f.g[i] + f.g[i + 1] + f.g[i + f.w] + f.g[i + f.w + 1]) * 0.25;
    }
  return { g, w, h };
}

// Mean absolute difference of a block in `a` at (bx, by) against `b` shifted by (dx, dy).
function sad(a, b, bx, by, bw, bh, dx, dy, step = 2) {
  let s = 0;
  for (let y = by; y < by + bh; y += step) {
    const ra = y * a.w, rb = (y + dy) * b.w + dx;
    for (let x = bx; x < bx + bw; x += step) s += Math.abs(a.g[ra + x] - b.g[rb + x]);
  }
  return s;
}

// Shift (dx, dy) so that cur(x + dx, y + dy) matches prev(x, y) inside a block, coarse to fine, with sub-pixel refinement.
function blockShift(prevL, curL, prevS, curS, bx, by, bw, bh) {
  // Coarse level (half size), wide search.
  const R = 8;
  let best = { s: Infinity, x: 0, y: 0 };
  const cbx = bx >> 1, cby = by >> 1, cbw = bw >> 1, cbh = bh >> 1;
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      if (cbx + dx < 0 || cby + dy < 0 || cbx + cbw + dx >= prevS.w || cby + cbh + dy >= prevS.h) continue;
      const s = sad(prevS, curS, cbx, cby, cbw, cbh, dx, dy);
      if (s < best.s) best = { s, x: dx, y: dy };
    }
  // Fine level around the coarse answer.
  const fx = best.x * 2, fy = best.y * 2;
  best = { s: Infinity, x: fx, y: fy };
  const grid = new Map();
  for (let dy = fy - 2; dy <= fy + 2; dy++)
    for (let dx = fx - 2; dx <= fx + 2; dx++) {
      if (bx + dx < 0 || by + dy < 0 || bx + bw + dx >= prevL.w || by + bh + dy >= prevL.h) continue;
      const s = sad(prevL, curL, bx, by, bw, bh, dx, dy, 1);
      grid.set(dx + ',' + dy, s);
      if (s < best.s) best = { s, x: dx, y: dy };
    }
  // Parabola through the neighbours for sub-pixel accuracy.
  const sub = (a, c, b) => {
    const d = a - 2 * c + b;
    return d > 1e-6 ? Math.max(-0.5, Math.min(0.5, (a - b) / (2 * d))) : 0;
  };
  const at = (x, y) => grid.get(x + ',' + y);
  const l = at(best.x - 1, best.y), r = at(best.x + 1, best.y), u = at(best.x, best.y - 1), d = at(best.x, best.y + 1);
  return {
    x: best.x + (l !== undefined && r !== undefined ? sub(l, best.s, r) : 0),
    y: best.y + (u !== undefined && d !== undefined ? sub(u, best.s, d) : 0),
  };
}

// Camera motion between two frames: content shift (dx, dy) in pixels and roll (radians).
function motion(prev, cur) {
  const prevS = half(prev), curS = half(cur);
  const w = prev.w, h = prev.h;
  const bw = Math.round(w * 0.3), bh = Math.round(h * 0.3);
  const blocks = [
    [w * 0.12, h * 0.12], [w * 0.58, h * 0.12],
    [w * 0.12, h * 0.58], [w * 0.58, h * 0.58],
  ].map(([x, y]) => [Math.round(x), Math.round(y)]);
  const vs = blocks.map(([x, y]) => ({ ...blockShift(prev, cur, prevS, curS, x, y, bw, bh), cx: x + bw / 2 - w / 2, cy: y + bh / 2 - h / 2 }));
  const tx = vs.reduce((s, v) => s + v.x, 0) / vs.length;
  const ty = vs.reduce((s, v) => s + v.y, 0) / vs.length;
  // Small rotation: v - t ~= theta * (-cy, cx)
  let num = 0, den = 0;
  for (const v of vs) {
    num += -v.cy * (v.x - tx) + v.cx * (v.y - ty);
    den += v.cx * v.cx + v.cy * v.cy;
  }
  return { x: tx, y: ty, r: den ? num / den : 0 };
}

function smooth(arr, sigma) {
  if (sigma < 0.5) return arr.slice();
  const r = Math.ceil(sigma * 3);
  const k = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, ws = 0;
    for (let j = -r; j <= r; j++) {
      const idx = Math.min(arr.length - 1, Math.max(0, i + j));
      s += arr[idx] * k[j + r];
      ws += k[j + r];
    }
    out[i] = s / ws;
  }
  return out;
}

// Measures shake over the part of the media a clip uses. strength 0..1 sets how smooth the result is.
export async function analyzeShake(blob, from, to, strength, onProgress, signal) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt || !(await vt.canDecode())) throw new Error('This browser cannot decode that video, so it cannot be stabilized.');
  const sink = new CanvasSink(vt, { width: AW, poolSize: 0 });
  const times = [];
  const traj = { x: [0], y: [0], r: [0] };
  let prev = null;
  let width = AW, height = 0;
  for await (const wc of sink.canvases(from, to)) {
    if (signal && signal.aborted) throw new DOMException('Canceled', 'AbortError');
    const f = gray(wc.canvas);
    width = f.w;
    height = f.h;
    if (prev) {
      const mv = motion(prev, f);
      const n = traj.x.length;
      traj.x.push(traj.x[n - 1] + mv.x);
      traj.y.push(traj.y[n - 1] + mv.y);
      traj.r.push(traj.r[n - 1] + mv.r);
    }
    times.push(wc.timestamp);
    prev = f;
    if (onProgress && times.length % 10 === 0) onProgress(Math.min(0.99, (wc.timestamp - from) / Math.max(0.01, to - from)));
  }
  if (times.length < 3) throw new Error('The clip is too short to stabilize.');
  const fps = (times.length - 1) / Math.max(0.01, times[times.length - 1] - times[0]);
  const sigma = (0.25 + strength * 1.5) * fps;
  const sx = smooth(traj.x, sigma), sy = smooth(traj.y, sigma), sr = smooth(traj.r, sigma);
  const round = (v) => Math.round(v * 1e5) / 1e5;
  const x = [], y = [], r = [];
  let maxShift = 0, maxRoll = 0;
  for (let i = 0; i < times.length; i++) {
    const cx = (sx[i] - traj.x[i]) / width, cy = (sy[i] - traj.y[i]) / height, cr = sr[i] - traj.r[i];
    x.push(round(cx));
    y.push(round(cy));
    r.push(round(cr));
    maxShift = Math.max(maxShift, Math.abs(cx), Math.abs(cy));
    maxRoll = Math.max(maxRoll, Math.abs(cr));
  }
  // Enough zoom to keep the frame covered at the largest correction.
  const zoom = Math.min(1.5, Math.max(1.02, 1 + 2 * maxShift + 1.2 * Math.sin(maxRoll) + 0.01));
  onProgress && onProgress(1);
  return { data: { t0: times[0], rate: fps, x, y, r }, zoom: Math.round(zoom * 1000) / 1000, maxShift, maxRoll };
}

// Correction at a source time: {x, y} as fractions of the picture size and r in radians.
export function stabAt(data, st) {
  const n = data.x.length;
  if (!n) return { x: 0, y: 0, r: 0 };
  const f = (st - data.t0) * data.rate;
  if (f <= 0) return { x: data.x[0], y: data.y[0], r: data.r[0] };
  if (f >= n - 1) return { x: data.x[n - 1], y: data.y[n - 1], r: data.r[n - 1] };
  const i = Math.floor(f), k = f - i;
  return {
    x: data.x[i] + (data.x[i + 1] - data.x[i]) * k,
    y: data.y[i] + (data.y[i + 1] - data.y[i]) * k,
    r: data.r[i] + (data.r[i + 1] - data.r[i]) * k,
  };
}
