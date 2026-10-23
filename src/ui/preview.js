// Center panel: the player canvas, transport controls and on-canvas handles to move, scale and rotate clips.

import { h, icon, iconButton, toast } from './dom.js';
import { fmtTime, projectDuration, clipEnd, findClip } from '../model.js';
import { transformAt } from '../engine/animation.js';
import { renderText, renderShape } from '../engine/text.js';

const VISUAL = new Set(['video', 'image', 'text', 'sticker', 'shape']);

export class Preview {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.store = app.store;
    this.player = app.player;
    this.quality = 'auto';
    this.canvas = app.renderer.canvas;
    this.canvas.classList.add('pv-canvas');
    this.overlay = h('div', { class: 'pv-overlay' });
    this.guides = h('div', { class: 'pv-guides' }, h('i', { class: 'gv' }), h('i', { class: 'gh' }));
    this.stage = h('div', { class: 'pv-stage' }, this.canvas, this.guides, this.overlay);
    this.wrap = h('div', { class: 'pv-wrap' }, this.stage);
    this.timeEl = h('span', { class: 'tc pv-time' });
    this.playBtn = iconButton('play', 'Play (Space)', () => this.player.toggle(), { class: 'play', size: 20 });
    this.loopBtn = iconButton('loop', 'Loop playback', () => { this.player.loop = !this.player.loop; this.loopBtn.classList.toggle('on', this.player.loop); }, { class: 'toggle' });
    const vol = h('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: 1, id: 'pv-volume', 'aria-label': 'Preview volume', oninput: () => this.player.setVolume(+vol.value) });
    const quality = h('select', { id: 'pv-quality', 'aria-label': 'Preview quality', onchange: () => { this.quality = quality.value; this.resize(); } },
      h('option', { value: 'auto' }, 'Auto'), h('option', { value: 'full' }, 'Full'), h('option', { value: 'half' }, 'Half'), h('option', { value: 'quarter' }, 'Quarter'));
    this.controls = h('div', { class: 'pv-controls' },
      h('div', { class: 'pv-left' }, this.timeEl),
      h('div', { class: 'pv-center' },
        iconButton('prev', 'Previous cut (↑)', () => app.jumpCut(-1)),
        iconButton('chevronLeft', 'Back one frame (←)', () => app.step(-1)),
        this.playBtn,
        iconButton('chevronRight', 'Forward one frame (→)', () => app.step(1)),
        iconButton('next', 'Next cut (↓)', () => app.jumpCut(1)),
      ),
      h('div', { class: 'pv-right' }, this.loopBtn, icon('volume', 16), vol, quality,
        iconButton('camera', 'Save this frame as PNG', () => this.snapshot()),
        iconButton('fullscreen', 'Full screen', () => this.fullscreen())),
    );
    root.append(this.wrap, this.controls);
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.player.addEventListener('time', () => this.onTime());
    this.player.addEventListener('state', () => this.updatePlay());
    this.store.addEventListener('change', () => { this.resize(); this.player.invalidate(); this.updateGizmo(); });
    this.store.addEventListener('project', () => { this.resize(); this.player.invalidate(); this.updateGizmo(); });
    this.store.addEventListener('selection', () => this.updateGizmo());
    this.stage.addEventListener('pointerdown', (e) => this.onDown(e));
    this.stage.addEventListener('dblclick', (e) => this.onDouble(e));
    this.resize();
    this.onTime();
  }

  resize() {
    const p = this.store.project;
    const r = this.wrap.getBoundingClientRect();
    const pad = 16;
    const aw = Math.max(40, r.width - pad * 2), ah = Math.max(40, r.height - pad * 2);
    const ar = p.width / p.height;
    let w = aw, hh = aw / ar;
    if (hh > ah) {
      hh = ah;
      w = ah * ar;
    }
    this.cssW = w;
    this.cssH = hh;
    this.stage.style.width = w + 'px';
    this.stage.style.height = hh + 'px';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let scale = { auto: dpr, full: dpr * 1.5, half: 0.5, quarter: 0.25 }[this.quality] || 1;
    let iw = Math.round(w * scale), ih = Math.round(hh * scale);
    const cap = this.quality === 'full' ? 1 : Math.min(1, 1920 / Math.max(iw, ih));
    iw = Math.min(p.width, Math.round(iw * cap));
    ih = Math.min(p.height, Math.round(ih * cap));
    if (iw / ih > ar + 0.01 || iw / ih < ar - 0.01) ih = Math.round(iw / ar);
    this.app.renderer.resize(iw, ih);
    this.player.invalidate();
    this.updateGizmo();
  }

