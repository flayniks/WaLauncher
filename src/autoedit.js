// One-click edits that need no AI service: jump-cut silences, cut clips to the beat of a song, and build a
// highlight reel from the loudest, busiest moments.

import { Input, BlobSource, ALL_FORMATS, CanvasSink } from 'mediabunny';
import { makeClip, clipEnd, mainTrack, findClip, uid } from './model.js';

// Loudness envelope of a decoded buffer: RMS per `hop` seconds, mixed to mono.
function envelope(buf, hop = 0.01) {
  const step = Math.max(1, Math.round(buf.sampleRate * hop));
  const n = Math.floor(buf.length / step);
  const out = new Float32Array(n);
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const d of chans) for (let j = i * step; j < (i + 1) * step; j += 2) s += d[j] * d[j];
    out[i] = Math.sqrt(s / ((step / 2) * chans.length));
  }
  return { env: out, hop: step / buf.sampleRate };
}

const percentile = (arr, p) => {
  const a = Array.from(arr).sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))] || 0;
};

// Source-time ranges with speech or sound in them.
export function findSpeech(buf, from, to, { threshold = -32, minSilence = 0.45, padding = 0.1 } = {}) {
  const { env, hop } = envelope(buf);
  const a = Math.floor(from / hop), b = Math.min(env.length, Math.ceil(to / hop));
  const slice = env.subarray(a, b);
  const loud = percentile(slice, 0.95) || 1e-6;
  const limit = loud * Math.pow(10, threshold / 20);
  const ranges = [];
  let start = null, quiet = 0;
  for (let i = 0; i < slice.length; i++) {
    const t = (a + i) * hop;
    if (slice[i] >= limit) {
      if (start === null) start = t;
      quiet = 0;
    } else if (start !== null) {
      quiet += hop;
      if (quiet >= minSilence) {
        ranges.push([start, t - quiet + hop]);
        start = null;
        quiet = 0;
      }
    }
  }
  if (start !== null) ranges.push([start, Math.min(to, (a + slice.length) * hop)]);
  // Pad each range and merge ranges that now touch.
  const padded = [];
  for (const [s, e] of ranges) {
    const ps = Math.max(from, s - padding), pe = Math.min(to, e + padding);
    if (pe - ps < 0.12) continue;
    if (padded.length && ps <= padded[padded.length - 1][1]) padded[padded.length - 1][1] = pe;
    else padded.push([ps, pe]);
  }
  return padded;
}

// Cuts the quiet parts out of a video or audio clip and closes the gaps.
export async function removeSilences(app, clipId, opts = {}) {
  const f = findClip(app.store.project, clipId);
  if (!f || (f.clip.type !== 'video' && f.clip.type !== 'audio')) throw new Error('Pick a video or audio clip with speech in it.');
  const m = app.media.get(f.clip.mediaId);
  if (!m || !m.hasAudio) throw new Error('That clip has no sound to listen to.');
  const buf = await app.media.audioBuffer(m.id);
  if (!buf) throw new Error('The sound in that clip could not be decoded.');
  const c = f.clip;
  const speed = c.speed || 1;
  const from = c.in || 0, to = from + c.duration * speed;
  const keep = findSpeech(buf, from, to, opts);
  if (!keep.length) throw new Error('The whole clip is quiet at this setting. Lower the threshold.');
  const kept = keep.reduce((s, [a, b]) => s + (b - a), 0) / speed;
  const removed = c.duration - kept;
  if (removed < 0.2) return { removed: 0, cuts: 0 };
  app.store.commit('Remove silences', (p) => {
    const ff = findClip(p, clipId);
    if (!ff) return;
    const orig = ff.clip;
    const parts = keep.map(([a, b], i) => {
      const part = structuredClone(orig);
      part.id = i === 0 ? orig.id : uid();
      part.in = a;
      part.duration = (b - a) / speed;
      part.transitionIn = i === 0 ? orig.transitionIn : null;
      part.keyframes = {};
      if (i > 0) part.fadeIn = 0;
      if (i < keep.length - 1) part.fadeOut = 0;
      return part;
    });
    let t = orig.start;
    for (const part of parts) {
      part.start = t;
      t += part.duration;
    }
    // Later clips on the same track move left by what was removed.
    for (const other of ff.track.clips) if (other !== orig && other.start >= clipEnd(orig) - 1e-6) other.start -= removed;
    ff.track.clips.splice(ff.index, 1, ...parts);
  });
  return { removed, cuts: keep.length - 1 };
}

// Beat times on the timeline from the first music clip that has beats (or a given one).
function timelineBeats(app, musicClipId) {
  const p = app.store.project;
  for (const t of p.tracks) {
    if (t.type !== 'audio') continue;
    for (const c of t.clips) {
      if (musicClipId && c.id !== musicClipId) continue;
      const m = app.media.get(c.mediaId);
      if (!m || !m.beats || m.beats.length < 4) continue;
      const beats = m.beats.map((b) => c.start + (b - (c.in || 0)) / (c.speed || 1)).filter((x) => x >= c.start && x <= clipEnd(c));
      return { clip: c, beats };
    }
  }
  return null;
}

