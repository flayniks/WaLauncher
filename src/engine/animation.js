// Clip animations (in / out / loop) and property keyframes.
// Most presets come from animate.css (MIT), parsed into transform tracks by tools/gen-data.mjs.

import RAW from '../data/animations.js';

// ---------- easing ----------

// Cubic bezier timing function solved with Newton steps and a bisection fallback.
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (x > v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

const easeCache = new Map();
const NAMED = {
  linear: (x) => x,
  ease: bezier(0.25, 0.1, 0.25, 1),
  'ease-in': bezier(0.42, 0, 1, 1),
  'ease-out': bezier(0, 0, 0.58, 1),
  'ease-in-out': bezier(0.42, 0, 0.58, 1),
  in: bezier(0.42, 0, 1, 1),
  out: bezier(0, 0, 0.58, 1),
  inout: bezier(0.42, 0, 0.58, 1),
  hold: (x) => (x < 1 ? 0 : 1),
  backout: bezier(0.34, 1.56, 0.64, 1),
  expoout: bezier(0.16, 1, 0.3, 1),
  smooth: bezier(0.65, 0, 0.35, 1),
};

export function easing(spec) {
  if (!spec) return NAMED.ease;
  if (NAMED[spec]) return NAMED[spec];
  if (easeCache.has(spec)) return easeCache.get(spec);
  const m = /cubic-bezier\(([^)]+)\)/.exec(spec);
  const fn = m ? bezier(...m[1].split(',').map(Number)) : NAMED.ease;
  easeCache.set(spec, fn);
  return fn;
}

// ---------- presets ----------

const T = (o, comps, ease) => [o, comps, ease || null];

