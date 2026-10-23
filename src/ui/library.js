// Left panel: media, audio, text, stickers, effects, transitions, filters, templates and captions.

import { h, icon, iconButton, toast, select, slider, modal, contextMenu } from './dom.js';
import { fmtTime, findClip, clipEnd, mainTrack, transitionInfo } from '../model.js';
import * as ops from '../ops.js';
import { EFFECTS, EFFECT_CATEGORIES } from '../engine/effects.js';
import { FILTERS, FILTER_CATEGORIES } from '../engine/filters.js';
import { TRANSITIONS, transitionName } from '../engine/transitions.js';
import { renderText, SHAPES, renderShape } from '../engine/text.js';
import { TEXT_TEMPLATES, EMOJI, PROJECT_TEMPLATES, buildFromTemplate } from '../templates.js';
import { SFX, renderSfx } from '../sfx.js';
import { previewer, PREVIEW_W, PREVIEW_H } from './previewer.js';
import { WHISPER_MODELS, LANGUAGES, autoCaptions, parseSubtitles, addCaptionClips, toSrt } from '../captions.js';

const TABS = [
  ['media', 'Media', 'folder'],
  ['audio', 'Audio', 'music'],
  ['text', 'Text', 'text'],
  ['stickers', 'Stickers', 'sticker'],
  ['effects', 'Effects', 'sparkles'],
  ['transitions', 'Transitions', 'transition'],
  ['filters', 'Filters', 'filter'],
  ['templates', 'Templates', 'template'],
  ['captions', 'Captions', 'captions'],
];

const VISUAL = new Set(['video', 'image', 'text', 'sticker', 'shape']);

