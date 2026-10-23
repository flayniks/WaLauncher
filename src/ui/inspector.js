// Right-hand panel: properties of the selected clip, or the project settings when nothing is selected.

import { h, icon, iconButton, slider, colorInput, select, toggle, segmented, section, toast } from './dom.js';
import { findClip, ASPECTS, clipLabel, clipEnd, fmtTime } from '../model.js';
import { keyframeValue, animsFor, animById, evalPreset, defaultAnimDuration } from '../engine/animation.js';
import { effectById, defaultParams } from '../engine/effects.js';
import { FILTERS } from '../engine/filters.js';
import { BLEND_MODES, MASK_TYPES } from '../engine/shaders.js';
import { FONTS, TEXT_ANIMS, SHAPES } from '../engine/text.js';
import * as ops from '../ops.js';
import { LUTS, importLut } from '../luts.js';

const ADJUST = [
  ['exposure', 'Exposure', -2, 2],
  ['brightness', 'Brightness', -1, 1],
  ['contrast', 'Contrast', -1, 1],
  ['saturation', 'Saturation', -1, 1],
  ['vibrance', 'Vibrance', -1, 1],
  ['temperature', 'Temperature', -1, 1],
  ['tint', 'Tint', -1, 1],
  ['highlights', 'Highlights', -1, 1],
  ['shadows', 'Shadows', -1, 1],
  ['hue', 'Hue', -1, 1],
  ['sharpen', 'Sharpen', 0, 1],
  ['fade', 'Fade', 0, 1],
  ['vignette', 'Vignette', -1, 1],
  ['grain', 'Grain', 0, 1],
];

const PROP_PATH = { x: ['transform', 'x', 0], y: ['transform', 'y', 0], scale: ['transform', 'scale', 1], rotation: ['transform', 'rotation', 0], opacity: ['transform', 'opacity', 1], volume: [null, 'volume', 1] };

const TABS = {
  video: [['basic', 'Basic'], ['anim', 'Animation'], ['adjust', 'Adjust'], ['effects', 'Effects'], ['mask', 'Mask'], ['speed', 'Speed'], ['audio', 'Audio'], ['key', 'Chroma key']],
  image: [['basic', 'Basic'], ['anim', 'Animation'], ['adjust', 'Adjust'], ['effects', 'Effects'], ['mask', 'Mask'], ['key', 'Chroma key']],
  text: [['text', 'Text'], ['style', 'Style'], ['letters', 'Letter FX'], ['anim', 'Animation'], ['basic', 'Basic'], ['effects', 'Effects']],
  sticker: [['text', 'Sticker'], ['anim', 'Animation'], ['basic', 'Basic'], ['effects', 'Effects']],
  shape: [['shape', 'Shape'], ['basic', 'Basic'], ['anim', 'Animation'], ['effects', 'Effects'], ['mask', 'Mask']],
  audio: [['audio', 'Audio'], ['speed', 'Speed']],
  effect: [['effect', 'Effect']],
  adjust: [['adjust', 'Filter']],
};