// Extra presets in the same shape as the animate.css ones: things a video editor needs that CSS libraries don't have.
const EXTRA = [
  { id: 'blurIn', name: 'Blur In', category: 'in', group: 'Clipwave', duration: 0.6, ease: 'ease-out', origin: [0, 0],
    tracks: { opacity: [[0, 0, null], [1, 1, null]], blur: [[0, 40, null], [1, 0, null]], transform: [T(0, { sx: 1.08, sy: 1.08 }), T(1, {})] } },
  { id: 'blurOut', name: 'Blur Out', category: 'out', group: 'Clipwave', duration: 0.6, ease: 'ease-in', origin: [0, 0],
    tracks: { opacity: [[0, 1, null], [1, 0, null]], blur: [[0, 0, null], [1, 40, null]], transform: [T(0, {}), T(1, { sx: 1.08, sy: 1.08 })] } },
  { id: 'popIn', name: 'Pop', category: 'in', group: 'Clipwave', duration: 0.45, ease: 'backout', origin: [0, 0],
    tracks: { opacity: [[0, 0, null], [0.3, 1, null]], transform: [T(0, { sx: 0, sy: 0 }), T(1, {})] } },
  { id: 'popOut', name: 'Pop Out', category: 'out', group: 'Clipwave', duration: 0.35, ease: 'ease-in', origin: [0, 0],
    tracks: { opacity: [[0.6, 1, null], [1, 0, null]], transform: [T(0, {}, 'ease-out'), T(0.3, { sx: 1.12, sy: 1.12 }, 'ease-in'), T(1, { sx: 0, sy: 0 })] } },
  { id: 'spinIn', name: 'Spin In', category: 'in', group: 'Clipwave', duration: 0.7, ease: 'expoout', origin: [0, 0],
    tracks: { opacity: [[0, 0, null], [0.4, 1, null]], transform: [T(0, { rot: -360, sx: 0.2, sy: 0.2 }), T(1, {})] } },
  { id: 'spinOut', name: 'Spin Out', category: 'out', group: 'Clipwave', duration: 0.7, ease: 'ease-in', origin: [0, 0],
    tracks: { opacity: [[0.6, 1, null], [1, 0, null]], transform: [T(0, {}), T(1, { rot: 360, sx: 0.2, sy: 0.2 })] } },
  { id: 'zoomPunch', name: 'Zoom Punch', category: 'in', group: 'Clipwave', duration: 0.4, ease: 'expoout', origin: [0, 0],
    tracks: { transform: [T(0, { sx: 1.6, sy: 1.6 }), T(1, {})], blur: [[0, 20, null], [0.7, 0, null]] } },
  { id: 'dropIn', name: 'Drop', category: 'in', group: 'Clipwave', duration: 0.8, ease: 'ease', origin: [0, 0.5],
    tracks: { opacity: [[0, 0, null], [0.2, 1, null]], transform: [T(0, { tyP: -900 }, 'ease-in'), T(0.55, { sx: 1.12, sy: 0.85 }, 'ease-out'), T(0.75, { tyP: -60, sx: 0.95, sy: 1.05 }, 'ease-in'), T(1, {})] } },
  { id: 'swingIn', name: 'Swing In', category: 'in', group: 'Clipwave', duration: 0.9, ease: 'ease-out', origin: [0, -0.5],
    tracks: { opacity: [[0, 0, null], [0.3, 1, null]], transform: [T(0, { rot: -70 }), T(0.5, { rot: 18 }), T(0.75, { rot: -8 }), T(1, {})] } },
  { id: 'kenBurnsIn', name: 'Slow Zoom In', category: 'loop', group: 'Clipwave', duration: 6, ease: 'linear', origin: [0, 0], whole: true,
    tracks: { transform: [T(0, {}), T(1, { sx: 1.18, sy: 1.18 })] } },
  { id: 'kenBurnsOut', name: 'Slow Zoom Out', category: 'loop', group: 'Clipwave', duration: 6, ease: 'linear', origin: [0, 0], whole: true,
    tracks: { transform: [T(0, { sx: 1.18, sy: 1.18 }), T(1, {})] } },
  { id: 'panLeft', name: 'Pan Left', category: 'loop', group: 'Clipwave', duration: 6, ease: 'linear', origin: [0, 0], whole: true,
    tracks: { transform: [T(0, { sx: 1.15, sy: 1.15, txE: 0.06 }), T(1, { sx: 1.15, sy: 1.15, txE: -0.06 })] } },
  { id: 'panRight', name: 'Pan Right', category: 'loop', group: 'Clipwave', duration: 6, ease: 'linear', origin: [0, 0], whole: true,
    tracks: { transform: [T(0, { sx: 1.15, sy: 1.15, txE: -0.06 }), T(1, { sx: 1.15, sy: 1.15, txE: 0.06 })] } },
  { id: 'float', name: 'Float', category: 'loop', group: 'Clipwave', duration: 2.4, ease: 'ease-in-out', origin: [0, 0],
    tracks: { transform: [T(0, {}), T(0.5, { tyP: -24 }), T(1, {})] } },
  { id: 'breathe', name: 'Breathe', category: 'loop', group: 'Clipwave', duration: 2, ease: 'ease-in-out', origin: [0, 0],
    tracks: { transform: [T(0, {}), T(0.5, { sx: 1.06, sy: 1.06 }), T(1, {})] } },
  { id: 'spin', name: 'Spin', category: 'loop', group: 'Clipwave', duration: 2, ease: 'linear', origin: [0, 0],
    tracks: { transform: [T(0, {}), T(1, { rot: 360 })] } },
  { id: 'sway', name: 'Sway', category: 'loop', group: 'Clipwave', duration: 2.4, ease: 'ease-in-out', origin: [0, 0],
    tracks: { transform: [T(0, { rot: -6 }), T(0.5, { rot: 6 }), T(1, { rot: -6 })] } },
];

export const ANIMATIONS = [...EXTRA, ...RAW];
export const animById = new Map(ANIMATIONS.map((a) => [a.id, a]));
export const animsFor = (category) => ANIMATIONS.filter((a) => a.category === category);

// Default length in seconds when an animation is first applied. animate.css runs at 1s times its multiplier.
export const defaultAnimDuration = (def) => Math.min(2.5, Math.max(0.3, def.whole ? 3 : def.duration * (def.category === 'loop' ? 1 : 0.8)));

// ---------- evaluation ----------

const TDEF = { txE: 0, txP: 0, tyE: 0, tyP: 0, sx: 1, sy: 1, rot: 0, skx: 0, sky: 0, rx: 0, ry: 0 };
const TKEYS = Object.keys(TDEF);

export function identityState() {
  return { ...TDEF, opacity: 1, blur: 0, ox: 0, oy: 0 };
}

