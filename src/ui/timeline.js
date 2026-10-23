// Multi-track timeline drawn on a canvas. DOM is only used for track headers and the toolbar.

import { h, icon, iconButton, contextMenu, toast } from './dom.js';
import { clipEnd, findClip, fmtTime, projectDuration, clipLabel, transitionInfo, sourceTime, trackTypeFor } from '../model.js';
import * as ops from '../ops.js';
import { effectById } from '../engine/effects.js';
import { filterById } from '../engine/filters.js';

const RULER = 26;
const PAD_X = 14;
const GAP = 4;
const ROW_H = { main: 66, video: 54, audio: 46, text: 34, effect: 30 };
const COLORS = {
  video: ['#2f4a6e', '#3f6290'],
  image: ['#355266', '#47708a'],
  audio: ['#1f5a52', '#2a776c'],
  text: ['#6b4a1c', '#8d6326'],
  sticker: ['#6a2f57', '#8b3f73'],
  shape: ['#5d3a20', '#7e5230'],
  effect: ['#4a3575', '#634a99'],
  adjust: ['#38416e', '#4b5791'],
};

const imgCache = new Map();
function img(src, onload) {
  let i = imgCache.get(src);
  if (!i) {
    i = new Image();
    i.onload = onload;
    i.src = src;
    imgCache.set(src, i);
  }
  return i.complete && i.naturalWidth ? i : null;
}

export class Timeline {
  constructor(root, app) {
    this.app = app;
    this.store = app.store;
    this.media = app.media;
    this.player = app.player;
    this.pps = 60;
    this.snap = true;
    this.hits = [];
    this.drag = null;
    this.hover = null;
    this.dropGhost = null;
    this.follow = true;
    this.root = root;
    this.build();
    this.store.addEventListener('change', () => this.refresh());
    this.store.addEventListener('project', () => this.refresh());
    this.store.addEventListener('selection', () => this.refresh());
    this.media.addEventListener('change', () => this.request());
    this.player.addEventListener('time', () => this.onTime());
    this.player.addEventListener('state', () => this.updateToolbar());
    new ResizeObserver(() => this.resize()).observe(this.body);
    this.resize();
    this.refresh();
  }

