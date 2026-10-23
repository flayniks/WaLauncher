// Captions: automatic speech-to-text with Whisper running in the browser (transformers.js, Apache-2.0),
// plus SRT / VTT import and export.

import { makeClip, clipEnd } from './model.js';
import { insertTrack } from './ops.js';
import { mixAudio } from './engine/exporter.js';
import { projectDuration } from './model.js';
import { TEXT_TEMPLATES } from './templates.js';

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

export const WHISPER_MODELS = [
  ['Xenova/whisper-tiny', 'Fast (tiny, 40 MB)'],
  ['Xenova/whisper-base', 'Better (base, 75 MB)'],
  ['Xenova/whisper-small', 'Best (small, 250 MB)'],
];

export const LANGUAGES = [
  ['', 'Detect automatically'], ['english', 'English'], ['spanish', 'Spanish'], ['french', 'French'], ['german', 'German'], ['italian', 'Italian'],
  ['portuguese', 'Portuguese'], ['dutch', 'Dutch'], ['russian', 'Russian'], ['ukrainian', 'Ukrainian'], ['polish', 'Polish'], ['turkish', 'Turkish'],
  ['arabic', 'Arabic'], ['hindi', 'Hindi'], ['japanese', 'Japanese'], ['korean', 'Korean'], ['chinese', 'Chinese'], ['indonesian', 'Indonesian'], ['vietnamese', 'Vietnamese'],
];

let pipePromise = null;
let pipeModel = null;

async function getPipeline(model, onProgress) {
  if (pipePromise && pipeModel === model) return pipePromise;
  pipeModel = model;
  pipePromise = (async () => {
    const url = TRANSFORMERS_URL;
    const tf = await import(/* @vite-ignore */ url);
    tf.env.allowLocalModels = false;
    const device = navigator.gpu ? 'webgpu' : 'wasm';
    return tf.pipeline('automatic-speech-recognition', model, {
      device,
      dtype: device === 'webgpu' ? 'fp32' : 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) onProgress && onProgress(p.loaded / p.total, 'Downloading speech model');
      },
    });
  })();
  pipePromise.catch(() => (pipePromise = null));
  return pipePromise;
}

// Splits long segments into short caption lines, sharing the time by length.
function splitSegment(text, start, end, maxWords = 7) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return [{ text: words.join(' '), start, end }];
  const parts = [];
  for (let i = 0; i < words.length; i += maxWords) parts.push(words.slice(i, i + maxWords).join(' '));
  const total = parts.reduce((s, p) => s + p.length, 0);
  let t = start;
  return parts.map((p) => {
    const d = ((end - start) * p.length) / total;
    const out = { text: p, start: t, end: t + d };
    t += d;
    return out;
  });
}

export async function autoCaptions(app, { model, language, style, maxWords }, onProgress) {
  const p = app.store.project;
  const duration = projectDuration(p);
  if (!(duration > 0)) throw new Error('Add a clip with speech first.');
  onProgress(0, 'Collecting audio');
  const mix = await mixAudio(p, app.media, 0, duration, 16000, 1);
  const audio = mix.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < audio.length; i += 64) peak = Math.max(peak, Math.abs(audio[i]));
  if (peak < 0.005) throw new Error('The timeline has no audible sound to transcribe.');
  onProgress(0.02, 'Loading speech model');
  let asr;
  try {
    asr = await getPipeline(model, onProgress);
  } catch (e) {
    throw new Error('The speech model could not be downloaded. Check your connection. Sandboxed previews block it; the downloaded app works. (' + e.message + ')');
  }
  onProgress(0.5, 'Listening');
  const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, language: language || null, task: 'transcribe' });
  const chunks = out.chunks || [{ text: out.text, timestamp: [0, duration] }];
  const lines = [];
  for (const ch of chunks) {
    const [s, e] = ch.timestamp || [0, null];
    if (!ch.text || !ch.text.trim()) continue;
    const end = e == null ? Math.min(duration, s + 3) : e;
    lines.push(...splitSegment(ch.text, s, Math.max(end, s + 0.4), maxWords || 7));
  }
  if (!lines.length) throw new Error('No speech was found.');
  addCaptionClips(app, lines, style);
  onProgress(1, `Added ${lines.length} captions`);
  return lines.length;
}

export function addCaptionClips(app, lines, styleName = 'Subtitle') {
  const preset = TEXT_TEMPLATES.find((t) => t.name === styleName) || TEXT_TEMPLATES.find((t) => t.name === 'Subtitle');
  app.store.commit('Captions', (p) => {
    const track = insertTrack(p, 'text');
    track.name = 'Captions';
    let lastEnd = 0;
    for (const l of lines) {
      const start = Math.max(l.start, lastEnd);
      const dur = Math.max(0.2, l.end - start);
      const c = makeClip('text', { start, duration: dur });
      Object.assign(c.text, structuredClone(preset.text));
      c.text.content = l.text;
      c.text.wrap = 0.8;
      if (preset.text.anim && preset.text.anim.loop && preset.text.anim.loop.id === 'karaoke') c.text.anim = { loop: { id: 'karaoke', duration: dur } };
      if (preset.transform) Object.assign(c.transform, preset.transform);
      else c.transform.y = 0.36;
      track.clips.push(c);
      lastEnd = start + dur;
    }
  });
}

const parseTime = (s) => {
  const m = s.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3];
};

export function parseSubtitles(text) {
  const out = [];
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() && l.trim() !== 'WEBVTT');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const content = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (content) out.push({ start: parseTime(a), end: parseTime(z.split(' ').filter(Boolean)[0]), text: content });
  }
  return out;
}

const srtTime = (t) => {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};

export function toSrt(project) {
  const clips = [];
  for (const t of project.tracks) if (t.type === 'text') for (const c of t.clips) if (c.type === 'text') clips.push(c);
  clips.sort((a, b) => a.start - b.start);
  return clips.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(clipEnd(c))}\n${c.text.content}\n`).join('\n');
}
