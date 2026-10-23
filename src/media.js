// Imported media: probing, filmstrip thumbnails, waveform peaks, beat markers and storage.

import { Input, BlobSource, ALL_FORMATS, CanvasSink } from 'mediabunny';
import { db } from './db.js';
import { uid } from './model.js';

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ogv|3gp|ts|mts)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;

export function mediaKind(file) {
  const t = file.type || '';
  if (t.startsWith('video/') || VIDEO_EXT.test(file.name)) return 'video';
  if (t.startsWith('audio/') || AUDIO_EXT.test(file.name)) return 'audio';
  if (t.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image';
  return null;
}

let audioCtx = null;
function decodeCtx() {
  if (!audioCtx) audioCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, 48000);
  return audioCtx;
}

export class MediaLibrary extends EventTarget {
  constructor() {
    super();
    this.items = new Map();
    this.bitmaps = new Map();
    this.audio = new Map(); // id -> Promise<AudioBuffer|null>
  }

  get(id) {
    return this.items.get(id);
  }

  list() {
    return [...this.items.values()].sort((a, b) => b.added - a.added);
  }

  emit() {
    this.dispatchEvent(new Event('change'));
  }

  async load() {
    const rows = (await db.all('media')) || [];
    for (const row of rows) {
      if (!row || !row.blob) continue;
      const m = { ...row.meta, blob: row.blob, url: URL.createObjectURL(row.blob), status: 'ready' };
      this.items.set(m.id, m);
    }
    this.emit();
  }

  async importFiles(files) {
    const out = [];
    for (const file of files) {
      const type = mediaKind(file);
      if (!type) continue;
      const m = {
        id: uid(),
        name: file.name,
        type,
        mime: file.type,
        size: file.size,
        duration: type === 'image' ? 5 : 0,
        width: 0,
        height: 0,
        hasAudio: type === 'audio',
        hasVideo: type === 'video',
        thumbs: [],
        peaks: null,
        peaksRate: 50,
        beats: null,
        added: Date.now(),
        blob: file,
        url: URL.createObjectURL(file),
        status: 'loading',
      };
      this.items.set(m.id, m);
      out.push(m);
    }
    this.emit();
    await Promise.all(out.map((m) => this.analyze(m)));
    return out.filter((m) => m.status === 'ready');
  }

  // Adds a generated file (freeze frame, recording) as media.
  async addBlob(blob, name) {
    const file = new File([blob], name, { type: blob.type });
    const [m] = await this.importFiles([file]);
    return m;
  }

  async analyze(m) {
    try {
      if (m.type === 'image') await this.analyzeImage(m);
      else await this.analyzeAV(m);
      m.status = 'ready';
      this.emit();
      this.persist(m);
      if (m.hasAudio) this.analyzeAudio(m);
    } catch (e) {
      console.warn('Import failed', m.name, e);
      m.status = 'error';
      m.error = 'This file could not be read. Try MP4 (H.264), WebM, MP3, WAV, PNG or JPG.';
      this.emit();
    }
  }

  async analyzeImage(m) {
    const bmp = await createImageBitmap(m.blob);
    m.width = bmp.width;
    m.height = bmp.height;
    this.bitmaps.set(m.id, bmp);
    const c = document.createElement('canvas');
    const k = 160 / Math.max(bmp.width, bmp.height);
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    m.thumbs = [c.toDataURL('image/jpeg', 0.75)];
  }

  async analyzeAV(m) {
    let probed = false;
    try {
      const input = new Input({ source: new BlobSource(m.blob), formats: ALL_FORMATS });
      const vt = await input.getPrimaryVideoTrack();
      const at = await input.getPrimaryAudioTrack();
      m.duration = await input.computeDuration();
      m.hasVideo = !!vt;
      m.hasAudio = !!at;
      if (vt) {
        m.width = await vt.getDisplayWidth();
        m.height = await vt.getDisplayHeight();
        if (await vt.canDecode()) {
          const n = Math.max(4, Math.min(40, Math.ceil(m.duration / 1.5)));
          const times = [...Array(n).keys()].map((i) => (i + 0.5) * (m.duration / n));
          const sink = new CanvasSink(vt, { width: 160, poolSize: 0 });
          const thumbs = [];
          for await (const wc of sink.canvasesAtTimestamps(times)) thumbs.push(wc ? toJpeg(wc.canvas) : null);
          m.thumbs = thumbs.map((t, i) => t || thumbs.find(Boolean) || null).filter(Boolean);
          m.thumbTimes = times;
        }
      }
      probed = m.duration > 0;
      if (m.type === 'video' && !vt && at) m.type = 'audio';
    } catch (e) {
      console.info('Falling back to the browser to read', m.name, e.message);
    }
    if (!probed || (m.type === 'video' && !m.thumbs.length)) await this.analyzeWithElement(m);
    if (!(m.duration > 0)) throw new Error('no duration');
  }