  build() {
    const s = this.store;
    this.zoomInput = h('input', { type: 'range', min: 0, max: 1000, step: 1, id: 'tl-zoom', 'aria-label': 'Timeline zoom', oninput: () => this.setZoom(this.zoomFromSlider(+this.zoomInput.value)) });
    this.btn = {
      undo: iconButton('undo', 'Undo (Ctrl+Z)', () => this.app.undo()),
      redo: iconButton('redo', 'Redo (Ctrl+Shift+Z)', () => this.app.redo()),
      split: iconButton('split', 'Split at playhead (S)', () => ops.splitAt(s, this.player.time) || toast('Put the playhead over a clip to split it')),
      del: iconButton('trash', 'Delete (Del)', () => ops.deleteSelected(s)),
      dup: iconButton('copy', 'Duplicate (Ctrl+D)', () => ops.duplicateSelected(s)),
      freeze: iconButton('freeze', 'Freeze frame', () => ops.freezeFrame(s, this.media, this.player).then((ok) => ok || toast('Select a video clip under the playhead'))),
      detach: iconButton('detach', 'Extract audio', () => {
        const f = s.primary();
        if (f && f.clip.type === 'video') ops.detachAudio(s, f.clip.id);
        else toast('Select a video clip first');
      }),
      marker: iconButton('diamond', 'Add marker (M)', () => ops.setMarker(s, this.player.time)),
      magnet: iconButton('magnet', 'Main track magnet', () => s.commit('Magnet', (p) => (p.magnet = !p.magnet)), { class: 'toggle' }),
      snap: iconButton('snap', 'Snapping (N)', () => { this.snap = !this.snap; this.updateToolbar(); }, { class: 'toggle' }),
      zoomOut: iconButton('zoomOut', 'Zoom out (-)', () => this.setZoom(this.pps / 1.4)),
      zoomIn: iconButton('zoomIn', 'Zoom in (+)', () => this.setZoom(this.pps * 1.4)),
      fit: iconButton('fit', 'Fit timeline', () => this.fit()),
    };
    const b = this.btn;
    this.toolbar = h(
      'div',
      { class: 'tl-toolbar' },
      h('div', { class: 'tl-group' }, b.undo, b.redo, h('span', { class: 'sep' }), b.split, b.del, b.dup, b.freeze, b.detach, b.marker),
      h('div', { class: 'tl-group right' }, b.magnet, b.snap, h('span', { class: 'sep' }), b.zoomOut, this.zoomInput, b.zoomIn, b.fit),
    );
    this.heads = h('div', { class: 'tl-heads' });
    this.scroller = h('div', { class: 'tl-scroll' }, (this.spacer = h('div', { class: 'tl-spacer' })));
    this.canvas = h('canvas', { class: 'tl-canvas', tabindex: 0, 'aria-label': 'Timeline' });
    this.body = h('div', { class: 'tl-body' }, this.heads, h('div', { class: 'tl-view' }, this.scroller, this.canvas));
    this.root.append(this.toolbar, this.body);
    this.ctx = this.canvas.getContext('2d');

    this.scroller.addEventListener('scroll', () => {
      this.request();
      this.layoutHeads();
    });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e, true));
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.request(); });
    this.canvas.addEventListener('dblclick', (e) => this.onDouble(e));
    this.canvas.addEventListener('contextmenu', (e) => this.onContext(e));
    this.canvas.addEventListener('dragover', (e) => this.onDragOver(e));
    this.canvas.addEventListener('dragleave', () => { this.dropGhost = null; this.request(); });
    this.canvas.addEventListener('drop', (e) => this.onDrop(e));
    this.updateToolbar();
  }

  zoomFromSlider(v) {
    return 2 * Math.pow(400, v / 1000);
  }

  sliderFromZoom(pps) {
    return (Math.log(pps / 2) / Math.log(400)) * 1000;
  }

  setZoom(pps, anchorX) {
    pps = Math.max(2, Math.min(800, pps));
    const view = this.scroller.clientWidth;
    const ax = anchorX ?? Math.min(view, Math.max(0, this.timeToX(this.player.time) - this.scroller.scrollLeft));
    const tAt = (this.scroller.scrollLeft + ax - PAD_X) / this.pps;
    this.pps = pps;
    this.updateSpacer();
    this.scroller.scrollLeft = Math.max(0, tAt * pps + PAD_X - ax);
    this.zoomInput.value = this.sliderFromZoom(pps);
    this.request();
  }

  fit() {
    const d = Math.max(5, projectDuration(this.store.project));
    this.setZoom((this.scroller.clientWidth - PAD_X * 2 - 40) / d, 0);
    this.scroller.scrollLeft = 0;
  }

  updateToolbar() {
    const s = this.store;
    this.btn.undo.disabled = !s.undoStack.length;
    this.btn.redo.disabled = !s.redoStack.length;
    const hasSel = s.selection.length > 0;
    this.btn.del.disabled = !hasSel;
    this.btn.dup.disabled = !hasSel;
    this.btn.magnet.classList.toggle('on', !!s.project.magnet);
    this.btn.snap.classList.toggle('on', this.snap);
  }

  refresh() {
    this.updateToolbar();
    this.updateSpacer();
    this.buildHeads();
    this.request();
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const sbw = this.scroller.offsetWidth - this.scroller.clientWidth;
    const sbh = this.scroller.offsetHeight - this.scroller.clientHeight;
    this.vw = Math.max(10, r.width - sbw);
    this.vh = Math.max(10, r.height - sbh);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.vw * dpr);
    this.canvas.height = Math.round(this.vh * dpr);
    this.canvas.style.width = this.vw + 'px';
    this.canvas.style.height = this.vh + 'px';
    this.dpr = dpr;
    this.updateSpacer();
    this.layoutHeads();
    this.request();
  }

  rows() {
    const out = [];
    let y = RULER + 6;
    for (const t of this.store.project.tracks) {
      const hh = t.main ? ROW_H.main : ROW_H[t.type] || 40;
      out.push({ track: t, y, h: hh });
      y += hh + GAP;
    }
    this.contentH = y + 40;
    return out;
  }

  updateSpacer() {
    const d = projectDuration(this.store.project);
    const w = Math.max(this.vw || 800, (d + 60) * this.pps + PAD_X * 2);
    this.rows();
    this.spacer.style.width = w + 'px';
    this.spacer.style.height = Math.max(this.contentH, (this.vh || 200)) + 'px';
    this.zoomInput.value = this.sliderFromZoom(this.pps);
  }

  buildHeads() {
    const tracks = this.store.project.tracks;
    const counts = {};
    this.heads.textContent = '';
    this.heads.append(h('div', { class: 'tl-head-ruler' }, h('span', { class: 'tc', id: 'tl-tc' }, fmtTime(this.player.time, this.store.project.fps, true))));
    this.headEls = tracks.map((t) => {
      counts[t.type] = (counts[t.type] || 0) + 1;
      const name = t.main ? 'Main' : { video: 'Overlay', audio: 'Audio', text: 'Text', effect: 'Effects' }[t.type] + ' ' + counts[t.type];
      const ic = { video: 'film', audio: 'music', text: 'text', effect: 'sparkles' }[t.type];
      const tog = (prop, on, off, title) => {
        const b = iconButton(t[prop] ? on : off, title, () => this.store.commit(title, (p) => {
          const tt = p.tracks.find((x) => x.id === t.id);
          if (tt) tt[prop] = !tt[prop];
        }), { size: 15, class: 'tiny' + (t[prop] ? ' on' : '') });
        return b;
      };
      const el = h(
        'div',
        { class: 'tl-head' + (t.main ? ' main' : ''), 'data-type': t.type },
        h('span', { class: 'tl-head-name' }, icon(ic, 14), name),
        h('span', { class: 'tl-head-tools' },
          t.type === 'video' || t.type === 'audio' ? tog('muted', 'mute', 'volume', 'Mute track') : null,
          t.type !== 'audio' ? tog('hidden', 'eyeOff', 'eye', 'Hide track') : null,
          tog('locked', 'lock', 'unlock', 'Lock track')),
      );
      this.heads.append(el);
      return el;
    });
    this.layoutHeads();
  }

  layoutHeads() {
    if (!this.headEls) return;
    const rows = this.rows();
    const st = this.scroller.scrollTop;
    rows.forEach((r, i) => {
      const el = this.headEls[i];
      if (!el) return;
      el.style.transform = `translateY(${r.y - st}px)`;
      el.style.height = r.h + 'px';
    });
  }

  timeToX(t) {
    return PAD_X + t * this.pps;
  }

  xToTime(x) {
    return Math.max(0, (x + this.scroller.scrollLeft - PAD_X) / this.pps);
  }

  onTime() {
    const tc = document.getElementById('tl-tc');
    if (tc) tc.textContent = fmtTime(this.player.time, this.store.project.fps, true);
    if (this.player.playing && this.follow && !this.drag) {
      const x = this.timeToX(this.player.time) - this.scroller.scrollLeft;
      if (x > this.vw - 60 || x < 0) this.scroller.scrollLeft = Math.max(0, this.timeToX(this.player.time) - 80);
    }
    this.request();
  }

  request() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.draw();
    });
  }

  // ---------- drawing ----------

  draw() {
    const ctx = this.ctx;
    const dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.vw, H = this.vh;
    const sl = this.scroller.scrollLeft, st = this.scroller.scrollTop;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#121418';
    ctx.fillRect(0, 0, W, H);
    this.hits = [];
    const t0 = Math.max(0, (sl - PAD_X) / this.pps);
    const t1 = (sl + W - PAD_X) / this.pps;
    const sel = new Set(this.store.selection);
    const rows = this.rows();

    // Track rows
    for (const r of rows) {
      const y = r.y - st;
      if (y > H || y + r.h < RULER) continue;
      ctx.fillStyle = r.track.main ? '#191c22' : '#16181d';
      ctx.fillRect(0, y, W, r.h);
      if (r.track.locked) {
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        for (let x = -((sl) % 12); x < W; x += 12) ctx.fillRect(x, y, 6, r.h);
      }
    }

    // Clips
    for (const r of rows) {
      const y = r.y - st;
      if (y > H || y + r.h < RULER - 10) continue;
      const track = r.track;
      for (let i = 0; i < track.clips.length; i++) {
        const c = track.clips[i];
        if (clipEnd(c) < t0 || c.start > t1) continue;
        const ghostMove = this.drag && this.drag.type === 'move' && this.drag.mainInsert && this.drag.ids.includes(c.id);
        this.drawClip(ctx, c, track, this.timeToX(c.start) - sl, y, c.duration * this.pps, r.h, sel.has(c.id), ghostMove);
      }
      // Transition points between touching clips on video tracks
      if (track.type === 'video') {
        for (let i = 1; i < track.clips.length; i++) {
          const a = track.clips[i - 1], b = track.clips[i];
          if (Math.abs(clipEnd(a) - b.start) > 0.02) continue;
          const x = this.timeToX(b.start) - sl;
          if (x < -20 || x > W + 20) continue;
          const info = transitionInfo(track, b);
          const cy = y + r.h / 2;
          if (info) {
            const w = info.duration * this.pps;
            ctx.fillStyle = 'rgba(242,179,61,0.18)';
            ctx.fillRect(x - w / 2, y + 2, w, r.h - 4);
          }
          const hovered = this.hover && this.hover.type === 'transition' && this.hover.clip.id === b.id;
          if (info || hovered || this.pps > 25) {
            ctx.save();
            ctx.translate(x, cy);
            ctx.fillStyle = info ? '#f2b33d' : hovered ? '#e8e9ec' : 'rgba(232,233,236,0.55)';
            roundRectPath(ctx, -9, -9, 18, 18, 5);
            ctx.fill();
            ctx.fillStyle = '#121418';
            ctx.font = '600 12px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(info ? '⋈' : '+', 0, 1);
            ctx.restore();
          }
          this.hits.push({ type: 'transition', x: x - 10, y: cy - 10, w: 20, h: 20, clip: b, track });
        }
      }
    }

    // Drop / insert ghosts
    if (this.dropGhost) {
      const g = this.dropGhost;
      ctx.fillStyle = 'rgba(242,179,61,0.25)';
      ctx.strokeStyle = '#f2b33d';
      ctx.lineWidth = 1.5;
      roundRectPath(ctx, g.x - sl, g.y - st, g.w, g.h, 6);
      ctx.fill();
      ctx.stroke();
    }
    if (this.drag && this.drag.type === 'move' && this.drag.mainInsert && this.drag.insertX !== undefined) {
      const d = this.drag;
      ctx.fillStyle = '#f2b33d';
      ctx.fillRect(d.insertX - sl - 1.5, d.insertY - st, 3, d.insertH);
      ctx.globalAlpha = 0.6;
      const g = d.ghost;
      if (g) this.drawClip(ctx, g.clip, g.track, g.x - sl, g.y - st, g.w, g.h, true, false);
      ctx.globalAlpha = 1;
    }
    if (this.snapLine !== undefined && this.snapLine !== null) {
      const x = this.timeToX(this.snapLine) - sl;
      ctx.strokeStyle = '#f2b33d';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER);
      ctx.lineTo(x + 0.5, H);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Ruler
    this.drawRuler(ctx, W, sl, t0, t1);

    // Playhead
    const px = this.timeToX(this.player.time) - sl;
    if (px > -10 && px < W + 10) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(px) - 0.5, RULER - 4, 1.5, H);
      ctx.beginPath();
      ctx.moveTo(px - 6, RULER - 12);
      ctx.lineTo(px + 6, RULER - 12);
      ctx.lineTo(px + 6, RULER - 5);
      ctx.lineTo(px, RULER + 1);
      ctx.lineTo(px - 6, RULER - 5);
      ctx.closePath();
      ctx.fill();
    }
    if (!rows.some((r) => r.track.clips.length)) {
      ctx.fillStyle = '#7d8590';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const r0 = rows.find((r) => r.track.main);
      ctx.fillText('Drag media here, or click a clip in the Media panel to add it', PAD_X + 12 - sl, (r0 ? r0.y + r0.h / 2 : 80) - st);
    }
  }

  drawRuler(ctx, W, sl, t0, t1) {
    ctx.fillStyle = '#121418';
    ctx.fillRect(0, 0, W, RULER);
    ctx.fillStyle = '#20242b';
    ctx.fillRect(0, RULER - 1, W, 1);
    const steps = [1 / 30, 1 / 10, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let major = steps.find((s) => s * this.pps >= 80) || 600;
    const minor = major / (major >= 1 ? 5 : 2);
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const fps = this.store.project.fps || 30;
    const per = Math.round(major / minor);
    for (let i = Math.floor(t0 / minor); i * minor <= t1 + minor; i++) {
      const t = i * minor;
      const x = Math.round(this.timeToX(t) - sl) + 0.5;
      const isMajor = i % per === 0;
      ctx.fillStyle = isMajor ? '#59606b' : '#353a43';
      ctx.fillRect(x, isMajor ? RULER - 10 : RULER - 5, 1, isMajor ? 9 : 4);
      if (isMajor) {
        ctx.fillStyle = '#8a919c';
        ctx.fillText(major < 1 ? fmtTime(t, fps, true) : fmtTime(t), x + 4, 4);
      }
    }
    for (const m of this.store.project.markers || []) {
      const x = this.timeToX(m.t) - sl;
      ctx.fillStyle = m.color || '#f2b33d';
      ctx.beginPath();
      ctx.moveTo(x, RULER - 2);
      ctx.lineTo(x - 5, RULER - 8);
      ctx.lineTo(x - 5, RULER - 14);
      ctx.lineTo(x + 5, RULER - 14);
      ctx.lineTo(x + 5, RULER - 8);
      ctx.closePath();
      ctx.fill();
    }
    this.hits.push({ type: 'ruler', x: 0, y: 0, w: W, h: RULER });
  }

  drawClip(ctx, c, track, x, y, w, hh, selected, ghost) {
    const [bg, hi] = COLORS[c.type] || COLORS.video;
    const visibleX = Math.max(x, -4);
    const visibleW = Math.min(x + w, this.vw + 4) - visibleX;
    ctx.save();
    if (ghost) ctx.globalAlpha = 0.35;
    roundRectPath(ctx, x + 0.5, y + 0.5, Math.max(2, w - 1), hh - 1, 6);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.clip();
    const m = c.mediaId ? this.media.get(c.mediaId) : null;
    // Filmstrip
    if (m && (c.type === 'video' || c.type === 'image') && m.thumbs && m.thumbs.length) {
      const first = img(m.thumbs[0], () => this.request());
      const ar = first ? first.naturalWidth / first.naturalHeight : 16 / 9;
      const th = c.type === 'video' && m.hasAudio && !c.muted && hh > 50 ? hh - 16 : hh;
      const tw = Math.max(16, th * ar);
      const startTile = Math.floor((visibleX - x) / tw);
      for (let k = Math.max(0, startTile); x + k * tw < visibleX + visibleW; k++) {
        const tx = x + k * tw;
        let thumb = m.thumbs[0];
        if (c.type === 'video' && m.thumbTimes && m.thumbTimes.length) {
          const st = sourceTime(c, c.start + ((k + 0.5) * tw) / this.pps);
          let best = 0;
          for (let j = 0; j < m.thumbTimes.length; j++) if (Math.abs(m.thumbTimes[j] - st) < Math.abs(m.thumbTimes[best] - st)) best = j;
          thumb = m.thumbs[best] || thumb;
        }
        const im = img(thumb, () => this.request());
        if (im) ctx.drawImage(im, tx, y, tw, th);
      }
      ctx.fillStyle = 'rgba(10,12,16,0.18)';
      ctx.fillRect(x, y, w, hh);
    }
    // Waveform
    const wantWave = m && m.peaks && (c.type === 'audio' || (c.type === 'video' && m.hasAudio && !c.muted && hh > 50));
    if (wantWave) {
      const wy = c.type === 'audio' ? y + 14 : y + hh - 16;
      const wh = c.type === 'audio' ? hh - 16 : 16;
      ctx.fillStyle = c.type === 'audio' ? 'rgba(160,240,220,0.55)' : 'rgba(18,22,28,0.75)';
      if (c.type !== 'audio') ctx.fillRect(x, wy, w, wh);
      ctx.fillStyle = c.type === 'audio' ? 'rgba(170,245,225,0.7)' : 'rgba(120,220,200,0.8)';
      const rate = m.peaksRate || 50;
      const vol = Math.min(2, c.volume ?? 1);
      for (let px = Math.max(0, Math.floor(visibleX - x)); px < Math.min(w, visibleX - x + visibleW); px += 2) {
        const sa = sourceTime(c, c.start + px / this.pps);
        const sb = sourceTime(c, c.start + (px + 2) / this.pps);
        let mx = 0;
        for (let k = Math.floor(sa * rate); k <= Math.floor(sb * rate); k++) if (m.peaks[k] > mx) mx = m.peaks[k];
        const a = (mx / 255) * vol * (wh - 2);
        ctx.fillRect(x + px, wy + (wh - a) / 2, 1.5, Math.max(1, a));
      }
      // Beat dots
      if (m.beats && c.type === 'audio') {
        ctx.fillStyle = '#f2b33d';
        for (const b of m.beats) {
          const tt = c.start + (b - (c.in || 0)) / (c.speed || 1);
          if (tt < c.start || tt > clipEnd(c)) continue;
          const bx = this.timeToX(tt) - this.scroller.scrollLeft;
          ctx.fillRect(bx - 1, y + hh - 5, 2, 3);
        }
      }
    }
    // Fades
    const fadeIn = c.fadeIn || 0, fadeOut = c.fadeOut || 0;
    if (fadeIn > 0 || fadeOut > 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      if (fadeIn > 0) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + fadeIn * this.pps, y);
        ctx.lineTo(x, y + hh);
        ctx.fill();
      }
      if (fadeOut > 0) {
        ctx.beginPath();
        ctx.moveTo(x + w, y);
        ctx.lineTo(x + w - fadeOut * this.pps, y);
        ctx.lineTo(x + w, y + hh);
        ctx.fill();
      }
    }
    // Animation ramps
    const an = c.anim || {};
    const ramp = (d, atEnd) => {
      const rw = Math.min(w, d * this.pps);
      const gx = atEnd ? x + w - rw : x;
      const g = ctx.createLinearGradient(gx, 0, gx + rw, 0);
      g.addColorStop(atEnd ? 0 : 1, 'rgba(242,179,61,0)');
      g.addColorStop(atEnd ? 1 : 0, 'rgba(242,179,61,0.35)');
      ctx.fillStyle = g;
      ctx.fillRect(gx, y, rw, 4);
    };
    if (an.in && an.in.id) ramp(an.in.duration || 0.5, false);
    if (an.out && an.out.id) ramp(an.out.duration || 0.5, true);
    // Label
    const label = c.type === 'effect' ? (effectById.get(c.effect.id) || { name: c.effect.id }).name : c.type === 'adjust' ? 'Filter · ' + ((c.filter && filterById.get(c.filter.id)) || { name: 'none' }).name : clipLabel(c, this.media.items);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const lx = Math.max(x + 6, 6);
    const badges = [];
    if ((c.speed || 1) !== 1) badges.push((c.speed || 1).toFixed(c.speed < 1 ? 2 : 1) + 'x');
    if (c.effects && c.effects.length) badges.push('fx ' + c.effects.length);
    if (c.filter && c.filter.id && c.type !== 'adjust') badges.push('filter');
    if (c.muted) badges.push('muted');
    const text = (c.type === 'text' ? 'T  ' : c.type === 'effect' ? '✦ ' : '') + label + (badges.length ? '  ·  ' + badges.join(' · ') : '');
    if (w > 24) {
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(10,12,16,0.55)';
      if (c.type === 'video' || c.type === 'image') roundRectPath(ctx, lx - 3, y + 3, Math.min(tw + 6, w - 8), 15, 4), ctx.fill();
      ctx.fillStyle = '#eef0f3';
      ctx.fillText(text, lx, y + 5, Math.max(10, w - 14));
    }
    if (c.type === 'text' || c.type === 'sticker') {
      // small accent underline
      ctx.fillStyle = hi;
      ctx.fillRect(x, y + hh - 3, w, 3);
    }
    ctx.restore();

    // Selection, handles, keyframes
    if (selected) {
      ctx.strokeStyle = '#f2b33d';
      ctx.lineWidth = 2;
      roundRectPath(ctx, x + 1, y + 1, Math.max(2, w - 2), hh - 2, 6);
      ctx.stroke();
      ctx.fillStyle = '#f2b33d';
      roundRectPath(ctx, x, y, 8, hh, 4);
      ctx.fill();
      roundRectPath(ctx, x + w - 8, y, 8, hh, 4);
      ctx.fill();
      ctx.fillStyle = '#121418';
      ctx.fillRect(x + 3, y + hh / 2 - 6, 2, 12);
      ctx.fillRect(x + w - 5, y + hh / 2 - 6, 2, 12);
      // keyframes
      const kfs = new Set();
      for (const k in c.keyframes || {}) for (const f of c.keyframes[k] || []) kfs.add(+f.t.toFixed(3));
      ctx.fillStyle = '#ffffff';
      for (const kt of kfs) {
        const kx = x + kt * this.pps;
        ctx.save();
        ctx.translate(kx, y + hh - 9);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-3.5, -3.5, 7, 7);
        ctx.restore();
        this.hits.push({ type: 'keyframe', x: kx - 6, y: y + hh - 15, w: 12, h: 12, clip: c, track, t: kt });
      }
      // audio fade handles
      if ((c.type === 'audio' || c.type === 'video') && w > 40) {
        const fx1 = x + fadeIn * this.pps, fx2 = x + w - fadeOut * this.pps;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(Math.max(x + 12, fx1), y + 7, 4, 0, Math.PI * 2);
        ctx.arc(Math.min(x + w - 12, fx2), y + 7, 4, 0, Math.PI * 2);
        ctx.fill();
        this.hits.push({ type: 'fadeIn', x: Math.max(x + 12, fx1) - 7, y: y, w: 14, h: 14, clip: c, track });
        this.hits.push({ type: 'fadeOut', x: Math.min(x + w - 12, fx2) - 7, y: y, w: 14, h: 14, clip: c, track });
      }
    }
    if (!ghost) {
      const edge = Math.min(10, w / 3);
      this.hits.push({ type: 'clip', x, y, w, h: hh, clip: c, track });
      this.hits.push({ type: 'trimL', x: x - 3, y, w: edge + 3, h: hh, clip: c, track });
      this.hits.push({ type: 'trimR', x: x + w - edge, y, w: edge + 3, h: hh, clip: c, track });
    }
  }

  // ---------- hit testing & interaction ----------

  hitAt(x, y) {
    if (y < RULER) return this.hits.find((hh) => hh.type === 'ruler') || null;
    // Trim handles of a selected clip win over the transition button that sits on the same cut.
    const sel = new Set(this.store.selection);
    const rank = (hit) => {
      if (hit.type === 'keyframe') return 0;
      if (hit.type === 'fadeIn' || hit.type === 'fadeOut') return 1;
      if ((hit.type === 'trimL' || hit.type === 'trimR') && sel.has(hit.clip.id)) return 2;
      if (hit.type === 'transition') return 3;
      if (hit.type === 'trimL' || hit.type === 'trimR') return 4;
      if (hit.type === 'clip') return 5;
      return 6;
    };
    let best = null;
    for (const hit of this.hits) {
      if (x < hit.x || x > hit.x + hit.w || y < hit.y || y > hit.y + hit.h) continue;
      if (!best || rank(hit) < rank(best)) best = hit;
    }
    return best;
  }

  rowAt(y) {
    const st = this.scroller.scrollTop;
    for (const r of this.rows()) if (y + st >= r.y - GAP / 2 && y + st <= r.y + r.h + GAP / 2) return r;
    return null;
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  snapPoints(excludeIds) {
    const pts = [0, this.player.time];
    const p = this.store.project;
    for (const t of p.tracks) for (const c of t.clips) if (!excludeIds.has(c.id)) pts.push(c.start, clipEnd(c));
    for (const m of p.markers || []) pts.push(m.t);
    for (const t of p.tracks) {
      if (t.type !== 'audio') continue;
      for (const c of t.clips) {
        const m = this.media.get(c.mediaId);
        if (!m || !m.beats) continue;
        for (const b of m.beats) {
          const tt = c.start + (b - (c.in || 0)) / (c.speed || 1);
          if (tt >= c.start && tt <= clipEnd(c)) pts.push(tt);
        }
      }
    }
    return pts;
  }

  snapTime(t, pts, alsoEnd) {
    if (!this.snap) return { t, line: null };
    const tol = 8 / this.pps;
    let best = null;
    for (const pt of pts) {
      const d = Math.abs(pt - t);
      if (d < tol && (!best || d < best.d)) best = { d, pt, delta: pt - t };
      if (alsoEnd !== undefined) {
        const d2 = Math.abs(pt - (t + alsoEnd));
        if (d2 < tol && (!best || d2 < best.d)) best = { d: d2, pt, delta: pt - (t + alsoEnd) };
      }
    }
    return best ? { t: t + best.delta, line: best.pt } : { t, line: null };
  }

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const [x] = this.local(e);
      this.setZoom(this.pps * Math.exp(-e.deltaY * 0.0025), x);
      return;
    }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) this.scroller.scrollLeft += e.deltaX || e.deltaY;
    else this.scroller.scrollTop += e.deltaY;
  }

  onDown(e) {
    this.canvas.focus({ preventScroll: true });
    const [x, y] = this.local(e);
    const hit = this.hitAt(x, y);
    const s = this.store;
    if (e.button === 2) return;
    this.canvas.setPointerCapture(e.pointerId);
    if (!hit || hit.type === 'ruler') {
      if (!hit && e.pointerType === 'touch') {
        this.drag = { type: 'pan', x0: x, y0: y, sl: this.scroller.scrollLeft, st: this.scroller.scrollTop, moved: false };
        return;
      }
      if (!hit && !e.shiftKey) s.select([]);
      this.drag = { type: 'scrub' };
      this.player.seek(this.xToTime(x));
      return;
    }
    if (hit.type === 'transition') {
      s.select(hit.clip.id);
      this.app.showTab('transitions');
      return;
    }
    if (hit.type === 'keyframe') {
      s.select(hit.clip.id);
      this.player.seek(hit.clip.start + hit.t);
      return;
    }
    const c = hit.clip;
    if (hit.track.locked) {
      s.select(c.id);
      return;
    }
    if (hit.type === 'fadeIn' || hit.type === 'fadeOut') {
      this.drag = { type: hit.type, id: c.id, x0: x, v0: c[hit.type] || 0 };
      return;
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey) s.select(c.id, true);
    else if (!s.selection.includes(c.id)) s.select(c.id);
    const m = this.media.get(c.mediaId);
    if (hit.type === 'trimL' || hit.type === 'trimR') {
      this.drag = { type: hit.type, id: c.id, x0: x, start: c.start, duration: c.duration, in: c.in || 0, speed: c.speed || 1, mediaDur: m && (c.type === 'video' || c.type === 'audio') ? m.duration : Infinity, pts: this.snapPoints(new Set([c.id])) };
      return;
    }
    const ids = s.selection.slice();
    this.drag = {
      type: 'move', ids, id: c.id, x0: x, y0: y, moved: false,
      starts: new Map(ids.map((id) => [id, findClip(s.project, id)?.clip.start ?? 0])),
      fromTrack: hit.track.id, pts: this.snapPoints(new Set(ids)), duration: c.duration,
    };
  }

  onMove(e) {
    const [x, y] = this.local(e);
    const d = this.drag;
    const s = this.store;
    if (!d) {
      const hit = this.hitAt(x, y);
      const prev = this.hover;
      this.hover = hit;
      this.canvas.style.cursor = !hit ? 'default' : hit.type === 'trimL' || hit.type === 'trimR' ? 'ew-resize' : hit.type === 'clip' ? 'grab' : hit.type === 'ruler' ? 'col-resize' : 'pointer';
      if ((prev && prev.type) !== (hit && hit.type) || (prev && prev.clip) !== (hit && hit.clip)) this.request();
      return;
    }
    if (d.type === 'pan') {
      this.scroller.scrollLeft = d.sl - (x - d.x0);
      this.scroller.scrollTop = d.st - (y - d.y0);
      d.moved = true;
      return;
    }
    if (d.type === 'scrub') {
      let t = this.xToTime(x);
      if (this.snap && e.shiftKey) t = this.snapTime(t, this.snapPoints(new Set())).t;
      this.player.seek(t);
      this.autoScroll(x);
      return;
    }
    const dt = (x - d.x0) / this.pps;
    if (d.type === 'fadeIn' || d.type === 'fadeOut') {
      s.live((p) => {
        const f = findClip(p, d.id);
        if (!f) return;
        const v = d.type === 'fadeIn' ? d.v0 + dt : d.v0 - dt;
        f.clip[d.type] = Math.max(0, Math.min(f.clip.duration / 2, v));
      });
      return;
    }
    if (d.type === 'trimL' || d.type === 'trimR') {
      s.live((p) => {
        const f = findClip(p, d.id);
        if (!f) return;
        const c = f.clip;
        const minDur = 1 / (p.fps || 30);
        if (d.type === 'trimR') {
          let end = d.start + d.duration + dt;
          const snapped = this.snapTime(end, d.pts);
          end = snapped.t;
          this.snapLine = snapped.line;
          let dur = Math.max(minDur, end - d.start);
          if (isFinite(d.mediaDur)) dur = Math.min(dur, (d.mediaDur - d.in) / d.speed);
          c.duration = dur;
        } else {
          let start = d.start + dt;
          const snapped = this.snapTime(start, d.pts);
          start = snapped.t;
          this.snapLine = snapped.line;
          let shift = start - d.start;
          shift = Math.min(shift, d.duration - minDur);
          if (isFinite(d.mediaDur)) shift = Math.max(shift, -d.in / d.speed);
          if (!f.track.main || !p.magnet) shift = Math.max(shift, -d.start);
          c.start = d.start + shift;
          c.duration = d.duration - shift;
          if (c.in !== undefined) c.in = d.in + shift * d.speed;
          // keep keyframes anchored to the picture
          if (c.keyframes) for (const k in c.keyframes) for (const kf of c.keyframes[k]) kf.t = (kf.t0 ?? (kf.t0 = kf.t)) - shift;
        }
      });
      this.autoScroll(x);
      return;
    }
    if (d.type === 'move') {
      if (!d.moved && Math.abs(x - d.x0) < 3 && Math.abs(y - d.y0) < 3) return;
      d.moved = true;
      const row = this.rowAt(y);
      const p = s.project;
      const primary = findClip(p, d.id);
      if (!primary) return;
      const c = primary.clip;
      let newStart = Math.max(0, d.starts.get(d.id) + dt);
      const sn = this.snapTime(newStart, d.pts, c.duration);
      newStart = Math.max(0, sn.t);
      this.snapLine = sn.line;
      const delta = newStart - d.starts.get(d.id);
      const target = row && row.track.type === trackTypeFor(c.type) && !row.track.locked ? row.track : null;
      d.target = target;
      // Moving onto (or within) a magnetic main track: show where it will be inserted.
      if (p.magnet && target && target.main && d.ids.length === 1) {
        d.mainInsert = true;
        const rowInfo = this.rows().find((r) => r.track === target);
        const others = target.clips.filter((x) => x.id !== c.id);
        const tCursor = this.xToTime(x);
        let at = others.reduce((mx, o) => Math.max(mx, clipEnd(o)), 0);
        let idx = others.length;
        for (let i = 0; i < others.length; i++) {
          if (tCursor < others[i].start + others[i].duration / 2) { at = others[i].start; idx = i; break; }
        }
        d.insertIndex = idx;
        d.insertX = this.timeToX(at);
        d.insertY = rowInfo.y;
        d.insertH = rowInfo.h;
        d.ghost = { clip: c, track: target, x: this.timeToX(tCursor) - (c.duration * this.pps) / 2, y: rowInfo.y, w: c.duration * this.pps, h: rowInfo.h };
        this.request();
        return;
      }
      d.mainInsert = false;
      s.live((proj) => {
        for (const id of d.ids) {
          const f = findClip(proj, id);
          if (!f || f.track.locked) continue;
          f.clip.start = Math.max(0, d.starts.get(id) + delta);
        }
        // Single clip: follow the pointer to another track of the same kind.
        if (d.ids.length === 1 && target && target.id !== primary.track.id) {
          const f = findClip(proj, d.id);
          const to = proj.tracks.find((t) => t.id === target.id);
          if (f && to) {
            f.track.clips.splice(f.index, 1);
            to.clips.push(f.clip);
          }
        }
      });
      this.autoScroll(x);
    }
  }

  autoScroll(x) {
    if (x > this.vw - 30) this.scroller.scrollLeft += 12;
    else if (x < 30) this.scroller.scrollLeft -= 12;
  }

  onUp(e, cancel) {
    const d = this.drag;
    this.drag = null;
    this.snapLine = null;
    if (!d) return;
    const s = this.store;
    if (cancel) {
      s.cancelLive();
      this.request();
      return;
    }
    if (d.type === 'trimL') {
      s.live((p) => {
        const f = findClip(p, d.id);
        if (f && f.clip.keyframes) for (const k in f.clip.keyframes) for (const kf of f.clip.keyframes[k]) { if (kf.t < 0 || kf.t > f.clip.duration + 1e-6) kf.drop = true; delete kf.t0; }
        if (f && f.clip.keyframes) for (const k in f.clip.keyframes) f.clip.keyframes[k] = f.clip.keyframes[k].filter((kf) => !kf.drop);
      });
      s.end('Trim');
    } else if (d.type === 'trimR' || d.type === 'fadeIn' || d.type === 'fadeOut') s.end(d.type === 'trimR' ? 'Trim' : 'Fade');
    else if (d.type === 'move' && d.moved) {
      if (d.mainInsert) {
        const target = d.target;
        s.commit('Move', (p) => {
          const f = findClip(p, d.id);
          const to = p.tracks.find((t) => t.id === target.id);
          if (!f || !to) return;
          f.track.clips.splice(f.index, 1);
          const others = to.clips.slice().sort((a, b) => a.start - b.start);
          others.splice(d.insertIndex, 0, f.clip);
          let t = 0;
          for (const c of others) { c.start = t; t += c.duration; }
          to.clips = others;
          f.clip.transitionIn = null;
        });
      } else {
        // Resolve overlaps by moving the dragged clip to a free track of the same kind.
        s.live((p) => {
          for (const id of d.ids) {
            const f = findClip(p, id);
            if (!f) continue;
            const c = f.clip;
            const clash = f.track.clips.some((o) => o !== c && o.start < clipEnd(c) - 1e-6 && clipEnd(o) > c.start + 1e-6);
            if (clash && !(f.track.main && p.magnet)) {
              f.track.clips.splice(f.index, 1);
              ops.trackWithSpace(p, f.track.type, c.start, clipEnd(c)).clips.push(c);
            }
          }
        });
        s.end('Move');
      }
    } else if (d.type === 'move' && !d.moved) {
      if (!(e.shiftKey || e.ctrlKey || e.metaKey)) s.select(d.id);
      s.cancelLive();
    }
    this.request();
  }

  onDouble(e) {
    const [x, y] = this.local(e);
    const hit = this.hitAt(x, y);
    if (hit && hit.clip) {
      this.store.select(hit.clip.id);
      this.app.focusInspector();
    }
  }

  onContext(e) {
    e.preventDefault();
    const [x, y] = this.local(e);
    const hit = this.hitAt(x, y);
    const s = this.store;
    const t = this.xToTime(x);
    if (hit && hit.clip) {
      if (!s.selection.includes(hit.clip.id)) s.select(hit.clip.id);
      const c = hit.clip;
      contextMenu(e.clientX, e.clientY, [
        ['Split at playhead', () => ops.splitAt(s, this.player.time), { key: 'S' }],
        ['Duplicate', () => ops.duplicateSelected(s), { key: 'Ctrl+D' }],
        ['Copy', () => ops.copySelected(s), { key: 'Ctrl+C' }],
        ['Paste at playhead', () => ops.paste(s, this.player.time), { key: 'Ctrl+V', disabled: !s.clipboard }],
        '-',
        ['Extract audio', () => ops.detachAudio(s, c.id), { disabled: c.type !== 'video' }],
        ['Freeze frame', () => ops.freezeFrame(s, this.media, this.player), { disabled: c.type !== 'video' }],
        [c.muted ? 'Unmute' : 'Mute', () => s.commit('Mute', (p) => { const f = findClip(p, c.id); if (f) f.clip.muted = !f.clip.muted; }), { disabled: c.type !== 'video' && c.type !== 'audio' }],
        ['Remove transition', () => ops.setTransition(s, c.id, null), { disabled: !c.transitionIn }],
        '-',
        ['Delete', () => ops.deleteSelected(s), { key: 'Del', danger: true }],
        ['Ripple delete', () => ops.deleteSelected(s, true), { key: 'Shift+Del', danger: true }],
      ]);
    } else {
      contextMenu(e.clientX, e.clientY, [
        ['Paste here', () => ops.paste(s, t), { disabled: !s.clipboard }],
        ['Add marker here', () => ops.setMarker(s, t)],
        ['Add text here', () => ops.addText(s, t)],
      ]);
    }
  }

  onDragOver(e) {
    const types = e.dataTransfer.types;
    if (!types.includes('text/clipwave-media') && !types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const [x, y] = this.local(e);
    const row = this.rowAt(y);
    const len = (this.app.dragMedia && this.app.dragMedia.type !== 'image' ? this.app.dragMedia.duration : 5) || 5;
    if (row) this.dropGhost = { x: this.timeToX(this.xToTime(x)), y: row.y, w: len * this.pps, h: row.h };
    else this.dropGhost = null;
    this.request();
  }

  async onDrop(e) {
    e.preventDefault();
    this.dropGhost = null;
    const [x, y] = this.local(e);
    const row = this.rowAt(y);
    const t = this.xToTime(x);
    const id = e.dataTransfer.getData('text/clipwave-media');
    if (id) {
      const m = this.media.get(id);
      if (m && m.status === 'ready') ops.dropMedia(this.store, m, row && row.track.id, t);
    } else if (e.dataTransfer.files.length) {
      const list = await this.media.importFiles([...e.dataTransfer.files]);
      let at = t;
      for (const m of list) {
        const c = ops.dropMedia(this.store, m, row && row.track.id, at);
        if (c) at = c.start + c.duration;
      }
    }
    this.app.dragMedia = null;
    this.request();
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
