// Frame-exact export. Video frames are decoded with WebCodecs (through Mediabunny), every frame is rendered
// by the same compositor as the preview, and the result is encoded to MP4 or WebM. Audio is mixed offline.

import {
  Input, BlobSource, ALL_FORMATS, CanvasSink, Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat,
  CanvasSource, AudioBufferSource, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
} from 'mediabunny';
import { Renderer } from './renderer.js';
import { clipEnd, sourceTime, transitionInfo, projectDuration } from '../model.js';
import { keyframeValue } from './animation.js';
import { seekEl } from '../media.js';
import { loadProjectFonts } from './text.js';
import { loadMatte } from '../ai.js';

export const RESOLUTIONS = [
  ['480p', 480],
  ['720p', 720],
  ['1080p', 1080],
  ['1440p (2K)', 1440],
  ['2160p (4K)', 2160],
];

// Output size for a project at a given short-side resolution, rounded to even numbers for the encoder.
export function exportSize(project, shortSide) {
  const ar = project.width / project.height;
  let w, h;
  if (ar >= 1) {
    h = shortSide;
    w = Math.round(h * ar);
  } else {
    w = shortSide;
    h = Math.round(w / ar);
  }
  return [w + (w % 2), h + (h % 2)];
}

// Clips whose pictures are needed at time t, with the source time for each.
function neededAt(project, t) {
  const out = [];
  const main = project.tracks.find((tr) => tr.main);
  for (const track of project.tracks) {
    if (track.type !== 'video') continue;
    const bgBlur = track === main && project.background && project.background.type === 'blur';
    if (track.hidden && !bgBlur) continue;
    track.clips.forEach((clip, i) => {
      if (clip.type !== 'video') return;
      let a = clip.start, b = clipEnd(clip);
      const own = transitionInfo(track, clip);
      if (own) a = own.start;
      const next = track.clips[i + 1];
      if (next) {
        const ni = transitionInfo(track, next);
        if (ni && ni.prev === clip) b = ni.end;
      }
      if (t >= a && t < b) out.push({ clip, st: sourceTime(clip, t) });
    });
  }
  return out;
}

class SinkProvider {
  constructor(sink, times) {
    this.it = sink.canvasesAtTimestamps(times)[Symbol.asyncIterator]();
    this.last = null;
  }
  async next() {
    const r = await this.it.next();
    if (!r.done && r.value) this.last = { image: r.value.canvas, w: r.value.canvas.width, h: r.value.canvas.height };
    return this.last;
  }
  async close() {
    try {
      await this.it.return?.();
    } catch {
      /* ignore */
    }
  }
}

// Fallback for media WebCodecs can't read: seek a video element for every frame.
class SeekProvider {
  constructor(url, duration, times) {
    this.times = times;
    this.i = 0;
    this.duration = duration;
    this.el = document.createElement('video');
    this.el.muted = true;
    this.el.preload = 'auto';
    this.el.src = url;
  }
  async next() {
    const t = this.times[this.i++];
    if (this.el.readyState < 1) {
      await new Promise((resolve, reject) => {
        this.el.addEventListener('loadedmetadata', resolve, { once: true });
        this.el.addEventListener('error', () => reject(new Error('This browser cannot decode one of the videos on the timeline.')), { once: true });
        setTimeout(() => reject(new Error('A video on the timeline did not load in time.')), 15000);
      });
    }
    await seekEl(this.el, Math.min(Math.max(0, t), Math.max(0, (this.duration || this.el.duration) - 0.03)));
    return { image: this.el, w: this.el.videoWidth, h: this.el.videoHeight, dynamic: true };
  }
  async close() {
    this.el.removeAttribute('src');
    this.el.load();
  }
}