function sampleScalar(track, p, defEase, def) {
  if (!track || !track.length) return def;
  let frames = track;
  if (frames[0][0] > 0) frames = [[0, def, null], ...frames];
  if (frames[frames.length - 1][0] < 1) frames = [...frames, [1, def, null]];
  if (p <= frames[0][0]) return frames[0][1];
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i], b = frames[i + 1];
    if (p <= b[0]) {
      const span = b[0] - a[0];
      const k = span <= 0 ? 1 : easing(a[2] || defEase)((p - a[0]) / span);
      return a[1] + (b[1] - a[1]) * k;
    }
  }
  return frames[frames.length - 1][1];
}

function sampleTransform(track, p, defEase, out) {
  if (!track || !track.length) return;
  let frames = track;
  if (frames[0][0] > 0) frames = [[0, {}, null], ...frames];
  if (frames[frames.length - 1][0] < 1) frames = [...frames, [1, {}, null]];
  let a = frames[0], b = frames[0], k = 0;
  if (p > frames[0][0]) {
    a = b = frames[frames.length - 1];
    for (let i = 0; i < frames.length - 1; i++) {
      if (p <= frames[i + 1][0]) {
        a = frames[i];
        b = frames[i + 1];
        const span = b[0] - a[0];
        k = span <= 0 ? 1 : easing(a[2] || defEase)((p - a[0]) / span);
        break;
      }
    }
  }
  for (const key of TKEYS) {
    const va = a[1][key] ?? TDEF[key];
    const vb = b[1][key] ?? TDEF[key];
    out[key] = va + (vb - va) * k;
  }
}

// One preset at progress p (0..1).
export function evalPreset(def, p) {
  const s = identityState();
  const ease = def.ease || 'ease';
  if (def.tracks.transform) sampleTransform(def.tracks.transform, p, ease, s);
  if (def.tracks.opacity) s.opacity = sampleScalar(def.tracks.opacity, p, ease, 1);
  if (def.tracks.blur) s.blur = sampleScalar(def.tracks.blur, p, ease, 0);
  s.ox = def.origin ? def.origin[0] : 0;
  s.oy = def.origin ? def.origin[1] : 0;
  return s;
}

// Combines the in / out / loop animations of a clip at a time inside it. Returns a list of states,
// each applied about its own origin (outermost first).
export function clipAnimStates(clip, local) {
  const a = clip.anim;
  if (!a) return null;
  const states = [];
  const dur = clip.duration;
  if (a.loop && a.loop.id) {
    const def = animById.get(a.loop.id);
    if (def) {
      const period = Math.max(0.1, a.loop.duration || defaultAnimDuration(def));
      // "whole" loops (slow zoom, pan) stretch over the whole clip instead of repeating.
      const p = def.whole ? Math.min(1, Math.max(0, local / Math.max(dur, 0.01))) : (local % period) / period;
      states.push(evalPreset(def, p));
    }
  }
  if (a.in && a.in.id) {
    const def = animById.get(a.in.id);
    const d = Math.min(a.in.duration || defaultAnimDuration(def || { duration: 1 }), dur);
    if (def && local < d) states.push(evalPreset(def, Math.max(0, local / d)));
  }
  if (a.out && a.out.id) {
    const def = animById.get(a.out.id);
    const d = Math.min(a.out.duration || defaultAnimDuration(def || { duration: 1 }), dur);
    if (def && local > dur - d) states.push(evalPreset(def, Math.min(1, (local - (dur - d)) / d)));
  }
  return states.length ? states : null;
}

// ---------- keyframes ----------

export const KEYFRAME_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'];

// Keyframes are stored per property as [{t, v, e}] with t in seconds from the clip start.
export function keyframeValue(frames, t, fallback) {
  if (!frames || !frames.length) return fallback;
  if (t <= frames[0].t) return frames[0].v;
  const last = frames[frames.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i], b = frames[i + 1];
    if (t <= b.t) {
      const k = easing(a.e || 'linear')((t - a.t) / Math.max(1e-6, b.t - a.t));
      return a.v + (b.v - a.v) * k;
    }
  }
  return last.v;
}

// The clip's transform at a local time, with keyframes applied.
export function transformAt(clip, local) {
  const tr = clip.transform || {};
  const kf = clip.keyframes || {};
  return {
    x: keyframeValue(kf.x, local, tr.x || 0),
    y: keyframeValue(kf.y, local, tr.y || 0),
    scale: keyframeValue(kf.scale, local, tr.scale ?? 1),
    rotation: keyframeValue(kf.rotation, local, tr.rotation || 0),
    opacity: keyframeValue(kf.opacity, local, tr.opacity ?? 1),
  };
}