  onTime() {
    const p = this.store.project;
    this.timeEl.innerHTML = '';
    this.timeEl.append(h('b', null, fmtTime(this.player.time, p.fps, true)), ' / ', fmtTime(projectDuration(p), p.fps, true));
    if (!this.drag) this.updateGizmo();
  }

  updatePlay() {
    const playing = this.player.playing;
    this.playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 20));
    this.playBtn.title = playing ? 'Pause (Space)' : 'Play (Space)';
  }

  // Frame-space geometry (project pixels) of a clip at time t, ignoring in/out animation.
  geometry(clip, t) {
    const p = this.store.project;
    const W = p.width, H = p.height;
    let bw = 0, bh = 0;
    if (clip.type === 'video' || clip.type === 'image') {
      const m = this.app.media.get(clip.mediaId);
      if (!m || !m.width) return null;
      const crop = clip.crop || { l: 0, t: 0, r: 0, b: 0 };
      const cw = m.width * (1 - crop.l - crop.r), ch = m.height * (1 - crop.t - crop.b);
      const k = Math.min(W / cw, H / ch);
      bw = cw * k;
      bh = ch * k;
    } else if (clip.type === 'text' || clip.type === 'sticker') {
      const r = renderText({ ...clip, text: { ...clip.text, anim: {} } }, 0, Math.min(W, H) / 1080, W);
      if (!r) return null;
      bw = r.w - r.pad * 2;
      bh = r.h - r.pad * 2;
    } else if (clip.type === 'shape') {
      const r = renderShape(clip, Math.min(W, H) / 1080);
      bw = r.w;
      bh = r.h;
    } else return null;
    const tr = transformAt(clip, Math.max(0, Math.min(clip.duration, t - clip.start)));
    return { cx: W / 2 + tr.x * W, cy: H / 2 + tr.y * H, w: bw * tr.scale, h: bh * tr.scale, rot: tr.rotation, tr };
  }

  updateGizmo() {
    this.overlay.textContent = '';
    const f = this.store.primary();
    if (!f || !VISUAL.has(f.clip.type)) return;
    const c = f.clip;
    const t = this.player.time;
    if (t < c.start || t >= clipEnd(c)) return;
    const g = this.geometry(c, t);
    if (!g) return;
    const k = this.cssW / this.store.project.width;
    const box = h('div', { class: 'gizmo' + (f.track.locked ? ' locked' : '') });
    box.style.width = g.w * k + 'px';
    box.style.height = g.h * k + 'px';
    box.style.transform = `translate(${g.cx * k - (g.w * k) / 2}px, ${g.cy * k - (g.h * k) / 2}px) rotate(${g.rot}deg)`;
    if (!f.track.locked) {
      for (const corner of ['nw', 'ne', 'sw', 'se']) box.append(h('i', { class: 'handle ' + corner, 'data-h': corner }));
      box.append(h('i', { class: 'rot', 'data-h': 'rot', title: 'Rotate' }));
    }
    this.overlay.append(box);
  }

  stagePoint(e) {
    const r = this.stage.getBoundingClientRect();
    const k = this.store.project.width / r.width;
    return [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
  }

  // Topmost visual clip under a frame point.
  pick(x, y) {
    const p = this.store.project;
    const t = this.player.time;
    for (const track of p.tracks) {
      if (track.hidden || (track.type !== 'video' && track.type !== 'text')) continue;
      for (const c of [...track.clips].reverse()) {
        if (t < c.start || t >= clipEnd(c) || !VISUAL.has(c.type)) continue;
        const g = this.geometry(c, t);
        if (!g) continue;
        const a = (-g.rot * Math.PI) / 180;
        const dx = x - g.cx, dy = y - g.cy;
        const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
        if (Math.abs(lx) <= g.w / 2 && Math.abs(ly) <= g.h / 2) return c;
      }
    }
    return null;
  }

  // Writes a transform property, adding to keyframes when the property is keyframed.
  setProps(id, values, final) {
    const fps = this.store.project.fps || 30;
    const apply = (p) => {
      const f = findClip(p, id);
      if (!f) return;
      const c = f.clip;
      const local = Math.max(0, Math.min(c.duration, this.player.time - c.start));
      for (const key in values) {
        const frames = c.keyframes && c.keyframes[key];
        if (frames && frames.length) {
          const ex = frames.find((kf) => Math.abs(kf.t - local) < 0.5 / fps);
          if (ex) ex.v = values[key];
          else {
            frames.push({ t: local, v: values[key], e: 'inout' });
            frames.sort((a, b) => a.t - b.t);
          }
        } else c.transform[key] = values[key];
      }
    };
    this.store.live(apply);
    if (final) this.store.end('Transform');
  }

  onDown(e) {
    if (e.button !== 0) return;
    const [x, y] = this.stagePoint(e);
    const handle = e.target.dataset && e.target.dataset.h;
    let f = this.store.primary();
    if (!handle) {
      const hit = this.pick(x, y);
      if (!hit) {
        this.store.select([]);
        return;
      }
      if (!f || f.clip.id !== hit.id) {
        this.store.select(hit.id);
        f = this.store.primary();
      }
    }
    if (!f || !VISUAL.has(f.clip.type) || f.track.locked) return;
    const g = this.geometry(f.clip, this.player.time);
    if (!g) return;
    e.preventDefault();
    this.stage.setPointerCapture(e.pointerId);
    const p = this.store.project;
    const d = (this.drag = { mode: handle === 'rot' ? 'rot' : handle ? 'scale' : 'move', id: f.clip.id, x0: x, y0: y, g, tr: { ...g.tr } });
    d.a0 = Math.atan2(y - g.cy, x - g.cx);
    d.r0 = Math.hypot(x - g.cx, y - g.cy) || 1;
    const move = (ev) => {
      const [mx, my] = this.stagePoint(ev);
      let showV = false, showH = false;
      if (d.mode === 'move') {
        let nx = d.tr.x + (mx - d.x0) / p.width;
        let ny = d.tr.y + (my - d.y0) / p.height;
        const tol = 8 / this.cssW;
        if (!ev.altKey) {
          if (Math.abs(nx) < tol) { nx = 0; showV = true; }
          if (Math.abs(ny) < tol * (p.width / p.height)) { ny = 0; showH = true; }
        }
        this.setProps(d.id, { x: nx, y: ny }, false);
      } else if (d.mode === 'scale') {
        const r = Math.hypot(mx - g.cx, my - g.cy);
        this.setProps(d.id, { scale: Math.max(0.02, d.tr.scale * (r / d.r0)) }, false);
      } else {
        let a = d.tr.rotation + ((Math.atan2(my - g.cy, mx - g.cx) - d.a0) * 180) / Math.PI;
        if (ev.shiftKey) a = Math.round(a / 15) * 15;
        else for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(a - s) < 3) a = s;
        this.setProps(d.id, { rotation: a }, false);
      }
      this.guides.classList.toggle('v', showV);
      this.guides.classList.toggle('h', showH);
      this.updateGizmo();
    };
    const up = () => {
      this.stage.removeEventListener('pointermove', move);
      this.stage.removeEventListener('pointerup', up);
      this.stage.removeEventListener('pointercancel', up);
      this.guides.className = 'pv-guides';
      this.drag = null;
      this.store.end(d.mode === 'move' ? 'Move' : d.mode === 'scale' ? 'Scale' : 'Rotate');
    };
    this.stage.addEventListener('pointermove', move);
    this.stage.addEventListener('pointerup', up);
    this.stage.addEventListener('pointercancel', up);
  }

  onDouble(e) {
    const [x, y] = this.stagePoint(e);
    const c = this.pick(x, y);
    if (c && (c.type === 'text' || c.type === 'sticker')) {
      this.store.select(c.id);
      this.app.showInspectorTab('text');
      setTimeout(() => {
        const ta = document.getElementById('text-content');
        if (ta) {
          ta.focus();
          ta.select();
        }
      }, 30);
    }
  }

  snapshot() {
    // Draw again right before reading, since the preview canvas does not keep its buffer.
    this.app.renderer.render(this.store.project, this.player.time, this.player.frames);
    const c = this.app.renderer.toCanvas();
    c.toBlob((b) => b && this.app.saveFile(b, `${this.store.project.name || 'frame'} ${fmtTime(this.player.time).replace(':', '-')}.png`), 'image/png');
  }

  fullscreen() {
    const el = this.wrap;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => toast('Full screen is not available here'));
  }
}

