// Editing actions with plain arguments, shared by the AI editor's tools and its offline commands.
// Every action changes the project through the store, so each one can be undone.

import { findClip, mainTrack, clipEnd, projectDuration, ASPECTS } from './model.js';
import * as ops from './ops.js';
import { effectById, EFFECTS } from './engine/effects.js';
import { filterById, FILTERS } from './engine/filters.js';
import { transitionById, TRANSITIONS } from './engine/transitions.js';
import { animById, ANIMATIONS } from './engine/animation.js';
import { textAnimById, TEXT_ANIMS, FONTS } from './engine/text.js';
import { TEXT_TEMPLATES } from './templates.js';
import { searchAudio, searchPhotos, importResult } from './stock.js';
import { autoCaptions } from './captions.js';
import { removeSilences, cutToBeat, highlightReel } from './autoedit.js';
import { autoReframe } from './reframe.js';
import { analyzeShake } from './stabilize.js';
import { reverseMedia, swapToReversed } from './reverse.js';
import { loadMatte } from './ai.js';
import { speak, VOICES } from './tts.js';

const r2 = (v) => Math.round(v * 100) / 100;
const need = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

export class Actions {
  constructor(app) {
    this.app = app;
    this.results = new Map(); // search result id -> result
  }

  get store() {
    return this.app.store;
  }

  get p() {
    return this.app.store.project;
  }

  clip(id) {
    const f = findClip(this.p, id);
    need(f, `There is no clip with id ${id}. Call get_project for current ids.`);
    return f;
  }

  edit(id, label, fn) {
    this.clip(id);
    this.store.commit(label, (p) => {
      const f = findClip(p, id);
      if (f) fn(f.clip, f, p);
    });
  }

  // ---------- reading ----------

  summary() {
    const p = this.p;
    const media = this.app.media;
    const clipInfo = (c) => {
      const o = { id: c.id, type: c.type, start: r2(c.start), duration: r2(c.duration) };
      const m = c.mediaId && media.get(c.mediaId);
      if (m) o.media = m.name;
      if (c.in) o.source_in = r2(c.in);
      if (c.text) o.text = c.text.content.slice(0, 120);
      if (c.speed && c.speed !== 1) o.speed = c.speed;
      if (c.volume !== undefined && c.volume !== 1) o.volume = c.volume;
      if (c.muted) o.muted = true;
      if (c.effects && c.effects.length) o.effects = c.effects.map((e) => e.id);
      if (c.filter && c.filter.id) o.filter = c.filter.id;
      if (c.effect) o.effect = c.effect.id;
      if (c.anim && Object.keys(c.anim).length) o.animation = Object.fromEntries(Object.entries(c.anim).map(([k, v]) => [k, v.id]));
      if (c.transitionIn) o.transition_in = c.transitionIn.id;
      if (c.cutout && c.cutout.mode && c.cutout.mode !== 'off') o.background = c.cutout.mode;
      if (c.transform && (c.transform.x || c.transform.y || c.transform.scale !== 1 || c.transform.rotation)) o.transform = { x: r2(c.transform.x), y: r2(c.transform.y), scale: r2(c.transform.scale), rotation: r2(c.transform.rotation) };
      return o;
    };
    return {
      name: p.name,
      canvas: { aspect: p.aspect, width: p.width, height: p.height, fps: p.fps, background: p.background.type },
      duration: r2(projectDuration(p)),
      playhead: r2(this.app.player.time),
      selected: this.store.selection,
      tracks: p.tracks.map((t) => ({ id: t.id, type: t.type, main: t.main || undefined, muted: t.muted || undefined, hidden: t.hidden || undefined, clips: t.clips.map(clipInfo) })),
      markers: (p.markers || []).map((m) => ({ time: r2(m.t), label: m.label || undefined })),
      media_library: media.list().filter((m) => m.status === 'ready').map((m) => ({ id: m.id, name: m.name, type: m.type, duration: r2(m.duration), size: m.width ? `${m.width}x${m.height}` : undefined, has_audio: m.hasAudio || undefined, beats: m.beats ? m.beats.length : undefined })),
    };
  }

  // ---------- clips ----------