// Rebuilds the main track as quick cuts landing on the song's beats.
export function cutToBeat(app, { beatsPerCut = 2, mediaIds = null, transition = null } = {}) {
  const found = timelineBeats(app);
  if (!found) throw new Error('Add a song first (Search > Songs, or import one). Clipwave finds its beats.');
  let pool = (mediaIds || []).map((id) => app.media.get(id)).filter(Boolean);
  if (!pool.length) {
    const main = mainTrack(app.store.project);
    const onMain = [...new Set(main.clips.map((c) => c.mediaId).filter(Boolean))].map((id) => app.media.get(id)).filter(Boolean);
    pool = onMain.length ? onMain : app.media.list().filter((m) => m.status === 'ready' && (m.type === 'video' || m.type === 'image'));
  }
  pool = pool.filter((m) => m.type === 'video' || m.type === 'image');
  if (!pool.length) throw new Error('Import some videos or photos to cut.');
  const beats = found.beats;
  const cuts = [found.clip.start];
  for (let i = beatsPerCut; i < beats.length; i += beatsPerCut) cuts.push(beats[i]);
  const end = clipEnd(found.clip);
  if (end - cuts[cuts.length - 1] > 0.2) cuts.push(end);
  const used = new Map(); // media id -> next source time
  app.store.commit('Cut to the beat', (p) => {
    const main = mainTrack(p);
    main.clips = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const m = pool[i % pool.length];
      const dur = cuts[i + 1] - cuts[i];
      if (dur < 0.05) continue;
      let c;
      if (m.type === 'image') c = makeClip('image', { mediaId: m.id, start: cuts[i], duration: dur, name: m.name });
      else {
        // Walk through each video so repeats show new moments.
        let src = used.get(m.id) ?? Math.min(m.duration * 0.15, Math.max(0, m.duration - dur));
        if (src + dur > m.duration) src = 0;
        c = makeClip('video', { mediaId: m.id, start: cuts[i], duration: Math.min(dur, m.duration), in: src, name: m.name, muted: true });
        used.set(m.id, src + dur);
      }
      if (transition && i > 0) c.transitionIn = { id: transition, duration: Math.min(0.3, dur / 2) };
      main.clips.push(c);
    }
    p.magnet = true;
  });
  return { cuts: cuts.length - 1, beats: beats.length };
}

// How lively each second of a video is: loudness plus picture change.
async function liveliness(app, m) {
  const secs = Math.max(1, Math.floor(m.duration));
  const score = new Float32Array(secs);
  if (m.hasAudio) {
    const buf = await app.media.audioBuffer(m.id);
    if (buf) {
      const { env, hop } = envelope(buf, 0.05);
      const per = Math.round(1 / hop);
      const loud = percentile(env, 0.98) || 1;
      for (let s = 0; s < secs; s++) {
        let sum = 0;
        for (let j = s * per; j < Math.min(env.length, (s + 1) * per); j++) sum += env[j];
        score[s] += Math.min(1, sum / per / loud);
      }
    }
  }
  try {
    const input = new Input({ source: new BlobSource(m.blob), formats: ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack();
    if (vt && (await vt.canDecode())) {
      const sink = new CanvasSink(vt, { width: 48, height: 27, fit: 'fill', poolSize: 0 });
      const times = [...Array(secs * 2).keys()].map((i) => i / 2 + 0.25);
      let prev = null, i = 0;
      for await (const wc of sink.canvasesAtTimestamps(times)) {
        const t = times[i++];
        if (!wc) continue;
        const d = wc.canvas.getContext('2d').getImageData(0, 0, 48, 27).data;
        if (prev) {
          let diff = 0;
          for (let k = 0; k < d.length; k += 4) diff += Math.abs(d[k] - prev[k]) + Math.abs(d[k + 1] - prev[k + 1]) + Math.abs(d[k + 2] - prev[k + 2]);
          score[Math.min(secs - 1, Math.floor(t))] += Math.min(1, diff / (48 * 27 * 3 * 40));
        }
        prev = d;
      }
    }
  } catch {
    /* sound alone decides */
  }
  return score;
}

// Picks the liveliest moments across the videos and lays them out on a fresh main track.
export async function highlightReel(app, { length = 30, piece = 2.5, onProgress } = {}) {
  let pool = app.media.list().filter((m) => m.status === 'ready' && m.type === 'video');
  const main = mainTrack(app.store.project);
  const onMain = new Set(main.clips.map((c) => c.mediaId));
  if (main.clips.length) pool = pool.filter((m) => onMain.has(m.id));
  if (!pool.length) throw new Error('Import some videos first.');
  const candidates = [];
  for (let k = 0; k < pool.length; k++) {
    const m = pool[k];
    onProgress && onProgress(k / pool.length, 'Watching ' + m.name);
    const s = await liveliness(app, m);
    const w = Math.max(1, Math.round(piece));
    for (let i = 0; i + w <= s.length; i++) {
      let sum = 0;
      for (let j = i; j < i + w; j++) sum += s[j];
      candidates.push({ m, at: i, score: sum / w });
    }
    if (m.duration < piece) candidates.push({ m, at: 0, score: 0.5 });
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked = [];
  let total = 0;
  for (const c of candidates) {
    if (total >= length) break;
    if (picked.some((p) => p.m === c.m && Math.abs(p.at - c.at) < piece)) continue;
    picked.push(c);
    total += Math.min(piece, c.m.duration);
  }
  // Keep the story in order: by file, then by time within it.
  picked.sort((a, b) => pool.indexOf(a.m) - pool.indexOf(b.m) || a.at - b.at);
  app.store.commit('Highlight reel', (p) => {
    const mt = mainTrack(p);
    mt.clips = [];
    let t = 0;
    picked.forEach((c, i) => {
      const dur = Math.min(piece, c.m.duration - c.at);
      const clip = makeClip('video', { mediaId: c.m.id, start: t, duration: dur, in: c.at, name: c.m.name });
      if (i > 0) clip.transitionIn = { id: 'fade', duration: 0.3 };
      mt.clips.push(clip);
      t += dur;
    });
    p.magnet = true;
  });
  onProgress && onProgress(1, 'Done');
  return { pieces: picked.length, seconds: total };
}

