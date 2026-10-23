// Auto reframe: changes the canvas shape and keeps each clip's subject in view by following faces
// with position keyframes.

import { Input, BlobSource, ALL_FORMATS, CanvasSink } from 'mediabunny';
import { loadFaces, faceCenter } from './ai.js';
import { ASPECTS } from './model.js';

const SAMPLE_FPS = 4;

function smooth(arr, r) {
  return arr.map((_, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(arr.length - 1, i + r); j++) {
      s += arr[j];
      n++;
    }
    return s / n;
  });
}

// Keeps only the points needed to stay within `eps` of the full curve (Ramer-Douglas-Peucker).
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let worst = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const k = (pts[i].t - a.t) / Math.max(1e-6, b.t - a.t);
    const d = Math.abs(pts[i].v - (a.v + (b.v - a.v) * k));
    if (d > worst) {
      worst = d;
      idx = i;
    }
  }
  if (worst <= eps) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}

// Face positions over the source range a clip uses, as [{t (seconds into the clip), x, y}] (fractions), or [] if none.
async function track(detector, m, clip, onFrame) {
  if (m.type === 'image') {
    const bmp = await createImageBitmap(m.blob);
    const c = document.createElement('canvas');
    const k = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const f = faceCenter(detector, c);
    return f ? [{ t: 0, x: f.x, y: f.y }] : [];
  }
  const input = new Input({ source: new BlobSource(m.blob), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt || !(await vt.canDecode())) return [];
  const sink = new CanvasSink(vt, { width: 480, poolSize: 0 });
  const speed = clip.speed || 1;
  const n = Math.max(1, Math.ceil(clip.duration * SAMPLE_FPS));
  const times = [...Array(n + 1).keys()].map((i) => Math.min(clip.duration, i / SAMPLE_FPS));
  const out = [];
  let i = 0;
  for await (const wc of sink.canvasesAtTimestamps(times.map((t) => (clip.in || 0) + t * speed))) {
    const t = times[i++];
    onFrame && onFrame();
    if (!wc) continue;
    const c = wc.canvas instanceof HTMLCanvasElement ? wc.canvas : toCanvas(wc.canvas);
    const f = faceCenter(detector, c);
    if (f) out.push({ t, x: f.x, y: f.y });
  }
  return out;
}

function toCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

// Runs auto reframe on every video and photo clip and switches the project to `aspect`.
export async function autoReframe(app, aspect, onProgress) {
  const a = ASPECTS.find((x) => x[0] === aspect);
  if (!a) throw new Error('Unknown shape');
  const [, W, H] = a;
  onProgress(0, 'Loading face tracking');
  const detector = await loadFaces();
  const p = app.store.project;
  const jobs = [];
  for (const t of p.tracks) if (t.type === 'video') for (const c of t.clips) if ((c.type === 'video' || c.type === 'image') && app.media.get(c.mediaId)) jobs.push(c.id);
  const totalSamples = jobs.reduce((s, id) => {
    const c = p.tracks.flatMap((t) => t.clips).find((x) => x.id === id);
    return s + (c.type === 'image' ? 1 : Math.ceil(c.duration * SAMPLE_FPS) + 1);
  }, 0);
  let done = 0;
  const results = new Map();
  for (const id of jobs) {
    const clip = app.store.project.tracks.flatMap((t) => t.clips).find((x) => x.id === id);
    const m = app.media.get(clip.mediaId);
    const pts = await track(detector, m, clip, () => onProgress(Math.min(0.99, ++done / Math.max(1, totalSamples)), 'Finding faces'));
    results.set(id, { pts, m });
  }
  let found = 0;
  app.store.commit('Auto reframe', (proj) => {
    proj.aspect = a[0];
    proj.width = W;
    proj.height = H;
    for (const t of proj.tracks) {
      for (const c of t.clips) {
        const r = results.get(c.id);
        if (!r) continue;
        const { pts, m } = r;
        const crop = c.crop || { l: 0, t: 0, r: 0, b: 0 };
        const mw = m.width * (1 - crop.l - crop.r), mh = m.height * (1 - crop.t - crop.b);
        if (!mw || !mh) continue;
        const contain = Math.min(W / mw, H / mh), cover = Math.max(W / mw, H / mh);
        const dw = mw * cover, dh = mh * cover;
        const limX = Math.max(0, (dw - W) / 2 / W), limY = Math.max(0, (dh - H) / 2 / H);
        c.transform.scale = cover / contain;
        c.transform.rotation = 0;
        c.keyframes = c.keyframes || {};
        delete c.keyframes.x;
        delete c.keyframes.y;
        delete c.keyframes.scale;
        if (!pts.length) {
          c.transform.x = 0;
          c.transform.y = 0;
          continue;
        }
        found++;
        // Face position in the cropped picture -> clip offset that puts it in the middle of the frame.
        const toX = (fx) => Math.max(-limX, Math.min(limX, -(((fx - crop.l) / (1 - crop.l - crop.r)) - 0.5) * dw / W));
        const toY = (fy) => Math.max(-limY, Math.min(limY, -(((fy - crop.t) / (1 - crop.t - crop.b)) - 0.45) * dh / H));
        const xs = smooth(pts.map((q) => toX(q.x)), 2);
        const ys = smooth(pts.map((q) => toY(q.y)), 2);
        if (pts.length === 1) {
          c.transform.x = xs[0];
          c.transform.y = ys[0];
          continue;
        }
        const kx = simplify(pts.map((q, i) => ({ t: q.t, v: xs[i] })), 0.004);
        const ky = simplify(pts.map((q, i) => ({ t: q.t, v: ys[i] })), 0.004);
        c.transform.x = kx[0].v;
        c.transform.y = ky[0].v;
        if (limX > 0.001 && kx.length > 1) c.keyframes.x = kx.map((q) => ({ t: +q.t.toFixed(3), v: +q.v.toFixed(4), e: 'inout' }));
        if (limY > 0.001 && ky.length > 1) c.keyframes.y = ky.map((q) => ({ t: +q.t.toFixed(3), v: +q.v.toFixed(4), e: 'inout' }));
      }
    }
  });
  onProgress(1, 'Done');
  return { clips: jobs.length, found };
}
