// Editing operations used by the toolbar, menus, shortcuts and library panels.

import { makeClip, makeTrack, clipEnd, mainTrack, findClip, uid, trackTypeFor, projectDuration } from './model.js';
import { effectById, defaultParams } from './engine/effects.js';
import { defaultAnimDuration, animById } from './engine/animation.js';

const overlaps = (track, start, end, ignoreId) => track.clips.some((c) => c.id !== ignoreId && c.start < end - 1e-6 && clipEnd(c) > start + 1e-6);

// Inserts a new track of a type where that type belongs in the stack.
export function insertTrack(project, type) {
  const t = makeTrack(type, { keep: true });
  const tracks = project.tracks;
  if (type === 'text') tracks.unshift(t);
  else if (type === 'audio') tracks.push(t);
  else if (type === 'effect') {
    const firstVideo = tracks.findIndex((x) => x.type === 'video');
    tracks.splice(Math.max(0, firstVideo), 0, t);
  } else {
    const firstVideo = tracks.findIndex((x) => x.type === 'video');
    tracks.splice(Math.max(0, firstVideo), 0, t);
  }
  return t;
}

export function trackWithSpace(project, type, start, end, { allowMain = false } = {}) {
  for (const t of project.tracks) {
    if (t.type !== type || t.locked) continue;
    if (t.main && !allowMain) continue;
    if (!overlaps(t, start, end)) return t;
  }
  return insertTrack(project, type);
}

function clipFromMedia(m) {
  if (m.type === 'image') return makeClip('image', { mediaId: m.id, duration: 5, name: m.name });
  if (m.type === 'audio') return makeClip('audio', { mediaId: m.id, duration: m.duration, name: m.name });
  return makeClip('video', { mediaId: m.id, duration: m.duration, name: m.name });
}

// Adds media at time t. Video and images go to the main track (after the clip under the playhead),
// audio to the first free audio track.
export function addMedia(store, m, t, opts = {}) {
  if (!m || m.status !== 'ready') return null;
  let created = null;
  store.commit('Add ' + m.name, (p) => {
    const c = clipFromMedia(m);
    created = c;
    if (m.type === 'audio') {
      c.start = t;
      trackWithSpace(p, 'audio', t, t + c.duration).clips.push(c);
      return;
    }
    if (opts.overlay) {
      c.start = t;
      trackWithSpace(p, 'video', t, t + c.duration).clips.push(c);
      return;
    }
    const main = mainTrack(p);
    if (p.magnet) {
      const under = main.clips.find((x) => t >= x.start && t < clipEnd(x));
      const at = under ? (t - under.start < under.duration / 2 ? under.start : clipEnd(under)) : Math.max(0, projectEndOf(main));
      c.start = at - 0.0001;
      for (const x of main.clips) if (x.start >= at - 1e-6) x.start += c.duration;
      main.clips.push(c);
    } else {
      c.start = t;
      if (overlaps(main, t, t + c.duration)) trackWithSpace(p, 'video', t, t + c.duration).clips.push(c);
      else main.clips.push(c);
    }
  });
  if (created) store.select(created.id);
  return created;
}

const projectEndOf = (track) => track.clips.reduce((mx, c) => Math.max(mx, clipEnd(c)), 0);

// Places a clip from a drag and drop onto a specific track at a time.
export function dropMedia(store, m, trackId, t) {
  if (!m || m.status !== 'ready') return null;
  let created = null;
  store.commit('Add ' + m.name, (p) => {
    const c = clipFromMedia(m);
    created = c;
    c.start = Math.max(0, t);
    let track = trackId ? p.tracks.find((x) => x.id === trackId) : null;
    const want = trackTypeFor(c.type);
    if (!track || track.type !== want || track.locked) track = null;
    if (track && track.main && p.magnet) {
      // Insert at the nearest cut.
      let at = projectEndOf(track);
      for (const x of track.clips) {
        if (t < x.start + x.duration / 2) { at = x.start; break; }
      }
      c.start = at - 0.0001;
      for (const x of track.clips) if (x.start >= at - 1e-6) x.start += c.duration;
      track.clips.push(c);
      return;
    }
    if (!track || overlaps(track, c.start, c.start + c.duration)) track = trackWithSpace(p, want, c.start, c.start + c.duration, { allowMain: !p.magnet });
    track.clips.push(c);
  });
  if (created) store.select(created.id);
  return created;
}

export function addClipOfType(store, type, t, props = {}, label = 'Add') {
  let created = null;
  store.commit(label, (p) => {
    const c = makeClip(type, { start: t, ...props });
    created = c;
    trackWithSpace(p, trackTypeFor(type), t, t + c.duration).clips.push(c);
  });
  if (created) store.select(created.id);
  return created;
}