  addMedia({ media_id, track = 'main', start }) {
    const m = this.app.media.get(media_id);
    need(m && m.status === 'ready', `No ready media with id ${media_id}.`);
    const t = start ?? this.app.player.time;
    const c = track === 'overlay' ? ops.addMedia(this.store, m, t, { overlay: true }) : ops.addMedia(this.store, m, t);
    need(c, 'The clip could not be added.');
    return { clip_id: c.id, start: r2(findClip(this.p, c.id).clip.start), duration: r2(c.duration) };
  }

  updateClip({ clip_id, ...v }) {
    const f = this.clip(clip_id);
    const m = f.clip.mediaId && this.app.media.get(f.clip.mediaId);
    this.edit(clip_id, 'Edit clip', (c) => {
      if (v.speed !== undefined && c.speed !== undefined) {
        const sp = Math.max(0.1, Math.min(10, v.speed));
        c.duration = (c.duration * (c.speed || 1)) / sp;
        c.speed = sp;
      }
      if (v.source_in !== undefined && c.in !== undefined) c.in = Math.max(0, v.source_in);
      if (v.duration !== undefined) c.duration = Math.max(0.05, v.duration);
      if (m && (c.type === 'video' || c.type === 'audio')) c.duration = Math.min(c.duration, (m.duration - (c.in || 0)) / (c.speed || 1));
      if (v.start !== undefined) c.start = Math.max(0, v.start);
      if (v.volume !== undefined && c.volume !== undefined) c.volume = Math.max(0, Math.min(2, v.volume));
      if (v.muted !== undefined && 'muted' in c) c.muted = !!v.muted;
      if (v.fade_in !== undefined && 'fadeIn' in c) c.fadeIn = Math.max(0, v.fade_in);
      if (v.fade_out !== undefined && 'fadeOut' in c) c.fadeOut = Math.max(0, v.fade_out);
      if (c.transform) for (const k of ['x', 'y', 'scale', 'rotation', 'opacity']) if (v[k] !== undefined) c.transform[k] = v[k];
      if (v.blend && c.blend !== undefined) c.blend = v.blend;
      if (v.flip_horizontal !== undefined && 'flipH' in c) c.flipH = !!v.flip_horizontal;
    });
    return 'ok';
  }

  fillFrame({ clip_id }) {
    const f = this.clip(clip_id);
    const m = this.app.media.get(f.clip.mediaId);
    need(m && m.width, 'Only video and photo clips can fill the frame.');
    const contain = Math.min(this.p.width / m.width, this.p.height / m.height), cover = Math.max(this.p.width / m.width, this.p.height / m.height);
    this.edit(clip_id, 'Fill frame', (c) => Object.assign(c.transform, { scale: cover / contain, x: 0, y: 0 }));
    return 'ok';
  }

  split({ time, clip_id }) {
    if (clip_id) this.store.select(clip_id);
    else this.store.select([]);
    const ok = ops.splitAt(this.store, time);
    need(ok, `Nothing to split at ${time}s.`);
    return { new_clip_ids: this.store.selection };
  }

  deleteClips({ clip_ids, ripple = false }) {
    for (const id of clip_ids) this.clip(id);
    this.store.select(clip_ids);
    ops.deleteSelected(this.store, ripple);
    return 'ok';
  }

  addText({ text, start, duration = 3, style, x, y, size, color, font }) {
    const preset = style ? TEXT_TEMPLATES.find((t) => t.name.toLowerCase() === String(style).toLowerCase()) : null;
    need(!style || preset, `Unknown text style "${style}".`);
    const c = ops.addText(this.store, start ?? this.app.player.time, preset ? { ...preset, duration } : null);
    this.edit(c.id, 'Text', (cl) => {
      cl.duration = duration;
      cl.text.content = text;
      if (x !== undefined) cl.transform.x = x;
      if (y !== undefined) cl.transform.y = y;
      if (size) cl.text.size = size;
      if (color) cl.text.color = color;
      if (font) cl.text.font = font;
    });
    return { clip_id: c.id };
  }

  editText({ clip_id, text, size, color, font, bold, outline_width, outline_color, background }) {
    const f = this.clip(clip_id);
    need(f.clip.text, 'That clip is not text.');
    this.edit(clip_id, 'Edit text', (c) => {
      if (text !== undefined) c.text.content = text;
      if (size) c.text.size = size;
      if (color) c.text.color = color;
      if (font) c.text.font = font;
      if (bold !== undefined) c.text.weight = bold ? 800 : 400;
      if (outline_width !== undefined) c.text.stroke.width = outline_width;
      if (outline_color) c.text.stroke.color = outline_color;
      if (background !== undefined) c.text.bg.enabled = !!background;
    });
    return 'ok';
  }

