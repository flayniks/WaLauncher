// Project data model: tracks, clips and the queries the editor and renderer share.
// Times are in seconds. Positions are fractions of the frame, measured from its center.

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);

export const ASPECTS = [
  ['16:9', 1920, 1080, 'YouTube'],
  ['9:16', 1080, 1920, 'TikTok, Reels, Shorts'],
  ['1:1', 1080, 1080, 'Square post'],
  ['4:5', 1080, 1350, 'Instagram feed'],
  ['4:3', 1440, 1080, 'Classic'],
  ['21:9', 2560, 1080, 'Cinema'],
  ['3:4', 1080, 1440, 'Portrait'],
];

export function newProject(name = 'Untitled project', aspect = '16:9') {
  const a = ASPECTS.find((x) => x[0] === aspect) || ASPECTS[0];
  return {
    version: 1,
    id: uid(),
    name,
    aspect: a[0],
    width: a[1],
    height: a[2],
    fps: 30,
    background: { type: 'color', color: '#000000', blur: 0.6 },
    magnet: true,
    tracks: [makeTrack('video', { main: true, name: 'Main' })],
    markers: [],
    created: Date.now(),
    updated: Date.now(),
  };
}

export function makeTrack(type, extra = {}) {
  return { id: uid(), type, name: '', muted: false, hidden: false, locked: false, main: false, clips: [], ...extra };
}

export const VISUAL_TYPES = new Set(['video', 'image', 'text', 'sticker', 'shape']);
export const AUDIBLE_TYPES = new Set(['video', 'audio']);

// Which track type a clip type lives on.
export const trackTypeFor = (clipType) =>
  clipType === 'audio' ? 'audio' : clipType === 'text' || clipType === 'sticker' || clipType === 'shape' ? 'text' : clipType === 'effect' || clipType === 'adjust' ? 'effect' : 'video';

const baseVisual = () => ({
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  flipH: false,
  flipV: false,
  blend: 'normal',
  adjust: {},
  filter: null,
  effects: [],
  anim: {},
  keyframes: {},
  mask: { type: 'none', x: 0, y: 0, w: 0.6, h: 0.6, rotation: 0, feather: 0.02, round: 0, invert: false },
});

export const DEFAULT_TEXT = {
  content: 'Your text',
  font: 'Montserrat',
  weight: 800,
  italic: false,
  size: 110,
  color: '#ffffff',
  align: 'center',
  letterSpacing: 0,
  lineHeight: 1.15,
  uppercase: false,
  wrap: 0.86,
  stroke: { width: 0, color: '#000000' },
  shadow: { enabled: true, color: 'rgba(0,0,0,0.55)', blur: 12, x: 0, y: 5 },
  glow: { size: 0, color: '#ffffff' },
  bg: { enabled: false, color: '#000000', opacity: 0.7, padding: 0.35, radius: 0.25, mode: 'box' },
  gradient: { enabled: false, from: '#ff6ec4', to: '#7873f5', angle: 0 },
  highlight: '#ffd84d',
  anim: {},
};

export function makeClip(type, props = {}) {
  const base = { id: uid(), type, start: 0, duration: 3, name: '' };
  let c;
  switch (type) {
    case 'video':
      c = { ...base, ...baseVisual(), mediaId: null, in: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, muted: false, chroma: chromaDefaults(), crop: { l: 0, t: 0, r: 0, b: 0 }, transitionIn: null };
      break;
    case 'image':
      c = { ...base, ...baseVisual(), mediaId: null, in: 0, speed: 1, chroma: chromaDefaults(), crop: { l: 0, t: 0, r: 0, b: 0 }, transitionIn: null };
      break;
    case 'audio':
      c = { ...base, mediaId: null, in: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, muted: false };
      break;
    case 'text':
    case 'sticker':
      c = { ...base, ...baseVisual(), text: structuredClone(DEFAULT_TEXT) };
      if (type === 'sticker') Object.assign(c.text, { content: '🔥', size: 240, shadow: { ...DEFAULT_TEXT.shadow, enabled: false } });
      break;
    case 'shape':
      c = { ...base, ...baseVisual(), shape: { kind: 'roundrect', fill: '#ffd84d', fillOpacity: 1, stroke: '#000000', strokeWidth: 0, w: 420, h: 260 } };
      break;
    case 'effect':
      c = { ...base, effect: { id: 'glitch', params: {} } };
      break;
    case 'adjust':
      c = { ...base, filter: { id: 'teal-orange', intensity: 0.8 }, adjust: {} };
      break;
    default:
      c = { ...base };
  }
  return Object.assign(c, props);
}

export function chromaDefaults() {
  return { enabled: false, color: '#00ff00', similarity: 0.12, smoothness: 0.08, spill: 0.1 };
}

export const clipEnd = (c) => c.start + c.duration;
export const trackEnd = (t) => t.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
export const projectDuration = (p) => p.tracks.reduce((m, t) => Math.max(m, trackEnd(t)), 0);

export function sortClips(track) {
  track.clips.sort((a, b) => a.start - b.start);
}

export function findClip(project, id) {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { clip: track.clips[index], track, index };
  }
  return null;
}

export const mainTrack = (p) => p.tracks.find((t) => t.main);

// Source time inside the media for a timeline time.
export const sourceTime = (clip, t) => (clip.in || 0) + (t - clip.start) * (clip.speed || 1);

// The transition at the start of `clip`, if its previous neighbour touches it.
export function transitionInfo(track, clip) {
  const tr = clip.transitionIn;
  if (!tr || !tr.id) return null;
  const i = track.clips.indexOf(clip);
  const prev = i > 0 ? track.clips[i - 1] : null;
  if (!prev || Math.abs(clipEnd(prev) - clip.start) > 0.02) return null;
  const d = Math.min(tr.duration || 0.6, prev.duration, clip.duration);
  return { prev, clip, start: clip.start - d / 2, end: clip.start + d / 2, duration: d, id: tr.id };
}

// Packs the main track left to right with no gaps (CapCut's "magnetic" main track).
export function packMain(project) {
  const m = mainTrack(project);
  if (!m || !project.magnet) return;
  sortClips(m);
  let t = 0;
  for (const c of m.clips) {
    c.start = t;
    t += c.duration;
  }
}

// Snapshot helpers for undo.
export const snapshot = (p) => JSON.stringify(p);
export const restore = (s) => JSON.parse(s);

export function clipLabel(c, media) {
  if (c.name) return c.name;
  if (c.type === 'text') return c.text.content.split('\n')[0] || 'Text';
  if (c.type === 'sticker') return 'Sticker ' + c.text.content;
  if (c.type === 'shape') return 'Shape';
  if (c.type === 'effect') return c.effect.id;
  if (c.type === 'adjust') return 'Filter';
  const m = media && media.get(c.mediaId);
  return m ? m.name : c.type;
}

export function fmtTime(t, fps = 30, withFrames = false) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t - Math.floor(t)) * fps + 1e-6);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const base = (h ? h + ':' : '') + mm + ':' + ss;
  return withFrames ? base + ':' + String(f).padStart(2, '0') : base;
}