export function addText(store, t, preset) {
  const props = { duration: preset && preset.duration ? preset.duration : 3 };
  const c = addClipOfType(store, 'text', t, props, 'Add text');
  if (preset) {
    store.commit('Text style', (p) => {
      const f = findClip(p, c.id);
      if (!f) return;
      Object.assign(f.clip.text, structuredClone(preset.text || {}));
      if (preset.anim) f.clip.anim = structuredClone(preset.anim);
      if (preset.transform) Object.assign(f.clip.transform, preset.transform);
      if (preset.effects) f.clip.effects = structuredClone(preset.effects);
      if (preset.name) f.clip.name = '';
    });
  }
  return c;
}

export function addEffectClip(store, effectId, t) {
  const def = effectById.get(effectId);
  return addClipOfType(store, 'effect', t, { duration: 3, effect: { id: effectId, params: defaultParams(def) } }, 'Add effect');
}

export function addFilterClip(store, filterId, t) {
  return addClipOfType(store, 'adjust', t, { duration: 3, filter: { id: filterId, intensity: 0.8 } }, 'Add filter');
}

export function applyEffectToClip(store, clipId, effectId) {
  const def = effectById.get(effectId);
  store.commit('Add effect', (p) => {
    const f = findClip(p, clipId);
    if (!f || !f.clip.effects) return;
    f.clip.effects.push({ uid: uid(), id: effectId, params: defaultParams(def), enabled: true });
  });
}

export function setClipAnim(store, clipId, slot, animId) {
  store.commit('Animation', (p) => {
    const f = findClip(p, clipId);
    if (!f) return;
    const c = f.clip;
    c.anim = c.anim || {};
    if (!animId) {
      delete c.anim[slot];
      return;
    }
    const def = animById.get(animId);
    const prev = c.anim[slot];
    c.anim[slot] = { id: animId, duration: prev && prev.duration ? prev.duration : Math.min(defaultAnimDuration(def), c.duration * (slot === 'loop' ? 1 : 0.5)) };
    if (slot === 'loop' && def.whole) c.anim[slot].duration = c.duration;
  });
}

export function setTransition(store, clipId, transitionId, duration) {
  store.commit('Transition', (p) => {
    const f = findClip(p, clipId);
    if (!f) return;
    f.clip.transitionIn = transitionId ? { id: transitionId, duration: duration || (f.clip.transitionIn && f.clip.transitionIn.duration) || 0.6 } : null;
  });
}

// Splits clips at t. With no selection, splits whatever is under the playhead on the main track.
export function splitAt(store, t) {
  const p = store.project;
  let targets = store.selectedClips().filter((f) => t > f.clip.start + 0.01 && t < clipEnd(f.clip) - 0.01 && !f.track.locked);
  if (!targets.length) {
    const main = mainTrack(p);
    const under = main && main.clips.find((c) => t > c.start + 0.01 && t < clipEnd(c) - 0.01);
    if (under) targets = [findClip(p, under.id)];
  }
  if (!targets.length) return false;
  const ids = targets.map((f) => f.clip.id);
  const newIds = [];
  store.commit('Split', (proj) => {
    for (const id of ids) {
      const f = findClip(proj, id);
      if (!f) continue;
      const right = splitClip(f.clip, t);
      f.track.clips.splice(f.index + 1, 0, right);
      newIds.push(right.id);
    }
  });
  store.select(newIds);
  return true;
}

export function splitClip(c, t) {
  const cut = t - c.start;
  const right = structuredClone(c);
  right.id = uid();
  right.start = t;
  right.duration = c.duration - cut;
  if (right.in !== undefined) right.in = (c.in || 0) + cut * (c.speed || 1);
  c.duration = cut;
  right.transitionIn = null;
  if (c.anim) {
    if (c.anim.out) delete c.anim.out;
    if (right.anim && right.anim.in) delete right.anim.in;
  }
  if (c.text && c.text.anim) {
    if (c.text.anim.out) delete c.text.anim.out;
    if (right.text.anim && right.text.anim.in) delete right.text.anim.in;
  }
  if (c.fadeOut) c.fadeOut = 0;
  if (right.fadeIn) right.fadeIn = 0;
  // Keyframes: each side keeps its own, re-timed to its start.
  if (c.keyframes) {
    for (const k in c.keyframes) {
      const all = c.keyframes[k] || [];
      c.keyframes[k] = all.filter((f) => f.t <= cut + 1e-6);
      right.keyframes[k] = all.filter((f) => f.t >= cut - 1e-6).map((f) => ({ ...f, t: Math.max(0, f.t - cut) }));
    }
  }
  return right;
}

export function deleteSelected(store, ripple = false) {
  const ids = new Set(store.selection);
  if (!ids.size) return false;
  store.commit('Delete', (p) => {
    for (const t of p.tracks) {
      if (t.locked) continue;
      const removed = t.clips.filter((c) => ids.has(c.id));
      t.clips = t.clips.filter((c) => !ids.has(c.id));
      if (ripple && !t.main && removed.length) {
        for (const r of removed.sort((a, b) => b.start - a.start)) for (const c of t.clips) if (c.start >= clipEnd(r) - 1e-6) c.start -= r.duration;
      }
    }
  });
  store.select([]);
  return true;
}