  // Fallback when the container or codec is not supported by WebCodecs: let the media element decode it.
  async analyzeWithElement(m) {
    const el = document.createElement(m.type === 'audio' ? 'audio' : 'video');
    el.preload = 'auto';
    el.muted = true;
    el.src = m.url;
    await new Promise((res, rej) => {
      el.onloadedmetadata = res;
      el.onerror = () => rej(new Error('media element error'));
      setTimeout(() => rej(new Error('timeout')), 15000);
    });
    if (!(m.duration > 0)) m.duration = isFinite(el.duration) ? el.duration : 0;
    if (m.type === 'video') {
      m.width = el.videoWidth;
      m.height = el.videoHeight;
      if (!m.width) {
        m.type = 'audio';
        m.hasVideo = false;
        return;
      }
      const n = Math.max(4, Math.min(24, Math.ceil(m.duration / 2)));
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = Math.max(1, Math.round((160 * el.videoHeight) / el.videoWidth));
      const ctx = c.getContext('2d');
      m.thumbs = [];
      m.thumbTimes = [];
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) * (m.duration / n);
        await seekEl(el, t);
        ctx.drawImage(el, 0, 0, c.width, c.height);
        m.thumbs.push(c.toDataURL('image/jpeg', 0.7));
        m.thumbTimes.push(t);
      }
      if (!m.hasAudio) m.hasAudio = true; // the element can't tell; the decoder decides later
    }
    el.removeAttribute('src');
    el.load();
  }

  async analyzeAudio(m) {
    const buf = await this.audioBuffer(m.id);
    if (!buf) {
      m.hasAudio = false;
      this.emit();
      this.persist(m);
      return;
    }
    const rate = m.peaksRate;
    const win = Math.max(1, Math.floor(buf.sampleRate / rate));
    const n = Math.ceil(buf.length / win);
    const peaks = new Uint8Array(n);
    const chans = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chans.push(buf.getChannelData(c));
    for (let i = 0; i < n; i++) {
      let mx = 0;
      const end = Math.min(buf.length, (i + 1) * win);
      for (const d of chans) for (let j = i * win; j < end; j += 4) { const v = Math.abs(d[j]); if (v > mx) mx = v; }
      peaks[i] = Math.min(255, Math.round(Math.sqrt(mx) * 255));
    }
    m.peaks = Array.from(peaks);
    if (m.type === 'audio') m.beats = detectBeats(chans[0], buf.sampleRate);
    this.emit();
    this.persist(m);
  }

  audioBuffer(id) {
    if (this.audio.has(id)) return this.audio.get(id);
    const m = this.items.get(id);
    const p = (async () => {
      if (!m || !m.hasAudio) return null;
      try {
        const ab = await m.blob.arrayBuffer();
        return await decodeCtx().decodeAudioData(ab);
      } catch {
        return null;
      }
    })();
    this.audio.set(id, p);
    return p;
  }

  async bitmap(id) {
    if (this.bitmaps.has(id)) return this.bitmaps.get(id);
    const m = this.items.get(id);
    if (!m) return null;
    const bmp = await createImageBitmap(m.blob);
    this.bitmaps.set(id, bmp);
    return bmp;
  }

  persist(m) {
    // eslint-disable-next-line no-unused-vars
    const { blob, url, status, error, ...meta } = m;
    db.put('media', { id: m.id, meta, blob });
  }

  remove(id) {
    const m = this.items.get(id);
    if (!m) return;
    URL.revokeObjectURL(m.url);
    this.items.delete(id);
    this.bitmaps.delete(id);
    this.audio.delete(id);
    db.del('media', id);
    this.emit();
  }
}

function toJpeg(canvas) {
  if (canvas instanceof HTMLCanvasElement) return canvas.toDataURL('image/jpeg', 0.72);
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  c.getContext('2d').drawImage(canvas, 0, 0);
  return c.toDataURL('image/jpeg', 0.72);
}

export function seekEl(el, t) {
  return new Promise((res) => {
    if (Math.abs(el.currentTime - t) < 0.001 && el.readyState >= 2) return res();
    const done = () => {
      el.removeEventListener('seeked', done);
      res();
    };
    el.addEventListener('seeked', done);
    el.currentTime = t;
    setTimeout(done, 3000);
  });
}

// Simple onset detector: energy jumps against a moving average, at least 0.28s apart.
function detectBeats(data, sampleRate) {
  const hop = Math.floor(sampleRate / 100);
  const n = Math.floor(data.length / hop);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop; j < (i + 1) * hop; j += 2) s += data[j] * data[j];
    e[i] = Math.sqrt(s / (hop / 2));
  }
  const beats = [];
  let last = -1;
  const W = 40;
  for (let i = 1; i < n; i++) {
    let avg = 0;
    const a = Math.max(0, i - W);
    for (let j = a; j < i; j++) avg += e[j];
    avg /= Math.max(1, i - a);
    const flux = e[i] - e[i - 1];
    if (e[i] > avg * 1.45 && flux > 0.02 && e[i] > 0.04 && (last < 0 || i - last > 28)) {
      beats.push(+(i / 100).toFixed(3));
      last = i;
    }
  }
  return beats;
}
