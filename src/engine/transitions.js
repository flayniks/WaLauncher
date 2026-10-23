// Wraps the gl-transitions collection (https://gl-transitions.com, MIT) for the compositor.

import { HEADER } from './shaders.js';
import RAW from '../data/transitions.js';

// A few hand-picked favourites float to the top of the list; the rest follow alphabetically.
const FEATURED = [
  'fade', 'fadecolor', 'CrossZoom', 'Directional', 'wipeLeft', 'wipeUp', 'SimpleZoom', 'Dreamy', 'GlitchMemories',
  'cube', 'circleopen', 'Swirl', 'ripple', 'pixelize', 'doorway', 'LinearBlur', 'DefocusBlur', 'FilmBurn', 'Radial', 'heart',
];

const featuredRank = new Map(FEATURED.map((id, i) => [id, i]));

export const TRANSITIONS = RAW.slice().sort((a, b) => {
  const ra = featuredRank.has(a.id) ? featuredRank.get(a.id) : 1000;
  const rb = featuredRank.has(b.id) ? featuredRank.get(b.id) : 1000;
  return ra - rb || a.name.localeCompare(b.name);
});

export const transitionById = new Map(TRANSITIONS.map((t) => [t.id, t]));

const PRETTY = { fade: 'Mix', fadecolor: 'Dip to Black', CrossZoom: 'Cross Zoom', wipeLeft: 'Wipe Left', wipeUp: 'Wipe Up', circleopen: 'Circle Open' };
export const transitionName = (t) => PRETTY[t.id] || t.name;

export function transitionSource(t) {
  return (
    HEADER +
    `
uniform sampler2D from, to;
uniform float progress;
uniform float ratio;
vec4 getFromColor(vec2 uv) { return texture2D(from, uv); }
vec4 getToColor(vec2 uv) { return texture2D(to, uv); }
` +
    t.glsl +
    `
void main() { gl_FragColor = transition(vUv); }`
  );
}

export function transitionUniforms(t, ratio, progress) {
  const u = { progress, ratio };
  for (const k in t.defaultParams) {
    const v = t.defaultParams[k];
    u[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  return u;
}
