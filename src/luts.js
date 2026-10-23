// 3D color lookup tables loaded from .cube files (the format Resolve, Premiere and most free LUT packs use).

import { db } from './db.js';
import { uid } from './model.js';

export const LUTS = new Map(); // id -> {id, name, size, data: Uint8Array (RGBA, width size*size, height size)}
const listeners = new Set();
export const onLutsChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn());

export function parseCube(text) {
  let size = 0;
  let min = [0, 0, 0], max = [1, 1, 1];
  const values = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === 'LUT_3D_SIZE') size = parseInt(parts[1], 10);
    else if (key === 'DOMAIN_MIN') min = parts.slice(1, 4).map(Number);
    else if (key === 'DOMAIN_MAX') max = parts.slice(1, 4).map(Number);
    else if (key === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported. Use a 3D .cube file.');
    else if (/^[-\d.]/.test(parts[0]) && parts.length >= 3) values.push(+parts[0], +parts[1], +parts[2]);
  }
  if (!size || values.length < size * size * size * 3) throw new Error('This .cube file is incomplete.');
  // Lay the cube out as `size` slices side by side: x = r + b * size, y = g.
  const data = new Uint8Array(size * size * size * 4);
  const norm = (v, i) => Math.max(0, Math.min(255, Math.round(((v - min[i]) / ((max[i] - min[i]) || 1)) * 255)));
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const src = (r + g * size + b * size * size) * 3;
        const dst = (g * size * size + b * size + r) * 4;
        data[dst] = norm(values[src], 0);
        data[dst + 1] = norm(values[src + 1], 1);
        data[dst + 2] = norm(values[src + 2], 2);
        data[dst + 3] = 255;
      }
  return { size, data };
}

export async function importLut(file) {
  const { size, data } = parseCube(await file.text());
  const lut = { id: uid(), name: file.name.replace(/\.cube$/i, ''), size, data };
  LUTS.set(lut.id, lut);
  await db.put('luts', lut);
  emit();
  return lut;
}

export async function loadLuts() {
  const rows = (await db.all('luts')) || [];
  for (const r of rows) if (r && r.data) LUTS.set(r.id, r);
  emit();
}

export async function removeLut(id) {
  LUTS.delete(id);
  await db.del('luts', id);
  emit();
}

export const LUT_SHADER = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uLut;
uniform float uN;
uniform float uMix;
vec3 lookup(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float b = c.b * (uN - 1.0);
  float b0 = floor(b);
  float b1 = min(b0 + 1.0, uN - 1.0);
  float y = (c.g * (uN - 1.0) + 0.5) / uN;
  float x = c.r * (uN - 1.0) + 0.5;
  vec3 s0 = texture2D(uLut, vec2((b0 * uN + x) / (uN * uN), y)).rgb;
  vec3 s1 = texture2D(uLut, vec2((b1 * uN + x) / (uN * uN), y)).rgb;
  return mix(s0, s1, b - b0);
}
void main() {
  vec4 s = texture2D(uTex, vUv);
  gl_FragColor = vec4(mix(s.rgb, lookup(s.rgb), uMix), s.a);
}`;