export async function exportProject(project, media, opts, onProgress, signal) {
  const fps = opts.fps || project.fps || 30;
  const [W, H] = exportSize(project, opts.resolution || 1080);
  const start = Math.max(0, opts.start || 0);
  const end = Math.min(projectDuration(project), opts.end ?? Infinity);
  const duration = end - start;
  if (!(duration > 0)) throw new Error('The timeline is empty. Add a clip first.');
  const frameCount = Math.max(1, Math.round(duration * fps));
  const audioOnly = opts.format === 'wav';

  if (audioOnly) {
    onProgress && onProgress(0.1, 'Mixing audio');
    const mix = await mixAudio(project, media, start, duration, 48000);
    onProgress && onProgress(1, 'Done');
    return { blob: audioBufferToWav(mix), ext: 'wav', mime: 'audio/wav' };
  }

  const format = opts.format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' });
  const preferred = opts.format === 'webm' ? ['vp9', 'av1', 'vp8'] : ['avc', 'hevc', 'vp9', 'av1'];
  const supported = format.getSupportedVideoCodecs();
  const videoCodec = await getFirstEncodableVideoCodec(preferred.filter((c) => supported.includes(c)), { width: W, height: H });
  if (!videoCodec) throw new Error('This browser cannot encode video at this size. Try a lower resolution, or the latest Chrome or Edge.');
  const audioPreferred = opts.format === 'webm' ? ['opus', 'vorbis'] : ['aac', 'opus'];
  const audioCodec = await getFirstEncodableAudioCodec(audioPreferred.filter((c) => format.getSupportedAudioCodecs().includes(c)), { numberOfChannels: 2, sampleRate: 48000 });

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const renderer = new Renderer(canvas, { preserveDrawingBuffer: true });
  const output = new Output({ format, target: new BufferTarget() });
  const bitrate = Math.round(W * H * fps * ({ low: 0.05, medium: 0.09, high: 0.14, max: 0.22 }[opts.quality || 'high']));
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate, keyFrameInterval: 2, latencyMode: 'quality' });
  output.addVideoTrack(videoSource, { frameRate: fps });
  let audioSource = null;
  if (audioCodec && opts.audio !== false) {
    audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 192000 });
    output.addAudioTrack(audioSource);
  }

  const providers = new Map();
  const cleanup = async () => {
    for (const p of providers.values()) await p.close();
    renderer.dispose();
  };

  try {
    await output.start();

    // Plan which source times each clip needs, frame by frame.
    onProgress && onProgress(0, 'Preparing');
    await loadProjectFonts(project);
    if (project.tracks.some((t) => !t.hidden && t.clips.some((c) => c.cutout && c.cutout.mode && c.cutout.mode !== 'off'))) {
      onProgress && onProgress(0, 'Loading background removal');
      await loadMatte();
    }
    const plan = new Map();
    for (let i = 0; i < frameCount; i++) {
      const t = start + i / fps;
      for (const n of neededAt(project, t)) {
        if (!plan.has(n.clip.id)) plan.set(n.clip.id, { clip: n.clip, times: [] });
        const list = plan.get(n.clip.id).times;
        const m = media.get(n.clip.mediaId);
        const st = Math.max(0, Math.min(n.st, (m ? m.duration : n.st) - 0.001));
        list.push(Math.max(st, list.length ? list[list.length - 1] : 0));
      }
    }
    for (const { clip, times } of plan.values()) {
      const m = media.get(clip.mediaId);
      if (!m || m.status === 'error') continue;
      let provider = null;
      try {
        const input = new Input({ source: new BlobSource(m.blob), formats: ALL_FORMATS });
        const vt = await input.getPrimaryVideoTrack();
        if (vt && (await vt.canDecode())) {
          const maxSide = Math.max(W, H);
          const w = await vt.getDisplayWidth(), h = await vt.getDisplayHeight();
          const k = Math.min(1, maxSide / Math.max(w, h));
          provider = new SinkProvider(new CanvasSink(vt, { width: Math.max(2, Math.round(w * k)), height: Math.max(2, Math.round(h * k)), fit: 'fill' }), times);
        }
      } catch {
        provider = null;
      }
      providers.set(clip.id, provider || new SeekProvider(m.url, m.duration, times));
    }
    for (const m of media.items.values()) if (m.type === 'image') await media.bitmap(m.id);

    // Audio first, so a failure there shows up before the long video pass.
    if (audioSource) {
      onProgress && onProgress(0.01, 'Mixing audio');
      const mix = await mixAudio(project, media, start, duration, 48000);
      const chunk = 48000;
      for (let off = 0; off < mix.length; off += chunk) {
        const len = Math.min(chunk, mix.length - off);
        const part = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: 48000 });
        for (let c = 0; c < 2; c++) part.copyToChannel(mix.getChannelData(c).subarray(off, off + len), c);
        await audioSource.add(part);
        if (signal && signal.aborted) throw new DOMException('Export canceled', 'AbortError');
      }
      audioSource.close();
    }

    const current = new Map();
    const frames = {
      get: (clip) => {
        if (clip.type === 'image') {
          const bmp = media.bitmaps.get(clip.mediaId);
          return bmp ? { image: bmp, w: bmp.width, h: bmp.height } : null;
        }
        return current.get(clip.id) || null;
      },
    };
    const t0 = performance.now();
    for (let i = 0; i < frameCount; i++) {
      if (signal && signal.aborted) throw new DOMException('Export canceled', 'AbortError');
      const t = start + i / fps;
      for (const n of neededAt(project, t)) {
        const p = providers.get(n.clip.id);
        if (p) current.set(n.clip.id, await p.next());
      }
      renderer.render(project, t, frames);
      await videoSource.add(i / fps, 1 / fps);
      if (i % 5 === 0 || i === frameCount - 1) {
        const done = (i + 1) / frameCount;
        const elapsed = (performance.now() - t0) / 1000;
        const eta = done > 0.02 ? (elapsed / done) * (1 - done) : null;
        onProgress && onProgress(done, 'Rendering', eta);
      }
      if (i % 60 === 0) renderer.gc();
    }
    videoSource.close();
    onProgress && onProgress(1, 'Finishing');
    await output.finalize();
    await cleanup();
    const mime = await output.getMimeType();
    const blob = new Blob([output.target.buffer], { type: mime.split(';')[0] });
    return { blob, ext: format.fileExtension.replace('.', ''), mime: blob.type, codec: videoCodec, audioCodec, width: W, height: H };
  } catch (e) {
    try {
      await output.cancel();
    } catch {
      /* ignore */
    }
    await cleanup();
    throw e;
  }
}