export class Inspector {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.store = app.store;
    this.player = app.player;
    this.tab = {};
    this.controls = [];
    this.store.addEventListener('selection', () => this.build());
    this.store.addEventListener('project', () => this.build());
    this.store.addEventListener('change', (e) => (e.detail && e.detail.live ? this.refresh() : this.build()));
    this.player.addEventListener('time', () => this.refresh());
    this.build();
  }

  get clip() {
    const f = this.store.primary();
    return f ? f.clip : null;
  }

  local() {
    const c = this.clip;
    if (!c) return 0;
    return Math.max(0, Math.min(c.duration, this.player.time - c.start));
  }

  // Applies fn(clip) to the selected clip. While dragging, call with final=false; on release with final=true.
  edit(fn, final, label = 'Edit') {
    const id = this.store.selection[this.store.selection.length - 1];
    const apply = (p) => {
      const f = findClip(p, id);
      if (f) fn(f.clip, f, p);
    };
    if (final && !this.store.pending) this.store.commit(label, apply);
    else {
      this.store.live(apply);
      if (final) this.store.end(label);
    }
  }

  editProject(fn, final, label = 'Project') {
    if (final && !this.store.pending) this.store.commit(label, fn);
    else {
      this.store.live(fn);
      if (final) this.store.end(label);
    }
  }

  refresh() {
    for (const c of this.controls) c.refresh && c.refresh();
  }

  build() {
    const scroll = this.body ? this.body.scrollTop : 0;
    const keep = this.root.querySelector('.drawer-close');
    this.root.textContent = '';
    if (keep) this.root.append(keep);
    this.controls = [];
    const f = this.store.primary();
    if (!f) {
      this.buildProject();
      return;
    }
    const c = f.clip;
    const tabs = TABS[c.type] || [['basic', 'Basic']];
    let tab = this.tab[c.type];
    if (!tabs.some((t) => t[0] === tab)) tab = tabs[0][0];
    const head = h(
      'div',
      { class: 'insp-head' },
      h('div', { class: 'insp-title' }, h('span', { class: 'chip ' + c.type }, c.type), h('strong', null, clipLabel(c, this.app.media.items)), this.store.selection.length > 1 ? h('em', null, ` +${this.store.selection.length - 1} more`) : null),
      h('div', { class: 'insp-meta tc' }, `${fmtTime(c.start, 30, true)} → ${fmtTime(clipEnd(c), 30, true)}  ·  ${c.duration.toFixed(2)}s`),
      h('div', { class: 'insp-tabs', role: 'tablist' }, tabs.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': k === tab ? 'true' : 'false', class: k === tab ? 'on' : '', onclick: () => { this.tab[c.type] = k; this.build(); } }, l))),
    );
    this.body = h('div', { class: 'insp-body' });
    this.root.append(head, this.body);
    const builders = {
      basic: () => this.buildBasic(c),
      anim: () => this.buildAnim(c),
      adjust: () => this.buildAdjust(c),
      effects: () => this.buildEffects(c),
      mask: () => this.buildMask(c),
      speed: () => this.buildSpeed(c),
      audio: () => this.buildAudio(c),
      key: () => this.buildChroma(c),
      text: () => this.buildText(c),
      style: () => this.buildStyle(c),
      letters: () => this.buildLetters(c),
      shape: () => this.buildShape(c),
      effect: () => this.buildEffectClip(c),
    };
    (builders[tab] || builders.basic)();
    this.body.scrollTop = scroll;
  }

  add(...els) {
    for (const el of els) {
      if (!el) continue;
      this.body.append(el);
      this.collect(el);
    }
  }

  collect(el) {
    if (el.refresh) this.controls.push(el);
    for (const child of el.querySelectorAll ? el.querySelectorAll('*') : []) if (child.refresh) this.controls.push(child);
  }

  // ---------- keyframed properties ----------

  getProp(key) {
    const c = this.clip;
    if (!c) return 0;
    const [obj, k, def] = PROP_PATH[key];
    const base = obj ? (c[obj] || {})[k] : c[k];
    return keyframeValue(c.keyframes && c.keyframes[key], this.local(), base ?? def);
  }

  setProp(key, v, final) {
    const local = this.local();
    const fps = this.store.project.fps || 30;
    this.edit((c) => {
      const [obj, k] = PROP_PATH[key];
      const frames = c.keyframes && c.keyframes[key];
      if (frames && frames.length) {
        const ex = frames.find((f) => Math.abs(f.t - local) < 0.5 / fps);
        if (ex) ex.v = v;
        else {
          frames.push({ t: local, v, e: 'inout' });
          frames.sort((a, b) => a.t - b.t);
        }
      } else if (obj) c[obj][k] = v;
      else c[k] = v;
    }, final, 'Change ' + key);
  }

  kfButton(key) {
    const btn = h('button', { type: 'button', class: 'kf-btn', title: 'Add or remove a keyframe here' }, icon('diamond', 13));
    btn.refresh = () => {
      const c = this.clip;
      const frames = c && c.keyframes && c.keyframes[key];
      const fps = this.store.project.fps || 30;
      const at = frames && frames.some((f) => Math.abs(f.t - this.local()) < 0.5 / fps);
      btn.classList.toggle('has', !!(frames && frames.length));
      btn.classList.toggle('at', !!at);
    };
    btn.onclick = () => {
      const local = this.local();
      const fps = this.store.project.fps || 30;
      const value = this.getProp(key);
      this.edit((c) => {
        c.keyframes = c.keyframes || {};
        const frames = (c.keyframes[key] = c.keyframes[key] || []);
        const i = frames.findIndex((f) => Math.abs(f.t - local) < 0.5 / fps);
        if (i >= 0) {
          frames.splice(i, 1);
          if (!frames.length) {
            delete c.keyframes[key];
            const [obj, k] = PROP_PATH[key];
            if (obj) c[obj][k] = value;
            else c[k] = value;
          }
        } else {
          frames.push({ t: local, v: value, e: 'inout' });
          frames.sort((a, b) => a.t - b.t);
        }
      }, true, 'Keyframe');
    };
    btn.refresh();
    return btn;
  }

  propSlider(label, key, min, max, step = 0.01, format) {
    const kf = this.kfButton(key);
    const row = slider({ label, min, max, step, format, get: () => this.getProp(key), set: (v, final) => this.setProp(key, v, final), kf });
    const r = row.refresh;
    row.refresh = () => { r(); kf.refresh(); };
    return row;
  }

  plain(label, get, set, min, max, step = 0.01, format, labelUndo) {
    return slider({ label, min, max, step, format, get, set: (v, final) => this.edit((c) => set(c, v), final, labelUndo || label) });
  }

  // ---------- tabs ----------

  buildBasic(c) {
    const pct = (v) => Math.round(v * 100) + '%';
    this.add(
      section('Transform',
        this.propSlider('Position X', 'x', -1, 1, 0.001, (v) => (+v).toFixed(3)),
        this.propSlider('Position Y', 'y', -1, 1, 0.001, (v) => (+v).toFixed(3)),
        this.propSlider('Scale', 'scale', 0.05, 5, 0.01, pct),
        this.propSlider('Rotation', 'rotation', -360, 360, 0.5, (v) => Math.round(v) + '°'),
        this.propSlider('Opacity', 'opacity', 0, 1, 0.01, pct),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn', onclick: () => this.edit((cl) => (cl.flipH = !cl.flipH), true, 'Flip') }, 'Flip ↔'),
          h('button', { type: 'button', class: 'btn', onclick: () => this.edit((cl) => (cl.flipV = !cl.flipV), true, 'Flip') }, 'Flip ↕'),
          c.type === 'video' || c.type === 'image' ? h('button', { type: 'button', class: 'btn', onclick: () => this.fill(c) }, 'Fill frame') : null,
          h('button', { type: 'button', class: 'btn', onclick: () => this.edit((cl) => { cl.transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }; cl.keyframes = {}; cl.flipH = cl.flipV = false; }, true, 'Reset transform') }, 'Reset'),
        ),
      ),
      section('Blend', select({ label: 'Mode', options: BLEND_MODES, get: () => this.clip.blend || 'normal', set: (v) => this.edit((cl) => (cl.blend = v), true, 'Blend mode') })),
    );
    if (c.crop) {
      this.add(section('Crop',
        this.plain('Left', () => this.clip.crop.l, (cl, v) => (cl.crop.l = Math.min(v, 0.95 - cl.crop.r)), 0, 0.95, 0.005, pct, 'Crop'),
        this.plain('Right', () => this.clip.crop.r, (cl, v) => (cl.crop.r = Math.min(v, 0.95 - cl.crop.l)), 0, 0.95, 0.005, pct, 'Crop'),
        this.plain('Top', () => this.clip.crop.t, (cl, v) => (cl.crop.t = Math.min(v, 0.95 - cl.crop.b)), 0, 0.95, 0.005, pct, 'Crop'),
        this.plain('Bottom', () => this.clip.crop.b, (cl, v) => (cl.crop.b = Math.min(v, 0.95 - cl.crop.t)), 0, 0.95, 0.005, pct, 'Crop'),
      ));
    }
  }

  // Scales a media clip so it covers the whole frame.
  fill(c) {
    const m = this.app.media.get(c.mediaId);
    if (!m || !m.width) return;
    const p = this.store.project;
    const cw = m.width * (1 - c.crop.l - c.crop.r), ch = m.height * (1 - c.crop.t - c.crop.b);
    const contain = Math.min(p.width / cw, p.height / ch);
    const cover = Math.max(p.width / cw, p.height / ch);
    this.edit((cl) => { cl.transform.scale = cover / contain; cl.transform.x = 0; cl.transform.y = 0; }, true, 'Fill frame');
  }

  animGrid(c, slot) {
    const current = c.anim && c.anim[slot];
    const list = animsFor(slot);
    const groups = new Map();
    for (const a of list) {
      if (!groups.has(a.group)) groups.set(a.group, []);
      groups.get(a.group).push(a);
    }
    const grid = h('div', { class: 'anim-grid' },
      h('button', { type: 'button', class: 'anim-chip' + (!current ? ' on' : ''), onclick: () => ops.setClipAnim(this.store, c.id, slot, null) }, h('span', { class: 'anim-demo none' }), 'None'),
    );
    for (const [g, items] of groups) {
      grid.append(h('div', { class: 'anim-group' }, g));
      for (const a of items) {
        const demo = h('span', { class: 'anim-demo' });
        const chip = h('button', { type: 'button', class: 'anim-chip' + (current && current.id === a.id ? ' on' : ''), title: a.name, onclick: () => ops.setClipAnim(this.store, c.id, slot, a.id), onpointerenter: () => playDemo(demo, a), onfocus: () => playDemo(demo, a) }, demo, a.name);
        grid.append(chip);
      }
    }
    return grid;
  }

  buildAnim(c) {
    const slots = [['in', 'In'], ['out', 'Out'], ['loop', 'Loop']];
    let which = this.animSlot || 'in';
    const seg = segmented({ options: slots, get: () => which, set: (v) => { this.animSlot = v; this.build(); } });
    this.add(section(null, seg));
    const cur = c.anim && c.anim[which];
    if (cur) {
      const def = animById.get(cur.id);
      this.add(section('Length',
        slider({ label: def && def.whole ? 'Length' : which === 'loop' ? 'Cycle' : 'Duration', min: 0.1, max: Math.max(0.2, which === 'loop' ? Math.max(c.duration, 6) : c.duration), step: 0.05, format: (v) => (+v).toFixed(2) + 's', get: () => (this.clip.anim[which] || {}).duration || 0.5, set: (v, final) => this.edit((cl) => cl.anim[which] && (cl.anim[which].duration = v), final, 'Animation length') }),
      ));
    }
    this.add(this.animGrid(c, which));
  }

  buildAdjust(c) {
    const filterOptions = [['', 'None'], ...FILTERS.map((f) => [f.id, `${f.cat} · ${f.name}`])];
    this.add(
      section('Filter',
        select({ label: 'Look', options: filterOptions, get: () => (this.clip.filter && this.clip.filter.id) || '', set: (v) => this.edit((cl) => (cl.filter = v ? { id: v, intensity: (cl.filter && cl.filter.intensity) || 0.8 } : null), true, 'Filter') }),
        c.filter && c.filter.id ? this.plain('Intensity', () => (this.clip.filter ? this.clip.filter.intensity : 0), (cl, v) => cl.filter && (cl.filter.intensity = v), 0, 1, 0.01, (v) => Math.round(v * 100) + '%', 'Filter intensity') : null,
        h('button', { type: 'button', class: 'btn ghost', onclick: () => this.app.showTab('filters') }, 'Browse filters'),
      ),
    );
    const lutIn = h('input', { type: 'file', accept: '.cube', id: 'lut-input', class: 'sr-only', onchange: async () => {
      const file = lutIn.files[0];
      lutIn.value = '';
      if (!file) return;
      try {
        const lut = await importLut(file);
        this.edit((cl) => (cl.lut = { id: lut.id, intensity: 1 }), true, 'LUT');
        toast(`${lut.name} loaded`);
      } catch (e) {
        toast(e.message, 'error', 5000);
      }
    } });
    const lutOptions = [['', 'None'], ...[...LUTS.values()].map((l) => [l.id, l.name])];
    this.add(section('LUT',
      lutOptions.length > 1 ? select({ label: 'Look', options: lutOptions, get: () => (this.clip.lut && this.clip.lut.id) || '', set: (v) => this.edit((cl) => (cl.lut = v ? { id: v, intensity: (cl.lut && cl.lut.intensity) || 1 } : null), true, 'LUT') }) : null,
      c.lut && c.lut.id ? this.plain('Intensity', () => (this.clip.lut ? this.clip.lut.intensity ?? 1 : 0), (cl, v) => cl.lut && (cl.lut.intensity = v), 0, 1, 0.01, (v) => Math.round(v * 100) + '%', 'LUT intensity') : null,
      h('label', { class: 'btn ghost', for: 'lut-input' }, 'Load .cube LUT', lutIn),
    ));
    const rows = ADJUST.map(([k, l, mn, mx]) => this.plain(l, () => (this.clip.adjust || {})[k] || 0, (cl, v) => { cl.adjust = cl.adjust || {}; cl.adjust[k] = v; }, mn, mx, 0.01, (v) => (v > 0 ? '+' : '') + Math.round(v * 100), 'Adjust'));
    rows.forEach((r) => (r.input.dataset.default = 0));
    this.add(section('Adjust', ...rows, h('button', { type: 'button', class: 'btn ghost', onclick: () => this.edit((cl) => (cl.adjust = {}), true, 'Reset adjust') }, 'Reset all')));
  }

  buildEffects(c) {
    const list = c.effects || [];
    if (!list.length) this.add(h('p', { class: 'empty' }, 'No effects on this clip yet. Pick one in the Effects panel and it lands here.'));
    list.forEach((fx, i) => {
      const def = effectById.get(fx.id);
      if (!def) return;
      const params = def.params.map((pd) =>
        pd.type === 'color'
          ? colorInput({ label: pd.label, get: () => ((this.clip.effects[i] || {}).params || {})[pd.k] ?? pd.def, set: (v, final) => this.edit((cl) => (cl.effects[i].params[pd.k] = v), final, 'Effect') })
          : slider({ label: pd.label, min: pd.min, max: pd.max, step: pd.step, get: () => ((this.clip.effects[i] || {}).params || {})[pd.k] ?? pd.def, set: (v, final) => this.edit((cl) => (cl.effects[i].params[pd.k] = v), final, 'Effect') }),
      );
      const mix = slider({ label: 'Mix', min: 0, max: 1, step: 0.01, format: (v) => Math.round(v * 100) + '%', get: () => (this.clip.effects[i] || {}).mix ?? 1, set: (v, final) => this.edit((cl) => (cl.effects[i].mix = v), final, 'Effect mix') });
      this.add(h('section', { class: 'insp-section fx-card' },
        h('header', null,
          h('h4', null, def.name),
          h('span', { class: 'spacer' }),
          iconButton(fx.enabled === false ? 'eyeOff' : 'eye', fx.enabled === false ? 'Turn on' : 'Turn off', () => this.edit((cl) => (cl.effects[i].enabled = cl.effects[i].enabled === false), true, 'Toggle effect'), { size: 15, class: 'tiny' }),
          i > 0 ? iconButton('chevronLeft', 'Move up', () => this.edit((cl) => cl.effects.splice(i - 1, 0, cl.effects.splice(i, 1)[0]), true, 'Reorder effects'), { size: 15, class: 'tiny up' }) : null,
          iconButton('trash', 'Remove effect', () => this.edit((cl) => cl.effects.splice(i, 1), true, 'Remove effect'), { size: 15, class: 'tiny' }),
        ),
        ...params, mix,
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => this.edit((cl) => (cl.effects[i].params = defaultParams(def)), true, 'Reset effect') }, 'Reset'),
      ));
    });
    this.add(h('button', { type: 'button', class: 'btn', onclick: () => this.app.showTab('effects') }, icon('sparkles', 15), 'Add effect'));
  }

  buildMask(c) {
    const m = c.mask;
    const pct = (v) => Math.round(v * 100) + '%';
    const setM = (k) => (cl, v) => (cl.mask[k] = v);
    this.add(section('Shape', h('div', { class: 'mask-grid' }, MASK_TYPES.map(([k, l]) => h('button', { type: 'button', class: 'btn' + (m.type === k ? ' on' : ''), onclick: () => this.edit((cl) => (cl.mask.type = k), true, 'Mask') }, l)))));
    if (m.type === 'none') return;
    this.add(section('Mask',
      this.plain('Center X', () => this.clip.mask.x, setM('x'), -0.5, 0.5, 0.005, (v) => (+v).toFixed(2), 'Mask'),
      this.plain('Center Y', () => this.clip.mask.y, setM('y'), -0.5, 0.5, 0.005, (v) => (+v).toFixed(2), 'Mask'),
      m.type !== 'linear' ? this.plain('Width', () => this.clip.mask.w, setM('w'), 0.02, 2, 0.01, pct, 'Mask') : null,
      m.type !== 'linear' ? this.plain('Height', () => this.clip.mask.h, setM('h'), 0.02, 2, 0.01, pct, 'Mask') : null,
      this.plain('Rotation', () => this.clip.mask.rotation, setM('rotation'), -180, 180, 1, (v) => Math.round(v) + '°', 'Mask'),
      this.plain('Feather', () => this.clip.mask.feather, setM('feather'), 0, 0.5, 0.005, pct, 'Mask'),
      m.type === 'rect' ? this.plain('Round', () => this.clip.mask.round, setM('round'), 0, 1, 0.01, pct, 'Mask') : null,
      toggle({ label: 'Invert', get: () => this.clip.mask.invert, set: (v) => this.edit((cl) => (cl.mask.invert = v), true, 'Mask') }),
    ));
  }

  buildSpeed(c) {
    const m = this.app.media.get(c.mediaId);
    const setSpeed = (v, final) =>
      this.edit((cl) => {
        const old = cl.speed || 1;
        const sourceLen = cl.duration * old;
        let dur = sourceLen / v;
        if (m && m.duration) dur = Math.min(dur, (m.duration - (cl.in || 0)) / v);
        cl.speed = v;
        cl.duration = Math.max(0.05, dur);
      }, final, 'Speed');
    const toSlider = (v) => Math.log(v) / Math.log(10); // -1..1
    const row = slider({ label: 'Speed', min: -1, max: 1, step: 0.005, format: (v) => Math.pow(10, v).toFixed(2) + 'x', parse: (text) => { const n = parseFloat(text); return n > 0 ? toSlider(n) : null; }, get: () => toSlider(this.clip.speed || 1), set: (v, final) => setSpeed(+Math.pow(10, v).toFixed(3), final) });
    this.add(
      section('Speed', row,
        h('div', { class: 'btn-row' }, [0.25, 0.5, 1, 1.5, 2, 4].map((v) => h('button', { type: 'button', class: 'btn' + (Math.abs((c.speed || 1) - v) < 0.001 ? ' on' : ''), onclick: () => setSpeed(v, true) }, v + 'x'))),
        h('p', { class: 'hint' }, 'Speed changes the clip length. Pitch follows the speed, like tape.'),
      ),
    );
  }

  buildAudio(c) {
    const pct = (v) => Math.round(v * 100) + '%';
    this.add(section('Volume',
      this.propSlider('Volume', 'volume', 0, 2, 0.01, pct),
      this.plain('Fade in', () => this.clip.fadeIn || 0, (cl, v) => (cl.fadeIn = Math.min(v, cl.duration / 2)), 0, 10, 0.05, (v) => (+v).toFixed(2) + 's', 'Fade in'),
      this.plain('Fade out', () => this.clip.fadeOut || 0, (cl, v) => (cl.fadeOut = Math.min(v, cl.duration / 2)), 0, 10, 0.05, (v) => (+v).toFixed(2) + 's', 'Fade out'),
      toggle({ label: 'Mute clip', get: () => this.clip.muted, set: (v) => this.edit((cl) => (cl.muted = v), true, 'Mute') }),
      c.type === 'video' ? h('button', { type: 'button', class: 'btn', onclick: () => ops.detachAudio(this.store, c.id) }, icon('detach', 15), 'Extract audio') : null,
    ));
    const m = this.app.media.get(c.mediaId);
    if (c.type === 'audio' && m && m.beats) this.add(section('Beats', h('p', { class: 'hint' }, `${m.beats.length} beats found. Clips snap to the dots under this clip.`)));
  }

  buildChroma(c) {
    const pct = (v) => Math.round(v * 100) + '%';
    const ch = c.chroma;
    const pick = async () => {
      if (!window.EyeDropper) {
        toast('Your browser has no eyedropper. Use the color box instead.');
        return;
      }
      try {
        const r = await new window.EyeDropper().open();
        this.edit((cl) => { cl.chroma.color = r.sRGBHex; cl.chroma.enabled = true; }, true, 'Chroma key');
      } catch {
        /* canceled */
      }
    };
    this.add(section('Chroma key',
      toggle({ label: 'Remove a color', get: () => this.clip.chroma.enabled, set: (v) => this.edit((cl) => (cl.chroma.enabled = v), true, 'Chroma key') }),
      colorInput({ label: 'Key color', get: () => this.clip.chroma.color, set: (v, final) => this.edit((cl) => (cl.chroma.color = v), final, 'Chroma key') }),
      h('button', { type: 'button', class: 'btn ghost', onclick: pick }, 'Pick from screen'),
      ch.enabled ? this.plain('Strength', () => this.clip.chroma.similarity, (cl, v) => (cl.chroma.similarity = v), 0, 1, 0.005, pct, 'Chroma key') : null,
      ch.enabled ? this.plain('Edge softness', () => this.clip.chroma.smoothness, (cl, v) => (cl.chroma.smoothness = v), 0, 1, 0.005, pct, 'Chroma key') : null,
      ch.enabled ? this.plain('Spill', () => this.clip.chroma.spill, (cl, v) => (cl.chroma.spill = v), 0, 1, 0.005, pct, 'Chroma key') : null,
    ));
  }

  buildText(c) {
    const t = () => this.clip.text;
    const ta = h('textarea', { id: 'text-content', rows: 3, 'aria-label': 'Text', value: c.text.content });
    ta.addEventListener('input', () => this.edit((cl) => (cl.text.content = ta.value), false));
    ta.addEventListener('change', () => this.edit((cl) => (cl.text.content = ta.value), true, 'Edit text'));
    ta.refresh = () => { if (document.activeElement !== ta) ta.value = this.clip.text.content; };
    if (c.type === 'sticker') {
      this.add(section('Sticker', ta, this.plain('Size', () => t().size, (cl, v) => (cl.text.size = v), 40, 900, 1, (v) => Math.round(v), 'Size')));
      return;
    }
    const fontSel = h('select', { id: 'text-font', 'aria-label': 'Font' }, FONTS.map(([f]) => h('option', { value: f, style: { fontFamily: `"${f}"` } }, f)));
    fontSel.value = c.text.font;
    fontSel.onchange = () => this.edit((cl) => (cl.text.font = fontSel.value), true, 'Font');
    const weights = [['300', 'Light'], ['400', 'Regular'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extra bold'], ['900', 'Black']];
    this.add(
      section(null, ta),
      section('Font',
        h('div', { class: 'row select-row' }, h('label', { for: 'text-font' }, 'Family'), fontSel),
        select({ label: 'Weight', options: weights, get: () => String(t().weight || 700), set: (v) => this.edit((cl) => (cl.text.weight = +v), true, 'Weight') }),
        this.plain('Size', () => t().size, (cl, v) => (cl.text.size = v), 12, 400, 1, (v) => Math.round(v), 'Size'),
        colorInput({ label: 'Color', get: () => t().color, set: (v, final) => this.edit((cl) => (cl.text.color = v), final, 'Text color') }),
        segmented({ label: 'Align', options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']], get: () => t().align, set: (v) => this.edit((cl) => (cl.text.align = v), true, 'Align') }),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn' + (c.text.italic ? ' on' : ''), onclick: () => this.edit((cl) => (cl.text.italic = !cl.text.italic), true, 'Italic') }, h('em', null, 'Italic')),
          h('button', { type: 'button', class: 'btn' + (c.text.uppercase ? ' on' : ''), onclick: () => this.edit((cl) => (cl.text.uppercase = !cl.text.uppercase), true, 'Uppercase') }, 'AA'),
        ),
        this.plain('Letter spacing', () => t().letterSpacing || 0, (cl, v) => (cl.text.letterSpacing = v), -10, 60, 0.5, (v) => (+v).toFixed(1), 'Spacing'),
        this.plain('Line height', () => t().lineHeight || 1.15, (cl, v) => (cl.text.lineHeight = v), 0.7, 2.5, 0.01, (v) => (+v).toFixed(2), 'Line height'),
        this.plain('Wrap width', () => t().wrap || 0, (cl, v) => (cl.text.wrap = v), 0, 1, 0.01, (v) => (v ? Math.round(v * 100) + '%' : 'off'), 'Wrap'),
      ),
    );
  }

  buildStyle(c) {
    const t = () => this.clip.text;
    const px = (v) => Math.round(v) + 'px';
    this.add(
      section('Outline',
        this.plain('Width', () => t().stroke.width, (cl, v) => (cl.text.stroke.width = v), 0, 30, 0.5, px, 'Outline'),
        colorInput({ label: 'Color', get: () => t().stroke.color, set: (v, f) => this.edit((cl) => (cl.text.stroke.color = v), f, 'Outline') }),
      ),
      section('Shadow',
        toggle({ label: 'Shadow', get: () => t().shadow.enabled, set: (v) => this.edit((cl) => (cl.text.shadow.enabled = v), true, 'Shadow') }),
        this.plain('Blur', () => t().shadow.blur, (cl, v) => (cl.text.shadow.blur = v), 0, 60, 1, px, 'Shadow'),
        this.plain('Offset X', () => t().shadow.x, (cl, v) => (cl.text.shadow.x = v), -40, 40, 1, px, 'Shadow'),
        this.plain('Offset Y', () => t().shadow.y, (cl, v) => (cl.text.shadow.y = v), -40, 40, 1, px, 'Shadow'),
      ),
      section('Glow',
        this.plain('Size', () => t().glow.size, (cl, v) => (cl.text.glow.size = v), 0, 80, 1, px, 'Glow'),
        colorInput({ label: 'Color', get: () => t().glow.color, set: (v, f) => this.edit((cl) => (cl.text.glow.color = v), f, 'Glow') }),
      ),
      section('Background',
        toggle({ label: 'Background', get: () => t().bg.enabled, set: (v) => this.edit((cl) => (cl.text.bg.enabled = v), true, 'Background') }),
        colorInput({ label: 'Color', get: () => t().bg.color, set: (v, f) => this.edit((cl) => (cl.text.bg.color = v), f, 'Background') }),
        this.plain('Opacity', () => t().bg.opacity, (cl, v) => (cl.text.bg.opacity = v), 0, 1, 0.01, (v) => Math.round(v * 100) + '%', 'Background'),
        this.plain('Padding', () => t().bg.padding, (cl, v) => (cl.text.bg.padding = v), 0, 1.5, 0.01, (v) => (+v).toFixed(2), 'Background'),
        this.plain('Corners', () => t().bg.radius, (cl, v) => (cl.text.bg.radius = v), 0, 1, 0.01, (v) => (+v).toFixed(2), 'Background'),
        segmented({ label: 'Shape', options: [['box', 'Box'], ['line', 'Per line']], get: () => t().bg.mode, set: (v) => this.edit((cl) => (cl.text.bg.mode = v), true, 'Background') }),
      ),
      section('Gradient fill',
        toggle({ label: 'Gradient', get: () => t().gradient.enabled, set: (v) => this.edit((cl) => (cl.text.gradient.enabled = v), true, 'Gradient') }),
        colorInput({ label: 'From', get: () => t().gradient.from, set: (v, f) => this.edit((cl) => (cl.text.gradient.from = v), f, 'Gradient') }),
        colorInput({ label: 'To', get: () => t().gradient.to, set: (v, f) => this.edit((cl) => (cl.text.gradient.to = v), f, 'Gradient') }),
        this.plain('Angle', () => t().gradient.angle, (cl, v) => (cl.text.gradient.angle = v), 0, 360, 1, (v) => Math.round(v) + '°', 'Gradient'),
      ),
      section('Highlight', colorInput({ label: 'Karaoke color', get: () => t().highlight || '#ffd84d', set: (v, f) => this.edit((cl) => (cl.text.highlight = v), f, 'Highlight') })),
    );
  }

  buildLetters(c) {
    const slots = [['in', 'In'], ['out', 'Out'], ['loop', 'Loop']];
    const which = this.letterSlot || 'in';
    this.add(section(null, segmented({ options: slots, get: () => which, set: (v) => { this.letterSlot = v; this.build(); } })));
    const cur = c.text.anim && c.text.anim[which];
    const setA = (id) =>
      this.edit((cl) => {
        cl.text.anim = cl.text.anim || {};
        if (!id) delete cl.text.anim[which];
        else cl.text.anim[which] = { id, duration: (cl.text.anim[which] && cl.text.anim[which].duration) || Math.min(which === 'loop' ? 1.2 : 0.9, cl.duration / 2) };
      }, true, 'Letter animation');
    if (cur) {
      this.add(section('Length', slider({ label: which === 'loop' ? 'Cycle' : 'Duration', min: 0.1, max: Math.max(0.2, c.duration), step: 0.05, format: (v) => (+v).toFixed(2) + 's', get: () => (this.clip.text.anim[which] || {}).duration || 1, set: (v, f) => this.edit((cl) => cl.text.anim[which] && (cl.text.anim[which].duration = v), f, 'Letter animation') })));
    }
    const grid = h('div', { class: 'anim-grid' }, h('button', { type: 'button', class: 'anim-chip' + (!cur ? ' on' : ''), onclick: () => setA(null) }, 'None'));
    for (const a of TEXT_ANIMS.filter((x) => x.cat === which)) grid.append(h('button', { type: 'button', class: 'anim-chip' + (cur && cur.id === a.id ? ' on' : ''), onclick: () => setA(a.id) }, h('span', { class: 'anim-demo letters' }, 'Ab'), a.name));
    this.add(grid);
  }

  buildShape(c) {
    const s = () => this.clip.shape;
    this.add(section('Shape',
      h('div', { class: 'mask-grid' }, SHAPES.map(([k, l]) => h('button', { type: 'button', class: 'btn' + (c.shape.kind === k ? ' on' : ''), onclick: () => this.edit((cl) => (cl.shape.kind = k), true, 'Shape') }, l))),
      colorInput({ label: 'Fill', get: () => s().fill, set: (v, f) => this.edit((cl) => (cl.shape.fill = v), f, 'Shape') }),
      this.plain('Fill opacity', () => s().fillOpacity ?? 1, (cl, v) => (cl.shape.fillOpacity = v), 0, 1, 0.01, (v) => Math.round(v * 100) + '%', 'Shape'),
      colorInput({ label: 'Outline', get: () => s().stroke, set: (v, f) => this.edit((cl) => (cl.shape.stroke = v), f, 'Shape') }),
      this.plain('Outline width', () => s().strokeWidth, (cl, v) => (cl.shape.strokeWidth = v), 0, 40, 0.5, (v) => (+v).toFixed(1), 'Shape'),
      this.plain('Width', () => s().w, (cl, v) => (cl.shape.w = v), 10, 2000, 1, (v) => Math.round(v), 'Shape'),
      this.plain('Height', () => s().h, (cl, v) => (cl.shape.h = v), 10, 2000, 1, (v) => Math.round(v), 'Shape'),
    ));
  }

  buildEffectClip(c) {
    const def = effectById.get(c.effect.id);
    const opts = [...effectById.values()].map((e) => [e.id, `${e.cat} · ${e.name}`]);
    this.add(section('Effect', select({ label: 'Effect', options: opts, get: () => this.clip.effect.id, set: (v) => this.edit((cl) => { cl.effect.id = v; cl.effect.params = defaultParams(effectById.get(v)); }, true, 'Effect') })));
    if (!def) return;
    this.add(section('Settings',
      ...def.params.map((pd) =>
        pd.type === 'color'
          ? colorInput({ label: pd.label, get: () => this.clip.effect.params[pd.k] ?? pd.def, set: (v, f) => this.edit((cl) => (cl.effect.params[pd.k] = v), f, 'Effect') })
          : slider({ label: pd.label, min: pd.min, max: pd.max, step: pd.step, get: () => this.clip.effect.params[pd.k] ?? pd.def, set: (v, f) => this.edit((cl) => (cl.effect.params[pd.k] = v), f, 'Effect') }),
      ),
      slider({ label: 'Mix', min: 0, max: 1, step: 0.01, format: (v) => Math.round(v * 100) + '%', get: () => this.clip.effect.mix ?? 1, set: (v, f) => this.edit((cl) => (cl.effect.mix = v), f, 'Effect mix') }),
      h('p', { class: 'hint' }, 'This effect changes every track below its own track while it plays.'),
    ));
  }

  buildProject() {
    const p = this.store.project;
    this.body = h('div', { class: 'insp-body' });
    this.root.append(h('div', { class: 'insp-head' }, h('div', { class: 'insp-title' }, h('strong', null, 'Project'))), this.body);
    const nameInput = h('input', { type: 'text', id: 'project-name', value: p.name, 'aria-label': 'Project name' });
    nameInput.onchange = () => this.store.commit('Rename', (pp) => (pp.name = nameInput.value.trim() || 'Untitled project'));
    const ratios = h('div', { class: 'ratio-grid' }, ASPECTS.map(([k, w, hh, use]) => {
      const box = h('span', { class: 'ratio-box', style: { aspectRatio: `${w} / ${hh}` } });
      return h('button', { type: 'button', class: 'ratio' + (p.aspect === k ? ' on' : ''), title: use, onclick: () => this.store.commit('Canvas size', (pp) => { pp.aspect = k; pp.width = w; pp.height = hh; }) }, box, h('b', null, k), h('small', null, use));
    }));
    const bgType = segmented({ label: 'Fill', options: [['color', 'Color'], ['blur', 'Blur'], ['gradient', 'Gradient']], get: () => this.store.project.background.type, set: (v) => this.store.commit('Background', (pp) => (pp.background.type = v)) });
    this.add(
      section('Name', nameInput),
      section('Canvas', ratios),
      section('Background',
        bgType,
        colorInput({ label: 'Color', get: () => this.store.project.background.color, set: (v, f) => this.editProject((pp) => (pp.background.color = v), f, 'Background') }),
        p.background.type === 'gradient' ? colorInput({ label: 'Second color', get: () => this.store.project.background.color2 || '#000000', set: (v, f) => this.editProject((pp) => (pp.background.color2 = v), f, 'Background') }) : null,
        p.background.type === 'blur' ? slider({ label: 'Blur', min: 0, max: 1, step: 0.01, get: () => this.store.project.background.blur ?? 0.6, set: (v, f) => this.editProject((pp) => (pp.background.blur = v), f, 'Background') }) : null,
        h('p', { class: 'hint' }, 'Blur fills the empty space around a clip with a blurred copy of it, like phone video on a wide screen.'),
      ),
      section('Frame rate', select({ label: 'FPS', options: [['24', '24'], ['25', '25'], ['30', '30'], ['50', '50'], ['60', '60']], get: () => String(this.store.project.fps), set: (v) => this.store.commit('Frame rate', (pp) => (pp.fps = +v)) })),
      section('Shortcuts', h('dl', { class: 'keys' },
        ...[['Space', 'Play / pause'], ['S or Ctrl+B', 'Split'], ['Del', 'Delete'], ['Shift+Del', 'Ripple delete'], ['Ctrl+D', 'Duplicate'], ['Ctrl+C / V', 'Copy / paste'], ['← →', 'Step one frame'], ['Shift+← →', 'Step one second'], ['Home / End', 'Start / end'], ['M', 'Marker'], ['+ / −', 'Zoom timeline'], ['Ctrl+Z', 'Undo'], ['Ctrl+Shift+Z', 'Redo'], ['Ctrl+E', 'Export']].map(([k, v]) => [h('dt', null, h('kbd', null, k)), h('dd', null, v)]).flat(),
      )),
    );
  }
}

// Plays a preset on a small square with the Web Animations API, sampled from the same tracks the renderer uses.
function playDemo(el, def) {
  if (!el.animate) return;
  const frames = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const s = evalPreset(def, i / N);
    frames.push({
      offset: i / N,
      opacity: s.opacity,
      filter: s.blur ? `blur(${(s.blur / 10).toFixed(1)}px)` : 'none',
      transform: `translate(${(s.txE * 100).toFixed(1)}%, ${(s.tyE * 100).toFixed(1)}%) translate(${(s.txP * 0.02).toFixed(1)}px, ${(s.tyP * 0.02).toFixed(1)}px) rotate(${s.rot}deg) skew(${s.skx}deg, ${s.sky}deg) scale(${(s.sx * Math.cos((s.ry * Math.PI) / 180)).toFixed(3)}, ${(s.sy * Math.cos((s.rx * Math.PI) / 180)).toFixed(3)})`,
    });
  }
  el.style.transformOrigin = `${(def.origin[0] + 0.5) * 100}% ${(def.origin[1] + 0.5) * 100}%`;
  el.animate(frames, { duration: Math.min(1400, defaultAnimDuration(def) * 1000), easing: 'linear' });
}
