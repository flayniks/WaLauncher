// Sound effects synthesized on the spot with Web Audio, so there is nothing to license or download.

import { audioBufferToWav } from './engine/exporter.js';

const SR = 48000;

function noiseBuffer(ctx, seconds) {
  const b = ctx.createBuffer(1, Math.ceil(seconds * SR), SR);
  const d = b.getChannelData(0);
  let seed = 1234567;
  for (let i = 0; i < d.length; i++) {
    seed = (seed * 16807) % 2147483647;
    d[i] = (seed / 2147483647) * 2 - 1;
  }
  return b;
}

const RECIPES = {
  whoosh: [0.9, (ctx) => {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 0.9);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, 0);
    f.frequency.exponentialRampToValueAtTime(3500, 0.45);
    f.frequency.exponentialRampToValueAtTime(500, 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, 0);
    g.gain.exponentialRampToValueAtTime(0.9, 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, 0.9);
    n.connect(f).connect(g).connect(ctx.destination);
    n.start(0);
  }],
  pop: [0.25, (ctx) => {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(900, 0);
    o.frequency.exponentialRampToValueAtTime(180, 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, 0);
    g.gain.exponentialRampToValueAtTime(0.0001, 0.2);
    o.connect(g).connect(ctx.destination);
    o.start(0);
  }],
  ding: [1.6, (ctx) => {
    for (const [fr, v] of [[1318.5, 0.5], [2637, 0.18], [3955, 0.08]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = fr;
      const g = ctx.createGain();
      g.gain.setValueAtTime(v, 0);
      g.gain.exponentialRampToValueAtTime(0.0001, 1.5);
      o.connect(g).connect(ctx.destination);
      o.start(0);
    }
  }],
  boom: [1.4, (ctx) => {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(120, 0);
    o.frequency.exponentialRampToValueAtTime(32, 1.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1, 0);
    g.gain.exponentialRampToValueAtTime(0.0001, 1.3);
    o.connect(g).connect(ctx.destination);
    o.start(0);
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 0.5);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.7, 0);
    g2.gain.exponentialRampToValueAtTime(0.0001, 0.45);
    n.connect(f).connect(g2).connect(ctx.destination);
    n.start(0);
  }],
  click: [0.08, (ctx) => {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx, 0.08);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 2500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, 0);
    g.gain.exponentialRampToValueAtTime(0.0001, 0.05);
    n.connect(f).connect(g).connect(ctx.destination);
    n.start(0);
  }],
  shutter: [0.35, (ctx) => {
    for (const at of [0, 0.12]) {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx, 0.1);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 3000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.9, at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
      n.connect(f).connect(g).connect(ctx.destination);
      n.start(at);
    }
  }],
  rise: [2.2, (ctx) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, 0);
    o.frequency.exponentialRampToValueAtTime(1760, 2);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(400, 0);
    f.frequency.exponentialRampToValueAtTime(6000, 2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, 0);
    g.gain.exponentialRampToValueAtTime(0.35, 1.9);
    g.gain.exponentialRampToValueAtTime(0.0001, 2.2);
    o.connect(f).connect(g).connect(ctx.destination);
    o.start(0);
  }],
  glitch: [0.6, (ctx) => {
    for (let i = 0; i < 8; i++) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 200 + ((i * 739) % 1800);
      const g = ctx.createGain();
      const at = i * 0.07;
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.setValueAtTime(0.25, at);
      g.gain.setValueAtTime(0.0001, at + 0.045);
      o.connect(g).connect(ctx.destination);
      o.start(0);
      o.stop(0.6);
    }
  }],
  heartbeat: [1.2, (ctx) => {
    for (const at of [0, 0.28]) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(70, at);
      o.frequency.exponentialRampToValueAtTime(40, at + 0.15);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.setValueAtTime(1, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(0);
    }
  }],
  coin: [0.5, (ctx) => {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(988, 0);
    o.frequency.setValueAtTime(1319, 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, 0);
    g.gain.setValueAtTime(0.25, 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, 0.45);
    o.connect(g).connect(ctx.destination);
    o.start(0);
  }],
};

export const SFX = [
  ['whoosh', 'Whoosh'],
  ['pop', 'Pop'],
  ['ding', 'Ding'],
  ['boom', 'Boom'],
  ['click', 'Click'],
  ['shutter', 'Camera shutter'],
  ['rise', 'Riser'],
  ['glitch', 'Glitch'],
  ['heartbeat', 'Heartbeat'],
  ['coin', 'Coin'],
];

export async function renderSfx(id) {
  const [dur, build] = RECIPES[id];
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * SR), SR);
  build(ctx);
  const buf = await ctx.startRendering();
  return audioBufferToWav(buf);
}