export class Library {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.store = app.store;
    this.media = app.media;
    this.tab = 'media';
    this.tabBtns = new Map();
    const nav = h('nav', { class: 'lib-tabs', 'aria-label': 'Library' },
      TABS.map(([k, l, ic]) => {
        const b = h('button', { type: 'button', class: 'lib-tab', title: l, onclick: () => this.show(k) }, icon(ic, 20), h('span', null, l));
        this.tabBtns.set(k, b);
        return b;
      }),
    );
    this.panel = h('div', { class: 'lib-panel' });
    root.append(nav, this.panel);
    this.media.addEventListener('change', () => this.tab === 'media' || this.tab === 'audio' ? this.render() : null);
    this.store.addEventListener('selection', () => this.updateTargetNote());
    this.store.addEventListener('change', (e) => !(e.detail && e.detail.live) && this.updateTargetNote());
    window.addEventListener('clipwave:fonts', () => {
      if (this.tab === 'text') this.panel.querySelectorAll('.tile canvas').forEach((cv, i) => TEXT_TEMPLATES[i] && this.drawTextTile(cv, TEXT_TEMPLATES[i]));
    });
    this.show('media');
  }

  show(tab) {
    this.tab = tab;
    for (const [k, b] of this.tabBtns) b.classList.toggle('on', k === tab);
    this.render();
    this.app.openDrawer && this.app.openDrawer('lib');
  }

  render() {
    const scroll = this.panel.scrollTop;
    this.panel.textContent = '';
    this.stopHover && this.stopHover();
    const fn = {
      media: () => this.renderMedia(),
      audio: () => this.renderAudio(),
      text: () => this.renderText(),
      stickers: () => this.renderStickers(),
      effects: () => this.renderEffects(),
      transitions: () => this.renderTransitions(),
      filters: () => this.renderFilters(),
      templates: () => this.renderTemplates(),
      captions: () => this.renderCaptions(),
    }[this.tab];
    fn();
    if (this.lastTab === this.tab) this.panel.scrollTop = scroll;
    this.lastTab = this.tab;
  }

  head(title, ...extra) {
    return h('div', { class: 'lib-head' }, h('h3', null, title), ...extra);
  }

  // A note under the header that says what clicking a tile will do.
  targetNote(kind) {
    const el = h('p', { class: 'target-note', 'data-kind': kind });
    this.noteEl = el;
    requestAnimationFrame(() => this.updateTargetNote());
    return el;
  }

  updateTargetNote() {
    const el = this.noteEl;
    if (!el || !el.isConnected) return;
    const f = this.store.primary();
    const kind = el.dataset.kind;
    if (kind === 'transitions') {
      const target = this.transitionTarget();
      el.textContent = target ? `Click to put it on the cut at ${fmtTime(target.clip.start, 30, true)}.` : 'Select a clip that follows another one, or put the playhead near a cut.';
      return;
    }
    el.textContent = f && VISUAL.has(f.clip.type) ? `Click to apply to the selected clip. Shift+click to add it on its own track instead.` : `Click to add it on its own track at the playhead. It changes every track below it.`;
  }

  importButton(accept = 'video/*,audio/*,image/*') {
    const input = h('input', { type: 'file', multiple: true, accept, id: 'import-input-' + this.tab, class: 'sr-only', onchange: async () => {
      const files = [...input.files];
      input.value = '';
      if (files.length) await this.app.importAndAdd(files, false);
    } });
    return h('label', { class: 'btn primary', for: input.id }, icon('upload', 16), 'Import', input);
  }

  // ---------- media ----------

  renderMedia() {
    const items = this.media.list().filter((m) => m.type !== 'audio');
    this.panel.append(this.head('Media', this.importButton()));
    const drop = h('div', { class: 'dropzone' + (items.length ? ' small' : '') }, icon('upload', 22), h('span', null, items.length ? 'Drop more files here' : 'Drop videos and photos here'), h('small', null, 'MP4, MOV, WebM, JPG, PNG, GIF. Files stay on this computer.'));
    this.wireDrop(drop);
    this.panel.append(drop);
    const grid = h('div', { class: 'media-grid' });
    for (const m of items) grid.append(this.mediaCard(m));
    this.panel.append(grid);
  }

  wireDrop(el) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('over');
      if (e.dataTransfer.files.length) await this.app.importAndAdd([...e.dataTransfer.files], false);
    });
  }

  mediaCard(m) {
    const thumb = m.thumbs && m.thumbs[0];
    const card = h(
      'div',
      { class: 'media-card ' + m.status, draggable: m.status === 'ready', tabindex: 0, title: m.error || m.name },
      h('div', { class: 'media-thumb', style: thumb ? { backgroundImage: `url(${thumb})` } : {} },
        !thumb ? icon(m.type === 'audio' ? 'music' : m.type === 'image' ? 'image' : 'film', 26) : null,
        m.status === 'loading' ? h('span', { class: 'spinner' }) : null,
        m.type !== 'image' && m.duration ? h('span', { class: 'badge' }, fmtTime(m.duration)) : null,
        m.status === 'ready' ? h('button', { type: 'button', class: 'add-btn', title: 'Add to timeline', onclick: (e) => { e.stopPropagation(); ops.addMedia(this.store, m, this.app.player.time); } }, icon('plus', 16)) : null,
      ),
      h('div', { class: 'media-name' }, m.status === 'error' ? '⚠ ' : '', m.name),
    );
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/clipwave-media', m.id);
      e.dataTransfer.effectAllowed = 'copy';
      this.app.dragMedia = m;
    });
    card.addEventListener('dblclick', () => m.status === 'ready' && ops.addMedia(this.store, m, this.app.player.time));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && m.status === 'ready') ops.addMedia(this.store, m, this.app.player.time); });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        ['Add to main track', () => ops.addMedia(this.store, m, this.app.player.time), { disabled: m.status !== 'ready' }],
        ['Add as overlay', () => ops.addMedia(this.store, m, this.app.player.time, { overlay: true }), { disabled: m.status !== 'ready' || m.type === 'audio' }],
        '-',
        ['Remove from library', () => {
          const used = this.store.project.tracks.some((t) => t.clips.some((c) => c.mediaId === m.id));
          if (used) toast('This file is used on the timeline. Delete those clips first.', 'warn');
          else this.media.remove(m.id);
        }, { danger: true }],
      ]);
    });
    return card;
  }

  // ---------- audio ----------

  renderAudio() {
    const items = this.media.list().filter((m) => m.type === 'audio');
    this.panel.append(this.head('Audio', this.importButton('audio/*,video/*')));
    const drop = h('div', { class: 'dropzone small' }, icon('music', 20), h('span', null, 'Drop music or voice recordings'));
    this.wireDrop(drop);
    this.panel.append(drop);
    if (items.length) {
      const list = h('div', { class: 'audio-list' });
      for (const m of items) {
        const row = h('div', { class: 'audio-row ' + m.status, draggable: m.status === 'ready', title: m.name },
          icon('music', 16), h('span', { class: 'name' }, m.name), h('span', { class: 'tc' }, fmtTime(m.duration)),
          m.status === 'ready' ? iconButton('plus', 'Add at playhead', () => ops.addMedia(this.store, m, this.app.player.time), { size: 15, class: 'tiny' }) : h('span', { class: 'spinner' }));
        row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/clipwave-media', m.id); this.app.dragMedia = m; });
        list.append(row);
      }
      this.panel.append(list);
    }
    this.panel.append(h('h4', { class: 'sub' }, 'Voiceover'), this.recorder());
    this.panel.append(h('h4', { class: 'sub' }, 'Sound effects'), h('p', { class: 'hint' }, 'Made on your computer, free to use anywhere.'));
    const grid = h('div', { class: 'chip-grid' });
    for (const [id, name] of SFX) {
      grid.append(h('button', { type: 'button', class: 'chip-btn', onclick: async () => {
        const blob = await renderSfx(id);
        const m = await this.media.addBlob(blob, name + '.wav');
        if (m) ops.addMedia(this.store, m, this.app.player.time);
        this.preview(blob);
      } }, icon('volume', 14), name));
    }
    this.panel.append(grid);
  }

  // Records from the microphone and drops the take on an audio track at the playhead.
  recorder() {
    const time = h('span', { class: 'rec-time' });
    const btn = h('button', { type: 'button', class: 'btn rec-btn' }, icon('mic', 15), 'Record voiceover');
    const row = h('div', { class: 'rec-row' }, btn, time);
    if (this.rec) {
      btn.classList.add('on');
      btn.lastChild.textContent = 'Stop';
    }
    btn.onclick = async () => {
      if (this.rec) {
        this.rec.stop();
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        toast('No microphone access. Allow it in the browser and try again.', 'warn', 5000);
        return;
      }
      const startAt = this.app.player.time;
      const chunks = [];
      const rec = new MediaRecorder(stream);
      this.rec = rec;
      const t0 = performance.now();
      const timer = setInterval(() => (time.textContent = fmtTime((performance.now() - t0) / 1000)), 250);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        this.rec = null;
        this.render();
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        const m = await this.media.addBlob(blob, `Voiceover ${new Date().toLocaleTimeString().replace(/:/g, '-')}.webm`);
        if (m) ops.addMedia(this.store, m, startAt);
      };
      rec.start(250);
      btn.classList.add('on');
      btn.lastChild.textContent = 'Stop';
    };
    return row;
  }

  preview(blob) {
    try {
      const a = new Audio(URL.createObjectURL(blob));
      a.play().catch(() => {});
    } catch {
      /* ignore */
    }
  }

  // ---------- text ----------

  renderText() {
    this.panel.append(this.head('Text', h('button', { type: 'button', class: 'btn primary', onclick: () => ops.addText(this.store, this.app.player.time) }, icon('plus', 16), 'Add text')));
    this.panel.append(h('p', { class: 'hint' }, 'Templates come with fonts, colors and letter animations. Edit everything after.'));
    const grid = h('div', { class: 'tile-grid' });
    for (const tpl of TEXT_TEMPLATES) {
      const cv = h('canvas', { width: PREVIEW_W, height: PREVIEW_H });
      const tile = h('button', { type: 'button', class: 'tile', title: tpl.name, onclick: () => ops.addText(this.store, this.app.player.time, tpl) }, cv, h('span', null, tpl.name));
      grid.append(tile);
      this.drawTextTile(cv, tpl);
    }
    this.panel.append(grid);
    document.fonts && document.fonts.ready.then(() => {
      if (this.tab !== 'text') return;
      grid.querySelectorAll('canvas').forEach((cv, i) => this.drawTextTile(cv, TEXT_TEMPLATES[i]));
    });
  }

  drawTextTile(cv, tpl) {
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#23262d';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const clip = { duration: 3, text: { ...tpl.text, anim: {} } };
    const r = renderText(clip, 1.5, 0.22, cv.width);
    if (!r) return;
    const k = Math.min(1, (cv.width - 12) / r.w, (cv.height - 8) / r.h);
    ctx.drawImage(r.canvas, (cv.width - r.w * k) / 2, (cv.height - r.h * k) / 2, r.w * k, r.h * k);
  }

  // ---------- stickers ----------

  renderStickers() {
    this.panel.append(this.head('Stickers'));
    for (const [cat, list] of Object.entries(EMOJI)) {
      this.panel.append(h('h4', { class: 'sub' }, cat));
      const grid = h('div', { class: 'emoji-grid' });
      for (const e of list) grid.append(h('button', { type: 'button', class: 'emoji', title: 'Add ' + e, onclick: () => this.addSticker(e) }, e));
      this.panel.append(grid);
    }
    this.panel.append(h('h4', { class: 'sub' }, 'Shapes'));
    const sg = h('div', { class: 'tile-grid small' });
    for (const [k, name] of SHAPES) {
      const cv = h('canvas', { width: 96, height: 72 });
      const r = renderShape({ shape: { kind: k, fill: '#f2b33d', stroke: '#ffffff', strokeWidth: 0, w: 260, h: k === 'line' ? 120 : 200 } }, 0.25);
      const ctx = cv.getContext('2d');
      ctx.drawImage(r.canvas, (96 - r.w) / 2, (72 - r.h) / 2);
      sg.append(h('button', { type: 'button', class: 'tile', title: name, onclick: () => {
        const c = ops.addClipOfType(this.store, 'shape', this.app.player.time, {}, 'Add shape');
        this.store.commit('Shape', (p) => { const f = findClip(p, c.id); if (f) f.clip.shape.kind = k; });
      } }, cv, h('span', null, name)));
    }
    this.panel.append(sg);
  }

  addSticker(e) {
    const c = ops.addClipOfType(this.store, 'sticker', this.app.player.time, {}, 'Add sticker');
    this.store.commit('Sticker', (p) => {
      const f = findClip(p, c.id);
      if (f) {
        f.clip.text.content = e;
        f.clip.anim = { in: { id: 'popIn', duration: 0.4 } };
      }
    });
  }

  // ---------- effects ----------

  // Lazily draws preview tiles, a few per frame, and animates the one under the pointer.
  previewGrid(items, draw, animate) {
    const grid = h('div', { class: 'tile-grid' });
    const queue = [];
    for (const it of items) {
      const cv = h('canvas', { width: PREVIEW_W, height: PREVIEW_H });
      const tile = h('button', { type: 'button', class: 'tile' + (it.on ? ' on' : ''), title: it.title || it.name, onclick: (e) => it.onClick(e) }, cv, h('span', null, it.name));
      grid.append(tile);
      queue.push([cv, it]);
      if (animate) {
        tile.addEventListener('pointerenter', () => this.hoverAnim(cv, it, animate));
        tile.addEventListener('pointerleave', () => this.stopHover && this.stopHover());
      }
    }
    const pump = () => {
      if (!grid.isConnected && queue.length) return;
      const t0 = performance.now();
      while (queue.length && performance.now() - t0 < 12) {
        const [cv, it] = queue.shift();
        draw(cv, it);
      }
      if (queue.length) requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
    return grid;
  }

  hoverAnim(cv, it, animate) {
    this.stopHover && this.stopHover();
    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      animate(cv, it, (performance.now() - t0) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    this.stopHover = () => { cancelAnimationFrame(raf); this.stopHover = null; };
  }

  renderEffects() {
    this.panel.append(this.head('Effects'), this.targetNote('effects'));
    const pv = previewer();
    for (const cat of EFFECT_CATEGORIES) {
      const defs = EFFECTS.filter((e) => e.cat === cat);
      if (!defs.length) continue;
      this.panel.append(h('h4', { class: 'sub' }, cat));
      const items = defs.map((def) => ({ def, name: def.name, onClick: (e) => this.applyEffect(def, e.shiftKey) }));
      this.panel.append(this.previewGrid(items, (cv, it) => pv.effect(cv, it.def), (cv, it, t) => pv.effect(cv, it.def, 0.5 + t)));
    }
  }

  applyEffect(def, forceTrack) {
    const f = this.store.primary();
    if (f && VISUAL.has(f.clip.type) && !forceTrack) {
      ops.applyEffectToClip(this.store, f.clip.id, def.id);
      toast(`${def.name} added to the clip`);
      this.app.showInspectorTab('effects');
    } else {
      ops.addEffectClip(this.store, def.id, this.app.player.time);
      toast(`${def.name} added on an effects track`);
    }
  }

  // ---------- transitions ----------

  transitionTarget() {
    const p = this.store.project;
    const f = this.store.primary();
    const touching = (track, c) => {
      const i = track.clips.indexOf(c);
      const prev = i > 0 ? track.clips[i - 1] : null;
      return prev && Math.abs(clipEnd(prev) - c.start) < 0.02;
    };
    if (f && f.track.type === 'video' && touching(f.track, f.clip)) return f;
    // Otherwise the cut nearest the playhead on the main track.
    const main = mainTrack(p);
    if (!main) return null;
    let best = null;
    for (const c of main.clips) {
      if (!touching(main, c)) continue;
      const d = Math.abs(c.start - this.app.player.time);
      if (!best || d < best.d) best = { d, clip: c };
    }
    return best ? findClip(p, best.clip.id) : null;
  }

  renderTransitions() {
    this.trDur = this.trDur || 0.6;
    const allBtn = h('button', { type: 'button', class: 'btn', title: 'Put the selected transition on every cut of the main track', onclick: () => {
      const cur = this.store.primary();
      const id = cur && cur.clip.transitionIn ? cur.clip.transitionIn.id : 'fade';
      this.store.commit('Transitions', (p) => {
        const main = mainTrack(p);
        main.clips.forEach((c, i) => { if (i > 0) c.transitionIn = { id, duration: this.trDur }; });
      });
      toast('Added to every cut');
    } }, 'Apply to all');
    this.panel.append(this.head('Transitions', allBtn), this.targetNote('transitions'));
    this.panel.append(slider({ label: 'Duration', min: 0.1, max: 3, step: 0.05, format: (v) => (+v).toFixed(2) + 's', get: () => this.trDur, set: (v, final) => {
      this.trDur = v;
      const target = this.transitionTarget();
      if (final && target && target.clip.transitionIn) ops.setTransition(this.store, target.clip.id, target.clip.transitionIn.id, v);
    } }));
    const target = this.transitionTarget();
    const current = target && target.clip.transitionIn ? target.clip.transitionIn.id : null;
    const pv = previewer();
    const items = [{ id: null, name: 'None', onClick: () => target && ops.setTransition(this.store, target.clip.id, null), on: !current, none: true }]
      .concat(TRANSITIONS.map((t) => ({ tr: t, name: transitionName(t), title: `${transitionName(t)} by ${t.author} (${t.license})`, on: current === t.id, onClick: () => {
        const tg = this.transitionTarget();
        if (!tg) {
          toast('Put two clips next to each other on the timeline first');
          return;
        }
        ops.setTransition(this.store, tg.clip.id, t.id, this.trDur);
        this.store.select(tg.clip.id);
        // Show it right away.
        const info = transitionInfo(findClip(this.store.project, tg.clip.id).track, findClip(this.store.project, tg.clip.id).clip);
        if (info) {
          this.app.player.range = { start: info.start - 0.3, end: info.end + 0.3 };
          this.app.player.seek(info.start - 0.3);
          this.app.player.play();
          const stop = () => { this.app.player.range = null; this.app.player.removeEventListener('state', stop); };
          this.app.player.addEventListener('state', stop);
        }
      } })));
    this.panel.append(this.previewGrid(items, (cv, it) => {
      if (it.none) {
        const g = cv.getContext('2d');
        g.fillStyle = '#23262d';
        g.fillRect(0, 0, cv.width, cv.height);
        g.fillStyle = '#7d8590';
        g.font = '600 14px system-ui';
        g.textAlign = 'center';
        g.fillText('No transition', cv.width / 2, cv.height / 2 + 5);
        return;
      }
      pv.transition(cv, it.tr, 0.45);
    }, (cv, it, t) => !it.none && pv.transition(cv, it.tr, (t % 1.6) / 1.2)));
    this.panel.append(h('p', { class: 'credit' }, 'Transitions from the open gl-transitions collection (MIT), credited to each author.'));
  }

  // ---------- filters ----------

  renderFilters() {
    this.panel.append(this.head('Filters'), this.targetNote('filters'));
    const pv = previewer();
    const f = this.store.primary();
    const current = f && f.clip.filter ? f.clip.filter.id : null;
    for (const cat of FILTER_CATEGORIES) {
      this.panel.append(h('h4', { class: 'sub' }, cat));
      const items = FILTERS.filter((x) => x.cat === cat).map((fl) => ({ fl, name: fl.name, on: current === fl.id, onClick: (e) => {
        const sel = this.store.primary();
        if (sel && VISUAL.has(sel.clip.type) && sel.clip.adjust !== undefined && !e.shiftKey) {
          this.store.commit('Filter', (p) => { const ff = findClip(p, sel.clip.id); if (ff) ff.clip.filter = { id: fl.id, intensity: (ff.clip.filter && ff.clip.filter.intensity) || 0.8 }; });
          toast(`${fl.name} applied`);
        } else {
          ops.addFilterClip(this.store, fl.id, this.app.player.time);
          toast(`${fl.name} added on an effects track`);
        }
        this.render();
      } }));
      this.panel.append(this.previewGrid(items, (cv, it) => pv.filter(cv, it.fl)));
    }
  }

  // ---------- templates ----------

  renderTemplates() {
    this.panel.append(this.head('Templates'), h('p', { class: 'hint' }, 'Pick a style, choose your clips, and get a finished edit with cuts, transitions, color and a title. It opens as a new project.'));
    const list = h('div', { class: 'tpl-list' });
    for (const tpl of PROJECT_TEMPLATES) {
      list.append(h('button', { type: 'button', class: 'tpl-card', onclick: () => this.useTemplate(tpl) },
        h('span', { class: 'tpl-ratio' }, tpl.aspect), h('strong', null, tpl.name), h('span', null, tpl.desc)));
    }
    this.panel.append(list);
  }

  useTemplate(tpl) {
    const items = this.media.list().filter((m) => (m.type === 'video' || m.type === 'image') && m.status === 'ready');
    if (!items.length) {
      toast('Import a few videos or photos first', 'warn');
      this.show('media');
      return;
    }
    const chosen = new Set(items.slice(0, 12).map((m) => m.id));
    const body = h('div', { class: 'pick-grid' }, items.map((m) => {
      const b = h('button', { type: 'button', class: 'pick' + (chosen.has(m.id) ? ' on' : ''), style: m.thumbs[0] ? { backgroundImage: `url(${m.thumbs[0]})` } : {}, title: m.name, onclick: () => {
        chosen.has(m.id) ? chosen.delete(m.id) : chosen.add(m.id);
        b.classList.toggle('on', chosen.has(m.id));
      } }, h('span', null, m.name));
      return b;
    }));
    const dlg = modal(`${tpl.name} template`, h('div', null, h('p', { class: 'hint' }, 'Clips are used in this order. Click to leave one out.'), body), [
      h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => {
        const list = items.filter((m) => chosen.has(m.id));
        if (!list.length) return toast('Pick at least one clip');
        dlg.close();
        this.app.openProject(buildFromTemplate(tpl, list));
        toast(`${tpl.name} is ready. Press Space to play.`);
      } }, 'Create edit'),
    ]);
  }

  // ---------- captions ----------

  renderCaptions() {
    this.cap = this.cap || { model: WHISPER_MODELS[0][0], language: '', style: 'Subtitle', maxWords: 7 };
    const st = this.cap;
    const status = h('p', { class: 'cap-status', role: 'status' });
    const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
    const run = h('button', { type: 'button', class: 'btn primary wide', onclick: async () => {
      run.disabled = true;
      bar.classList.add('show');
      try {
        const n = await autoCaptions(this.app, st, (p, msg) => {
          status.textContent = msg + (p > 0 && p < 1 ? ` ${Math.round(p * 100)}%` : '');
          bar.firstChild.style.width = Math.round(p * 100) + '%';
        });
        toast(`Added ${n} captions`);
      } catch (e) {
        status.textContent = e.message;
        toast(e.message, 'error', 6000);
      } finally {
        run.disabled = false;
        bar.classList.remove('show');
      }
    } }, icon('wand', 16), 'Generate captions');
    const styles = ['Subtitle', 'Karaoke', 'Word Pop', 'Meme Caption'].map((s) => [s, s]);
    const fileIn = h('input', { type: 'file', accept: '.srt,.vtt,text/vtt', id: 'srt-input', class: 'sr-only', onchange: async () => {
      const f = fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      const lines = parseSubtitles(await f.text());
      if (!lines.length) return toast('No captions found in that file', 'warn');
      addCaptionClips(this.app, lines, st.style);
      toast(`Imported ${lines.length} captions`);
    } });
    this.panel.append(
      this.head('Captions'),
      h('p', { class: 'hint' }, 'Speech to text runs on your computer with Whisper. The model downloads once, then works offline.'),
      select({ label: 'Model', options: WHISPER_MODELS, get: () => st.model, set: (v) => (st.model = v) }),
      select({ label: 'Language', options: LANGUAGES, get: () => st.language, set: (v) => (st.language = v) }),
      select({ label: 'Style', options: styles, get: () => st.style, set: (v) => (st.style = v) }),
      slider({ label: 'Words per line', min: 2, max: 14, step: 1, get: () => st.maxWords, set: (v) => (st.maxWords = v) }),
      run, bar, status,
      h('h4', { class: 'sub' }, 'Subtitle files'),
      h('div', { class: 'btn-row' },
        h('label', { class: 'btn', for: 'srt-input' }, icon('upload', 15), 'Import SRT / VTT', fileIn),
        h('button', { type: 'button', class: 'btn', onclick: () => {
          const srt = toSrt(this.store.project);
          if (!srt.trim()) return toast('There are no text clips to export');
          this.app.saveFile(new Blob([srt], { type: 'text/plain' }), (this.store.project.name || 'captions') + '.srt');
        } }, icon('export', 15), 'Export SRT'),
      ),
    );
  }
}