  addSticker({ emoji, start, duration = 3, x = 0, y = 0, scale = 1 }) {
    const c = ops.addClipOfType(this.store, 'sticker', start ?? this.app.player.time, { duration }, 'Add sticker');
    this.edit(c.id, 'Sticker', (cl) => {
      cl.text.content = emoji;
      Object.assign(cl.transform, { x, y, scale });
      cl.anim = { in: { id: 'popIn', duration: 0.4 } };
    });
    return { clip_id: c.id };
  }

  // ---------- looks ----------

  addEffect({ effect_id, clip_id, start, duration = 3, params }) {
    const def = effectById.get(effect_id);
    need(def, `Unknown effect "${effect_id}".`);
    if (clip_id) {
      this.clip(clip_id);
      ops.applyEffectToClip(this.store, clip_id, effect_id);
      if (params) this.edit(clip_id, 'Effect', (c) => Object.assign(c.effects[c.effects.length - 1].params, params));
      return 'Added to the clip';
    }
    const c = ops.addEffectClip(this.store, effect_id, start ?? this.app.player.time);
    this.edit(c.id, 'Effect', (cl) => {
      cl.duration = duration;
      if (params) Object.assign(cl.effect.params, params);
    });
    return { effect_clip_id: c.id };
  }

  setFilter({ filter_id, clip_id, intensity = 0.8, start, duration }) {
    need(!filter_id || filterById.get(filter_id), `Unknown filter "${filter_id}".`);
    const targets = clip_id === 'all' ? this.p.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'video' || c.type === 'image').map((c) => c.id) : clip_id ? [clip_id] : null;
    if (targets) {
      for (const id of targets) this.edit(id, 'Filter', (c) => (c.filter = filter_id ? { id: filter_id, intensity } : null));
      return `Set on ${targets.length} clip(s)`;
    }
    need(filter_id, 'Give a filter id.');
    const c = ops.addFilterClip(this.store, filter_id, start ?? 0);
    this.edit(c.id, 'Filter', (cl) => {
      cl.duration = duration ?? Math.max(1, projectDuration(this.p) - cl.start);
      cl.filter.intensity = intensity;
    });
    return { filter_clip_id: c.id };
  }

  setTransition({ clip_id, transition_id, duration = 0.6 }) {
    need(!transition_id || transitionById.get(transition_id), `Unknown transition "${transition_id}".`);
    if (clip_id === 'all') {
      this.store.commit('Transitions', (p) => {
        const main = mainTrack(p);
        main.clips.forEach((c, i) => { if (i > 0) c.transitionIn = transition_id ? { id: transition_id, duration } : null; });
      });
      return 'Set on every cut of the main track';
    }
    this.clip(clip_id);
    ops.setTransition(this.store, clip_id, transition_id, duration);
    return 'ok';
  }

  setAnimation({ clip_id, slot, animation_id, duration }) {
    need(['in', 'out', 'loop'].includes(slot), 'slot must be in, out or loop');
    const f = this.clip(clip_id);
    if (animation_id && textAnimById.get(animation_id) && f.clip.text) {
      this.edit(clip_id, 'Letter animation', (c) => {
        c.text.anim = c.text.anim || {};
        c.text.anim[slot] = { id: animation_id, duration: duration || (slot === 'loop' ? 1.2 : Math.min(1, c.duration / 2)) };
      });
      return 'Letter animation set';
    }
    need(!animation_id || animById.get(animation_id), `Unknown animation "${animation_id}".`);
    ops.setClipAnim(this.store, clip_id, slot, animation_id || null);
    if (duration && animation_id) this.edit(clip_id, 'Animation', (c) => c.anim[slot] && (c.anim[slot].duration = duration));
    return 'ok';
  }

  setCanvas({ aspect, background, color }) {
    const a = aspect ? ASPECTS.find((x) => x[0] === aspect) : null;
    need(!aspect || a, `Aspect must be one of ${ASPECTS.map((x) => x[0]).join(', ')}.`);
    this.store.commit('Canvas', (p) => {
      if (a) Object.assign(p, { aspect: a[0], width: a[1], height: a[2] });
      if (background) p.background.type = background;
      if (color) p.background.color = color;
    });
    return 'ok';
  }

  addMarker({ time, label }) {
    this.store.commit('Marker', (p) => {
      p.markers = p.markers || [];
      p.markers.push({ id: Math.random().toString(36).slice(2), t: time, label: label || '', color: '#f2b33d' });
      p.markers.sort((a, b) => a.t - b.t);
    });
    return 'ok';
  }

  // ---------- media online ----------

  async searchMusic({ query, kind = 'music' }) {
    const res = await searchAudio(query, { kind });
    return res.results.slice(0, 10).map((r) => {
      this.results.set(r.id, r);
      return { result_id: r.id, title: r.title, creator: r.creator, seconds: Math.round(r.duration), license: r.licenseLabel, ok_for_monetized: r.commercial };
    });
  }

  async searchPhotos({ query, shape }) {
    const res = await searchPhotos(query, { shape });
    return res.results.slice(0, 10).map((r) => {
      this.results.set(r.id, r);
      return { result_id: r.id, title: r.title, creator: r.creator, size: `${r.width}x${r.height}`, license: r.licenseLabel };
    });
  }

  async addResult({ result_id, start, track, volume }) {
    const r = this.results.get(result_id);
    need(r, 'Search first, then use a result_id from the search.');
    const m = await importResult(this.app.media, r);
    const c = track === 'overlay' ? ops.addMedia(this.store, m, start ?? this.app.player.time, { overlay: true }) : ops.addMedia(this.store, m, start ?? this.app.player.time);
    need(c, 'The file was downloaded but could not be added.');
    if (volume !== undefined) this.edit(c.id, 'Volume', (cl) => (cl.volume = volume));
    // Music should cover the edit, not run far past it.
    if (r.kind === 'audio' && projectDuration(this.p) > 0) {
      const end = Math.max(...this.p.tracks.filter((t) => t.type !== 'audio').map((t) => t.clips.reduce((mx, cl) => Math.max(mx, clipEnd(cl)), 0)), 0);
      const cl = findClip(this.p, c.id).clip;
      if (end > cl.start + 1 && clipEnd(cl) > end + 0.5) this.edit(c.id, 'Fit music', (x) => { x.duration = end - x.start; x.fadeOut = Math.min(2, x.duration / 3); });
    }
    return { clip_id: c.id, media_id: m.id, credit: r.credit.attribution };
  }

  // ---------- smart tools ----------

  async captions({ language = '', style = 'Subtitle' }, progress) {
    const n = await autoCaptions(this.app, { model: 'Xenova/whisper-base', language, style, maxWords: 7 }, progress || (() => {}));
    return `Added ${n} captions`;
  }

  async silences({ clip_id, threshold_db = -32 }) {
    const ids = clip_id ? [clip_id] : this.p.tracks.flatMap((t) => t.clips).filter((c) => (c.type === 'video' || c.type === 'audio') && this.app.media.get(c.mediaId)?.hasAudio && !c.muted).map((c) => c.id);
    need(ids.length, 'There is no clip with sound to cut.');
    let removed = 0, cuts = 0;
    for (const id of ids) {
      if (!findClip(this.p, id)) continue;
      const r = await removeSilences(this.app, id, { threshold: threshold_db });
      removed += r.removed;
      cuts += r.cuts;
    }
    return `Removed ${r2(removed)}s of silence with ${cuts} cuts`;
  }

  beat({ beats_per_cut = 2, transition_id }) {
    const r = cutToBeat(this.app, { beatsPerCut: beats_per_cut, transition: transition_id || null });
    return `Made ${r.cuts} cuts on ${r.beats} beats`;
  }

  async highlights({ length_seconds = 30, piece_seconds = 2.5 }, progress) {
    const r = await highlightReel(this.app, { length: length_seconds, piece: piece_seconds, onProgress: progress });
    return `Built a ${r2(r.seconds)}s reel from ${r.pieces} moments`;
  }

  async reframe({ aspect }, progress) {
    const r = await autoReframe(this.app, aspect, progress || (() => {}));
    return `Reframed ${r.clips} clips to ${aspect}, ${r.found} with faces followed`;
  }

  async stabilize({ clip_id, smoothness = 0.5 }, progress) {
    const f = this.clip(clip_id);
    const m = this.app.media.get(f.clip.mediaId);
    need(f.clip.type === 'video' && m, 'Only video clips can be stabilized.');
    const from = f.clip.in || 0;
    const res = await analyzeShake(m.blob, from, Math.min(m.duration, from + f.clip.duration * (f.clip.speed || 1)), smoothness, progress);
    this.edit(clip_id, 'Stabilize', (c) => (c.stab = { enabled: true, zoom: res.zoom, strength: smoothness, data: res.data }));
    return `Stabilized (zoom ${Math.round(res.zoom * 100)}%)`;
  }

  async background({ clip_id, mode = 'remove' }) {
    const f = this.clip(clip_id);
    need(f.clip.type === 'video' || f.clip.type === 'image', 'Only video and photo clips.');
    if (mode !== 'off') await loadMatte();
    this.edit(clip_id, 'Background', (c) => (c.cutout = { threshold: 0.5, softness: 0.2, blur: 0.5, ...(c.cutout || {}), mode }));
    return 'ok';
  }

  async reverse({ clip_id }, progress) {
    const f = this.clip(clip_id);
    const lib = this.app.media;
    const cur = lib.get(f.clip.mediaId);
    need(f.clip.type === 'video' && cur, 'Only video clips can be reversed.');
    const target = (cur.reverseOf && lib.get(cur.reverseOf)) || (cur.reversedId && lib.get(cur.reversedId)) || (await reverseMedia(lib, cur, progress));
    this.edit(clip_id, 'Reverse', (c) => swapToReversed(c, cur, target));
    return target.reverseOf ? 'Reversed' : 'Back to forwards';
  }

  async voice({ text, voice = 'af_heart', start }, progress) {
    const blob = await speak(text, { voice }, progress);
    const m = await this.app.media.addBlob(blob, `Voice - ${text.slice(0, 24).replace(/[\\/:*?"<>|\n]/g, ' ')}.wav`);
    need(m, 'The voice clip could not be added.');
    const c = ops.addMedia(this.store, m, start ?? this.app.player.time);
    return { clip_id: c.id, seconds: r2(m.duration) };
  }
}

