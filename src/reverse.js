// Reverse: renders a backwards copy of a video file (picture and sound) and swaps it into the clip.
// Frames are decoded one second at a time from the end, so memory stays small.

import {
  Input, BlobSource, ALL_FORMATS, CanvasSink, Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat,
  CanvasSource, AudioBufferSource, getFirstEncodableVideoCodec, getFirstEncodableAudioCodec, QUALITY_HIGH,
} from 'mediabunny';

const CHUNK = 1;

async function pickFormat(w, h) {
  for (const format of [new Mp4OutputFormat({ fastStart: 'in-memory' }), new WebMOutputFormat()]) {
    const codec = await getFirstEncodableVideoCodec(format.getSupportedVideoCodecs().filter((c) => ['avc', 'vp9', 'av1', 'vp8', 'hevc'].includes(c)), { width: w, height: h });
    if (codec) return { format, codec };
  }
  return null;
}

export async function reverseMedia(lib, m, onProgress, signal) {
  const input = new Input({ source: new BlobSource(m.blob), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt || !(await vt.canDecode())) throw new Error('This browser cannot decode that video, so it cannot be reversed.');
  const duration = await input.computeDuration();
  const dw = await vt.getDisplayWidth(), dh = await vt.getDisplayHeight();
  const k = Math.min(1, 1920 / Math.max(dw, dh));
  const W = Math.max(2, Math.round((dw * k) / 2) * 2), H = Math.max(2, Math.round((dh * k) / 2) * 2);
  const picked = await pickFormat(W, H);
  if (!picked) throw new Error('This browser cannot encode video.');
  const { format, codec } = picked;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const output = new Output({ format, target: new BufferTarget() });
  const vs = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH, keyFrameInterval: 1 });
  output.addVideoTrack(vs);
  let as = null;
  const buf = m.hasAudio ? await lib.audioBuffer(m.id) : null;
  if (buf) {
    const ac = await getFirstEncodableAudioCodec(format.getSupportedAudioCodecs().filter((c) => ['aac', 'opus', 'vorbis'].includes(c)), { numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
    if (ac) {
      as = new AudioBufferSource({ codec: ac, bitrate: QUALITY_HIGH });
      output.addAudioTrack(as);
    }
  }
  await output.start();
  try {
    if (as) {
      const rev = new AudioBuffer({ length: buf.length, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
      for (let c = 0; c < buf.numberOfChannels; c++) rev.copyToChannel(buf.getChannelData(c).slice().reverse(), c);
      await as.add(rev);
      as.close();
    }
    const sink = new CanvasSink(vt, { width: W, height: H, fit: 'fill', poolSize: 0 });
    let end = duration;
    while (end > 0) {
      if (signal && signal.aborted) throw new DOMException('Canceled', 'AbortError');
      const start = Math.max(0, end - CHUNK);
      const frames = [];
      for await (const wc of sink.canvases(start, end)) frames.push(wc);
      for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i];
        const ts = Math.max(0, duration - (f.timestamp + f.duration));
        ctx.drawImage(f.canvas, 0, 0, W, H);
        await vs.add(ts, f.duration);
      }
      end = start;
      onProgress && onProgress(1 - end / duration);
    }
    vs.close();
    await output.finalize();
  } catch (e) {
    try {
      await output.cancel();
    } catch {
      /* ignore */
    }
    throw e;
  }
  const blob = new Blob([output.target.buffer], { type: format.mimeType });
  const base = m.name.replace(/\.[^.]+$/, '');
  const made = await lib.addBlob(blob, `${base} (reversed)${format.fileExtension}`);
  if (!made) throw new Error('The reversed copy could not be read back.');
  made.reverseOf = m.id;
  m.reversedId = made.id;
  lib.persist(made);
  lib.persist(m);
  return made;
}

// Points a clip at the reversed copy (or back at the original), keeping the same stretch of picture on screen.
export function swapToReversed(clip, from, to) {
  const used = clip.duration * (clip.speed || 1);
  clip.in = Math.max(0, (from.duration || to.duration) - ((clip.in || 0) + used));
  clip.mediaId = to.id;
  if (clip.stab) clip.stab = null;
}
