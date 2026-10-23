// Live preview: keeps one media element per clip in step with the playhead, routes audio through Web Audio
// (so volume can go past 100% and fade smoothly) and redraws the frame.

import { clipEnd, sourceTime, transitionInfo, projectDuration } from '../model.js';
import { keyframeValue } from './animation.js';

export class Player extends EventTarget {
  constructor(renderer, getProject, media) {
    super();
    this.renderer = renderer;
    this.getProject = getProject;
    this.media = media;
    this.time = 0;
    this.playing = false;
    this.els = new Map(); // clip id -> {el, mediaId, gain, node}
    this.ctx = null;
    this.master = null;
    this.dirty = true;
    this.volume = 1;
    this.loop = false;
    this.range = null; // {start, end} to play only a section
    this.frames = { get: (clip, st) => this.frameFor(clip, st) };
    this._raf = 0;
    this._tick = this.tick.bind(this);
    this._raf = requestAnimationFrame(this._tick);
    window.addEventListener('clipwave:fonts', () => (this.dirty = true));
  }

  ensureAudio() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.master.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      for (const e of this.els.values()) this.wire(e);
    } catch {
      this.ctx = null;
    }
  }

  wire(e) {
    if (!this.ctx || e.node) return;
    try {
      e.node = this.ctx.createMediaElementSource(e.el);
      e.gain = this.ctx.createGain();
      e.node.connect(e.gain);
      e.gain.connect(this.master);
      e.el.muted = false;
    } catch {
      /* element already wired elsewhere */
    }
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  play() {
    if (this.playing) return;
    const p = this.getProject();
    const end = this.range ? this.range.end : projectDuration(p);
    if (this.time >= end - 0.01) this.time = this.range ? this.range.start : 0;
    this.ensureAudio();
    this.playing = true;
    this.clockStart = performance.now();
    this.timeStart = this.time;
    this.dispatchEvent(new Event('state'));
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    for (const e of this.els.values()) if (!e.el.paused) e.el.pause();
    this.dirty = true;
    this.dispatchEvent(new Event('state'));
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(t) {
    const p = this.getProject();
    this.time = Math.max(0, Math.min(t, Math.max(projectDuration(p), 0)));
    if (this.playing) {
      this.clockStart = performance.now();
      this.timeStart = this.time;
    }
    this.dirty = true;
    this.dispatchEvent(new Event('time'));
  }

  invalidate() {
    this.dirty = true;
  }

  element(clip) {
    let e = this.els.get(clip.id);
    const m = this.media.get(clip.mediaId);
    if (!m) return null;
    if (e && e.mediaId === clip.mediaId) return e;
    if (e) this.dropElement(clip.id);
    const el = document.createElement(clip.type === 'audio' ? 'audio' : 'video');
    el.preload = 'auto';
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    el.muted = !this.ctx;
    el.preservesPitch = false;
    el.src = m.url;
    el.addEventListener('seeked', () => (this.dirty = true));
    el.addEventListener('loadeddata', () => (this.dirty = true));
    e = { el, mediaId: clip.mediaId, gain: null, node: null };
    this.els.set(clip.id, e);
    this.wire(e);
    return e;
  }

  dropElement(id) {
    const e = this.els.get(id);
    if (!e) return;
    e.el.pause();
    try {
      e.node && e.node.disconnect();
      e.gain && e.gain.disconnect();
    } catch {
      /* ignore */
    }
    e.el.removeAttribute('src');
    e.el.load();
    this.els.delete(id);
  }

  frameFor(clip, st) {
    if (clip.type === 'image') {
      const bmp = this.media.bitmaps.get(clip.mediaId);
      if (!bmp) {
        this.media.bitmap(clip.mediaId).then(() => (this.dirty = true));
        return null;
      }
      return { image: bmp, w: bmp.width, h: bmp.height };
    }
    const e = this.els.get(clip.id);
    if (!e || e.el.readyState < 2 || !e.el.videoWidth) return null;
    return { image: e.el, w: e.el.videoWidth, h: e.el.videoHeight, dynamic: true };
  }

  // Window during which a clip's media must be live, including transition overlap.
  activeWindow(track, clip, i) {
    let start = clip.start;
    let end = clipEnd(clip);
    const own = transitionInfo(track, clip);
    if (own) start = own.start;
    const next = track.clips[i + 1];
    if (next) {
      const ni = transitionInfo(track, next);
      if (ni && ni.prev === clip) end = ni.end;
    }
    return [start, end];
  }

  sync() {
    const p = this.getProject();
    const t = this.time;
    const fps = p.fps || 30;
    const seen = new Set();
    for (const track of p.tracks) {
      if (track.type !== 'video' && track.type !== 'audio') continue;
      track.clips.forEach((clip, i) => {
        if (clip.type !== 'video' && clip.type !== 'audio') return;
        const m = this.media.get(clip.mediaId);
        if (!m) return;
        const [a, b] = this.activeWindow(track, clip, i);
        const near = t >= a - 2 && t < b + 0.5;
        if (!near) return;
        seen.add(clip.id);
        const e = this.element(clip);
        if (!e) return;
        const el = e.el;
        const dur = m.duration || el.duration || 0;
        const active = t >= a && t < b;
        const target = Math.max(0, Math.min(active ? sourceTime(clip, t) : clip.in || 0, Math.max(0, dur - 0.02)));
        el.playbackRate = Math.max(0.0625, Math.min(16, clip.speed || 1));
        if (active && this.playing) {
          if (el.paused) {
            if (Math.abs(el.currentTime - target) > 0.04) el.currentTime = target;
            const pr = el.play();
            if (pr && pr.catch) pr.catch(() => {});
          } else if (Math.abs(el.currentTime - target) > 0.3) el.currentTime = target;
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - target) > 0.5 / fps && !el.seeking) el.currentTime = target;
        }
        // Volume: clip volume (with keyframes) x fades x track mute.
        let vol = 0;
        if (active && !clip.muted && !track.muted) {
          const local = t - clip.start;
          vol = keyframeValue(clip.keyframes && clip.keyframes.volume, local, clip.volume ?? 1);
          if (clip.fadeIn > 0 && local < clip.fadeIn) vol *= Math.max(0, local / clip.fadeIn);
          const left = clipEnd(clip) - t;
          if (clip.fadeOut > 0 && left < clip.fadeOut) vol *= Math.max(0, left / clip.fadeOut);
        }
        if (e.gain) e.gain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.015);
        else el.volume = Math.max(0, Math.min(1, vol));
      });
    }
    for (const id of [...this.els.keys()]) if (!seen.has(id)) this.dropElement(id);
  }

  tick() {
    this._raf = requestAnimationFrame(this._tick);
    const p = this.getProject();
    if (!p) return;
    if (this.playing) {
      const end = this.range ? this.range.end : projectDuration(p);
      this.time = this.timeStart + ((performance.now() - this.clockStart) / 1000);
      if (this.time >= end) {
        if (this.loop && end > 0) {
          this.time = this.range ? this.range.start : 0;
          this.clockStart = performance.now();
          this.timeStart = this.time;
        } else {
          this.time = end;
          this.pause();
        }
      }
      this.dispatchEvent(new Event('time'));
      this.dirty = true;
    }
    this.sync();
    // While paused, keep drawing for a moment after changes so seeks and decodes land.
    const seeking = [...this.els.values()].some((e) => e.el.seeking);
    if (this.dirty || seeking) {
      this.dirty = false;
      try {
        this.renderer.render(p, this.time, this.frames);
      } catch (e) {
        console.error(e);
      }
      if ((this._gcCount = (this._gcCount || 0) + 1) % 300 === 0) this.renderer.gc();
    }
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    for (const id of [...this.els.keys()]) this.dropElement(id);
    if (this.ctx) this.ctx.close();
  }
}