// Short catalogs for the AI so it picks real ids.
export function catalogText() {
  const byCat = {};
  for (const e of EFFECTS) (byCat[e.cat] = byCat[e.cat] || []).push(`${e.id} (${e.name}${e.params.length ? ': ' + e.params.map((p) => p.k).join(',') : ''})`);
  const anims = { in: [], out: [], loop: [] };
  for (const a of ANIMATIONS) anims[a.category].push(a.id);
  const tAnims = { in: [], out: [], loop: [] };
  for (const a of TEXT_ANIMS) tAnims[a.cat].push(a.id);
  return [
    'EFFECTS (effect_id):\n' + Object.entries(byCat).map(([k, v]) => `${k}: ${v.join('; ')}`).join('\n'),
    'FILTERS (filter_id): ' + FILTERS.map((f) => `${f.id} (${f.name})`).join(', '),
    'TRANSITIONS (transition_id): ' + TRANSITIONS.map((t) => t.id).join(', ') + '. Good defaults: fade, fadecolor (dip to black), CrossZoom, Directional, wipeLeft, SimpleZoom, Dreamy, GlitchMemories, cube.',
    'CLIP ANIMATIONS (animation_id): in: ' + anims.in.join(', ') + '\nout: ' + anims.out.join(', ') + '\nloop: ' + anims.loop.join(', '),
    'TEXT LETTER ANIMATIONS (animation_id on text clips): in: ' + tAnims.in.join(', ') + '; out: ' + tAnims.out.join(', ') + '; loop: ' + tAnims.loop.join(', '),
    'TEXT STYLES (style): ' + TEXT_TEMPLATES.map((t) => t.name).join(', '),
    'FONTS: ' + FONTS.map((f) => f[0]).join(', '),
    'VOICES: ' + VOICES.map((v) => `${v[0]} (${v[1]})`).join(', '),
    'CANVAS SHAPES: ' + ASPECTS.map((a) => `${a[0]} (${a[3]})`).join(', '),
  ].join('\n\n');
}