// Renders every audible clip into one stereo buffer.
export async function mixAudio(project, media, start, duration, sampleRate = 48000, channels = 2) {
  const length = Math.max(1, Math.ceil(duration * sampleRate));
  const ctx = new OfflineAudioContext(channels, length, sampleRate);
  for (const track of project.tracks) {
    if ((track.type !== 'video' && track.type !== 'audio') || track.muted) continue;
    for (const clip of track.clips) {
      if ((clip.type !== 'video' && clip.type !== 'audio') || clip.muted) continue;
      const cs = clip.start, ce = clipEnd(clip);
      if (ce <= start || cs >= start + duration) continue;
      const m = media.get(clip.mediaId);
      if (!m || !m.hasAudio || m.status === 'error') continue;
      const buf = await media.audioBuffer(m.id);
      if (!buf) continue;
      const speed = clip.speed || 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = speed;
      const gain = ctx.createGain();
      src.connect(gain);
      gain.connect(ctx.destination);
      const from = Math.max(cs, start);
      const to = Math.min(ce, start + duration);
      const when = from - start;
      const offset = sourceTime(clip, from);
      // Volume envelope, sampled every 20ms so keyframes and fades both apply.
      const steps = Math.max(2, Math.ceil((to - from) / 0.02));
      const curve = new Float32Array(steps + 1);
      for (let k = 0; k <= steps; k++) {
        const tt = from + ((to - from) * k) / steps;
        const local = tt - cs;
        let v = keyframeValue(clip.keyframes && clip.keyframes.volume, local, clip.volume ?? 1);
        if (clip.fadeIn > 0 && local < clip.fadeIn) v *= Math.max(0, local / clip.fadeIn);
        if (clip.fadeOut > 0 && ce - tt < clip.fadeOut) v *= Math.max(0, (ce - tt) / clip.fadeOut);
        curve[k] = v;
      }
      gain.gain.setValueCurveAtTime(curve, when, Math.max(0.001, to - from));
      if (offset < buf.duration) src.start(when, offset, (to - from) * speed);
    }
  }
  return ctx.startRendering();
}

export function audioBufferToWav(buf) {
  const ch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  out.setUint32(4, 36 + n * ch * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, sr, true);
  out.setUint32(28, sr * ch * 2, true);
  out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true);
  w(36, 'data');
  out.setUint32(40, n * ch * 2, true);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}