export function duplicateSelected(store) {
  const sel = store.selectedClips();
  if (!sel.length) return;
  const newIds = [];
  store.commit('Duplicate', (p) => {
    for (const { clip } of sel) {
      const f = findClip(p, clip.id);
      if (!f) continue;
      const c = structuredClone(f.clip);
      c.id = uid();
      c.transitionIn = null;
      c.start = clipEnd(f.clip);
      newIds.push(c.id);
      if (f.track.main && p.magnet) {
        for (const x of f.track.clips) if (x.start >= c.start - 1e-6) x.start += c.duration;
        f.track.clips.push(c);
      } else if (!overlaps(f.track, c.start, c.start + c.duration)) f.track.clips.push(c);
      else trackWithSpace(p, f.track.type, c.start, c.start + c.duration).clips.push(c);
    }
  });
  store.select(newIds);
}

export function copySelected(store) {
  const sel = store.selectedClips();
  if (!sel.length) return false;
  const t0 = Math.min(...sel.map((f) => f.clip.start));
  store.clipboard = sel.map((f) => ({ clip: structuredClone(f.clip), trackType: f.track.type, offset: f.clip.start - t0 }));
  return true;
}

export function paste(store, t) {
  const items = store.clipboard;
  if (!items || !items.length) return false;
  const ids = [];
  store.commit('Paste', (p) => {
    for (const it of items) {
      const c = structuredClone(it.clip);
      c.id = uid();
      c.transitionIn = null;
      c.start = t + it.offset;
      ids.push(c.id);
      trackWithSpace(p, it.trackType, c.start, c.start + c.duration, { allowMain: !p.magnet }).clips.push(c);
    }
  });
  store.select(ids);
  return true;
}

export function detachAudio(store, clipId) {
  let made = null;
  store.commit('Extract audio', (p) => {
    const f = findClip(p, clipId);
    if (!f || f.clip.type !== 'video') return;
    const v = f.clip;
    const a = makeClip('audio', { mediaId: v.mediaId, in: v.in, speed: v.speed, start: v.start, duration: v.duration, volume: v.volume, fadeIn: v.fadeIn, fadeOut: v.fadeOut, name: (v.name || 'Audio') + ' (audio)' });
    if (v.keyframes && v.keyframes.volume) a.keyframes = { volume: structuredClone(v.keyframes.volume) };
    v.muted = true;
    trackWithSpace(p, 'audio', a.start, a.start + a.duration).clips.push(a);
    made = a;
  });
  if (made) store.select(made.id);
  return made;
}

// Inserts a still of the current frame of a video clip, splitting the clip there.
export async function freezeFrame(store, media, player) {
  const f = store.primary();
  const t = player.time;
  const p = store.project;
  const target = f && f.clip.type === 'video' ? f : findClip(p, (mainTrack(p).clips.find((c) => c.type === 'video' && t >= c.start && t < clipEnd(c)) || {}).id);
  if (!target) return false;
  const e = player.els.get(target.clip.id);
  if (!e || !e.el.videoWidth) return false;
  const c = document.createElement('canvas');
  c.width = e.el.videoWidth;
  c.height = e.el.videoHeight;
  c.getContext('2d').drawImage(e.el, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const m = await media.addBlob(blob, 'Freeze frame.png');
  if (!m) return false;
  const id = target.clip.id;
  store.commit('Freeze frame', (proj) => {
    const ff = findClip(proj, id);
    if (!ff) return;
    const still = makeClip('image', { mediaId: m.id, duration: 2, name: 'Freeze frame' });
    still.transform = structuredClone(ff.clip.transform);
    still.adjust = structuredClone(ff.clip.adjust);
    still.filter = structuredClone(ff.clip.filter);
    still.effects = structuredClone(ff.clip.effects);
    still.crop = structuredClone(ff.clip.crop);
    const inside = t > ff.clip.start + 0.01 && t < clipEnd(ff.clip) - 0.01;
    let insertAt = ff.index + 1;
    if (inside) {
      const right = splitClip(ff.clip, t);
      ff.track.clips.splice(ff.index + 1, 0, right);
      right.start = t + still.duration;
      for (const x of ff.track.clips) if (x !== right && x.start >= t + 1e-6) x.start += still.duration;
    } else {
      for (const x of ff.track.clips) if (x.start >= clipEnd(ff.clip) - 1e-6 && x !== ff.clip) x.start += still.duration;
    }
    still.start = inside ? t : clipEnd(ff.clip);
    ff.track.clips.splice(insertAt, 0, still);
  });
  return true;
}

export function setMarker(store, t) {
  store.commit('Marker', (p) => {
    p.markers = p.markers || [];
    const near = p.markers.findIndex((m) => Math.abs(m.t - t) < 0.05);
    if (near >= 0) p.markers.splice(near, 1);
    else p.markers.push({ id: uid(), t, color: '#f2b33d' });
    p.markers.sort((a, b) => a.t - b.t);
  });
}

export const timelineEnd = (p) => projectDuration(p);
