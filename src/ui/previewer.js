// Renders small previews of effects, filters and transitions on sample pictures, with the real compositor.

import { Renderer } from '../engine/renderer.js';
import { makeClip, makeTrack } from '../model.js';
import { defaultParams } from '../engine/effects.js';

const W = 192, H = 108;

function sample(kind) {
  const c = document.createElement('canvas');
  c.width = W * 2;
  c.height = H * 2;
  const g = c.getContext('2d');
  const w = c.width, h = c.height;
  if (kind === 'a') {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#2d1b4e');
    sky.addColorStop(0.45, '#ff6f61');
    sky.addColorStop(0.62, '#ffc371');
    sky.addColorStop(1, '#1b1033');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff2c4';
    g.beginPath();
    g.arc(w * 0.66, h * 0.5, h * 0.12, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3b1f4a';
    g.beginPath();
    g.moveTo(0, h * 0.62);
    for (let x = 0; x <= w; x += 8) g.lineTo(x, h * 0.62 - Math.abs(Math.sin(x * 0.018)) * h * 0.2 - Math.sin(x * 0.05) * 6);
    g.lineTo(w, h);
    g.lineTo(0, h);
    g.fill();
    g.fillStyle = '#1a0f26';
    g.beginPath();
    g.moveTo(0, h * 0.72);
    for (let x = 0; x <= w; x += 8) g.lineTo(x, h * 0.74 - Math.abs(Math.sin(x * 0.011 + 1)) * h * 0.12);
    g.lineTo(w, h);
    g.lineTo(0, h);
    g.fill();
    g.strokeStyle = 'rgba(255,220,170,0.6)';
    for (let i = 0; i < 6; i++) {
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(w * 0.58 + i * 3, h * 0.8 + i * 6);
      g.lineTo(w * 0.74 - i * 3, h * 0.8 + i * 6);
      g.stroke();
    }
  } else {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#2f80ed');
    sky.addColorStop(1, '#b6e3ff');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.9)';
    for (const [x, y, r] of [[0.2, 0.25, 0.08], [0.27, 0.22, 0.1], [0.34, 0.26, 0.07], [0.7, 0.18, 0.06], [0.76, 0.15, 0.08]]) {
      g.beginPath();
      g.arc(w * x, h * y, h * r, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#3fa34d';
    g.beginPath();
    g.ellipse(w * 0.3, h * 1.05, w * 0.55, h * 0.45, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#2b7a3b';
    g.beginPath();
    g.ellipse(w * 0.85, h * 1.1, w * 0.5, h * 0.42, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#c0392b';
    g.fillRect(w * 0.6, h * 0.58, w * 0.1, h * 0.14);
    g.fillStyle = '#7f2a1f';
    g.beginPath();
    g.moveTo(w * 0.585, h * 0.58);
    g.lineTo(w * 0.65, h * 0.5);
    g.lineTo(w * 0.715, h * 0.58);
    g.fill();
  }
  return c;
}

export class Previewer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.renderer = new Renderer(this.canvas, { preserveDrawingBuffer: true });
    this.a = sample('a');
    this.b = sample('b');
    this.frames = { get: (clip) => {
      const img = clip.mediaId === 'b' ? this.b : this.a;
      return { image: img, w: img.width, h: img.height };
    } };
  }

  project(clips, effectClip) {
    const main = makeTrack('video', { main: true });
    main.clips = clips;
    const tracks = [main];
    if (effectClip) {
      const fx = makeTrack('effect');
      fx.clips = [effectClip];
      tracks.unshift(fx);
    }
    return { width: W, height: H, fps: 30, background: { type: 'color', color: '#000000' }, tracks, markers: [] };
  }

  draw(target, project, t) {
    try {
      this.renderer.render(project, t, this.frames);
      const ctx = target.getContext('2d');
      ctx.drawImage(this.canvas, 0, 0, target.width, target.height);
    } catch (e) {
      console.warn(e);
    }
  }

  effect(target, def, t = 1.2) {
    const clip = makeClip('image', { id: 'pv', mediaId: 'a', start: 0, duration: 10, effects: [{ id: def.id, params: defaultParams(def), enabled: true }] });
    this.draw(target, this.project([clip]), t);
  }

  filter(target, f) {
    const clip = makeClip('image', { id: 'pv', mediaId: 'a', start: 0, duration: 10, filter: { id: f.id, intensity: 1 } });
    this.draw(target, this.project([clip]), 0.5);
  }

  transition(target, tr, progress = 0.5) {
    const a = makeClip('image', { id: 'pa', mediaId: 'a', start: 0, duration: 1 });
    const b = makeClip('image', { id: 'pb', mediaId: 'b', start: 1, duration: 1, transitionIn: { id: tr.id, duration: 1 } });
    this.draw(target, this.project([a, b]), 0.5 + Math.min(0.999, Math.max(0, progress)));
  }
}

let shared = null;
export const previewer = () => (shared = shared || new Previewer());
export const PREVIEW_W = W;
export const PREVIEW_H = H;
