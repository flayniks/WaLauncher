// The editor shell: layout, project handling, shortcuts and wiring between panels.

import { h, icon, iconButton, toast, modal, contextMenu, downloadBlob } from './dom.js';
import { Store } from '../store.js';
import { MediaLibrary } from '../media.js';
import { Renderer } from '../engine/renderer.js';
import { Player } from '../engine/playback.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';
import { Library } from './library.js';
import { Preview } from './preview.js';
import { openExport } from './export.js';
import { demoProject } from '../templates.js';
import { newProject, ASPECTS, projectDuration, clipEnd, fmtTime } from '../model.js';
import { db } from '../db.js';
import { googleFontsHref } from '../engine/text.js';
import * as ops from '../ops.js';
import { loadLuts, onLutsChange } from '../luts.js';
import { desktop } from '../net.js';

export class App {
  constructor(root) {
    this.root = root;
    this.store = new Store();
    this.media = new MediaLibrary();
    this.downloads = window.claude && typeof window.claude.use === 'function' ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
  }

  async init() {
    loadFonts();
    const canvas = document.createElement('canvas');
    try {
      this.renderer = new Renderer(canvas);
    } catch (e) {
      this.root.append(h('div', { class: 'fatal' }, h('h1', null, 'Clipwave needs WebGL2'), h('p', null, 'Open it in a recent Chrome, Edge, Firefox or Safari with hardware acceleration turned on.')));
      return;
    }
    this.player = new Player(this.renderer, () => this.store.project, this.media);
    await this.media.load();
    await loadLuts();
    onLutsChange(() => this.player.invalidate());
    await this.loadInitialProject();
    this.buildLayout();
    this.bindKeys();
    this.store.addEventListener('change', () => this.updateTitle());
    this.store.addEventListener('project', () => this.updateTitle());
    this.updateTitle();
    window.addEventListener('beforeunload', () => this.store.save());
    if (document.fonts) document.fonts.ready.then(() => this.player.invalidate());
  }

  async loadInitialProject() {
    let id = null;
    try {
      id = localStorage.getItem('clipwave:last');
    } catch {
      /* storage blocked */
    }
    const saved = id ? await db.get('projects', id) : null;
    if (saved && saved.tracks) {
      this.store.setProject(saved);
      // Drop clips whose media is gone (cleared storage).
      this.store.project.tracks.forEach((t) => (t.clips = t.clips.filter((c) => !c.mediaId || this.media.get(c.mediaId))));
    } else {
      this.store.setProject(demoProject());
      // Open on a frame where the welcome title is on screen.
      this.player.seek(1.6);
    }
  }

  buildLayout() {
    const brand = h('button', { type: 'button', class: 'brand', title: 'Projects', onclick: (e) => this.projectMenu(e) }, h('span', { class: 'logo', 'aria-hidden': 'true' }), h('span', { class: 'brand-name' }, 'Clipwave'), icon('chevronRight', 14));
    this.titleEl = h('span', { class: 'proj-title' });
    this.saveEl = h('span', { class: 'save-state' });
    const exportBtn = h('button', { type: 'button', class: 'btn primary export-btn', onclick: () => openExport(this), title: 'Export (Ctrl+E)' }, icon('export', 16), h('span', null, 'Export'));
    const libToggle = iconButton('layers', 'Library', () => this.toggleDrawer('lib'), { class: 'mobile-only' });
    const inspToggle = iconButton('sliders', 'Properties', () => this.toggleDrawer('insp'), { class: 'mobile-only' });
    const top = h('header', { class: 'topbar' }, brand, this.titleEl, this.saveEl, h('span', { class: 'spacer' }), libToggle, inspToggle, exportBtn);

    this.libEl = h('aside', { class: 'lib', 'aria-label': 'Library' });
    this.previewEl = h('main', { class: 'preview', 'aria-label': 'Preview' });
    this.inspEl = h('aside', { class: 'insp', 'aria-label': 'Properties' });
    this.timelineEl = h('section', { class: 'timeline', 'aria-label': 'Timeline' });
    const splitter = h('div', { class: 'splitter', title: 'Drag to resize', role: 'separator', 'aria-orientation': 'horizontal' });
    this.layout = h('div', { class: 'app' }, top, h('div', { class: 'work' }, this.libEl, this.previewEl, this.inspEl), splitter, this.timelineEl);
    this.root.append(this.layout);
    this.wireSplitter(splitter);

    for (const [el, which] of [[this.libEl, 'lib'], [this.inspEl, 'insp']]) el.append(iconButton('close', 'Close', () => this.toggleDrawer(which), { class: 'drawer-close' }));
    this.library = new Library(this.libEl, this);
    this.preview = new Preview(this.previewEl, this);
    this.inspector = new Inspector(this.inspEl, this);
    this.timeline = new Timeline(this.timelineEl, this);
    setTimeout(() => this.timeline.fit(), 50);

    // Files dropped anywhere outside the panels land in the library and on the timeline.
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.target.closest && e.target.closest('.tl-canvas, .dropzone')) return;
      if (e.dataTransfer && e.dataTransfer.files.length) this.importAndAdd([...e.dataTransfer.files], true);
    });
  }

  wireSplitter(el) {
    let start = null;
    const saved = (() => {
      try {
        return +localStorage.getItem('clipwave:tl-h') || 0;
      } catch {
        return 0;
      }
    })();
    if (saved) this.layout.style.setProperty('--tl-h', saved + 'px');
    el.addEventListener('pointerdown', (e) => {
      start = { y: e.clientY, h: this.timelineEl.getBoundingClientRect().height };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      const hh = Math.max(140, Math.min(innerHeight - 260, start.h - (e.clientY - start.y)));
      this.layout.style.setProperty('--tl-h', hh + 'px');
    });
    el.addEventListener('pointerup', () => {
      if (!start) return;
      start = null;
      try {
        localStorage.setItem('clipwave:tl-h', Math.round(this.timelineEl.getBoundingClientRect().height));
      } catch {
        /* ignore */
      }
    });
  }

  updateTitle() {
    if (!this.titleEl) return;
    const p = this.store.project;
    this.titleEl.textContent = p.name;
    this.saveEl.textContent = `${p.aspect} · ${fmtTime(projectDuration(p))}`;
    document.title = `${p.name} · Clipwave`;
  }

  // ---------- projects ----------

  async projectMenu(e) {
    const all = ((await db.all('projects')) || []).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const cur = this.store.project;
    const items = [
      ['New project…', () => this.newProjectDialog()],
      ['Duplicate project', () => {
        const copy = JSON.parse(JSON.stringify(cur));
        copy.id = Math.random().toString(36).slice(2);
        copy.name = cur.name + ' copy';
        this.openProject(copy);
      }],
      ['Open the welcome demo', () => this.openProject(demoProject())],
      '-',
      ...all.slice(0, 8).map((p) => [(p.id === cur.id ? '● ' : '') + p.name, () => p.id !== cur.id && this.openProject(p), { key: new Date(p.updated || p.created).toLocaleDateString() }]),
      '-',
      ['Delete this project', () => this.deleteProject(), { danger: true }],
    ];
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, items);
  }

  newProjectDialog() {
    const grid = h('div', { class: 'ratio-grid big' }, ASPECTS.map(([k, w, hh, use]) =>
      h('button', { type: 'button', class: 'ratio', onclick: () => { dlg.close(); this.openProject(newProject('Untitled project', k)); } },
        h('span', { class: 'ratio-box', style: { aspectRatio: `${w} / ${hh}` } }), h('b', null, k), h('small', null, use))));
    const dlg = modal('New project', h('div', null, h('p', { class: 'hint' }, 'Pick a shape. You can change it later in the project settings.'), grid));
  }

  async openProject(p) {
    await this.store.save();
    this.player.pause();
    this.player.seek(0);
    this.store.setProject(p);
    this.store.changed();
    this.player.invalidate();
    setTimeout(() => this.timeline && this.timeline.fit(), 30);
  }

  async deleteProject() {
    const cur = this.store.project;
    const dlg = modal('Delete project?', h('p', null, `“${cur.name}” will be gone for good. Your imported files stay in the library.`), [
      h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Keep it'),
      h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        dlg.close();
        await db.del('projects', cur.id);
        const rest = ((await db.all('projects')) || []).filter((p) => p.id !== cur.id).sort((a, b) => (b.updated || 0) - (a.updated || 0));
        this.store.setProject(rest[0] || newProject());
        this.store.changed();
        toast('Project deleted');
      } }, 'Delete'),
    ]);
  }

  // ---------- actions ----------

  async importAndAdd(files, addToTimeline = true) {
    toast(`Importing ${files.length} file${files.length > 1 ? 's' : ''}…`);
    const list = await this.media.importFiles(files);
    const failed = files.length - list.length;
    if (failed) toast(`${failed} file${failed > 1 ? 's' : ''} could not be read`, 'warn', 5000);
    if (addToTimeline) {
      let t = this.player.time;
      for (const m of list) {
        const c = ops.addMedia(this.store, m, t);
        if (c && m.type !== 'audio') t = c.start + c.duration;
      }
    } else if (list.length) toast(`Added to the library. Click + or drag to the timeline.`);
    return list;
  }

  async saveFile(blob, name) {
    if (desktop) {
      try {
        const where = await desktop.saveFile(name, await blob.arrayBuffer());
        if (where) toast('Saved to ' + where, 'info', 4000);
      } catch (e) {
        toast((e && e.message) || 'Could not save the file', 'error');
      }
      return;
    }
    const dl = await Promise.race([this.downloads, new Promise((r) => setTimeout(() => r(null), 1500))]);
    if (dl) {
      try {
        await dl.save({ filename: name, data: blob });
        toast('Saved ' + name);
      } catch (e) {
        if (e && e.code === 'declined') return;
        if (e && e.code === 'rejected_extension') toast('This file type cannot be saved from here. Use the downloaded app for it.', 'warn', 6000);
        else toast((e && e.message) || 'Could not save the file', 'error');
      }
      return;
    }
    downloadBlob(blob, name);
  }

  undo() {
    const l = this.store.undo();
    if (l) toast('Undid ' + l.toLowerCase());
  }

  redo() {
    const l = this.store.redo();
    if (l) toast('Redid ' + l.toLowerCase());
  }

  step(frames) {
    const fps = this.store.project.fps || 30;
    this.player.pause();
    this.player.seek(Math.round(this.player.time * fps + frames) / fps);
  }

  cuts() {
    const set = new Set([0]);
    for (const t of this.store.project.tracks) for (const c of t.clips) { set.add(+c.start.toFixed(4)); set.add(+clipEnd(c).toFixed(4)); }
    return [...set].sort((a, b) => a - b);
  }

  jumpCut(dir) {
    const t = this.player.time;
    const cuts = this.cuts();
    const next = dir > 0 ? cuts.find((c) => c > t + 1e-3) : [...cuts].reverse().find((c) => c < t - 1e-3);
    if (next !== undefined) this.player.seek(next);
  }

  showTab(tab) {
    this.library.show(tab);
  }

  showInspectorTab(tab) {
    const f = this.store.primary();
    if (!f) return;
    this.inspector.tab[f.clip.type] = tab;
    this.inspector.build();
    this.openDrawer('insp');
  }

  focusInspector() {
    this.openDrawer('insp');
    const first = this.inspEl.querySelector('input, textarea, select, button');
    if (first) first.focus({ preventScroll: true });
  }

  openDrawer(which) {
    if (!this.layout || innerWidth > 960) return;
    this.layout.classList.toggle('drawer-lib', which === 'lib');
    this.layout.classList.toggle('drawer-insp', which === 'insp');
  }

  toggleDrawer(which) {
    const cls = 'drawer-' + which;
    const on = !this.layout.classList.contains(cls);
    this.layout.classList.remove('drawer-lib', 'drawer-insp');
    if (on) this.layout.classList.add(cls);
  }

  bindKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const s = this.store;
      const k = e.key;
      const run = (fn) => {
        e.preventDefault();
        fn();
      };
      if (k === ' ') return run(() => this.player.toggle());
      if (mod && k.toLowerCase() === 'z' && !e.shiftKey) return run(() => this.undo());
      if (mod && (k.toLowerCase() === 'y' || (k.toLowerCase() === 'z' && e.shiftKey))) return run(() => this.redo());
      if (mod && k.toLowerCase() === 'e') return run(() => openExport(this));
      if (mod && k.toLowerCase() === 'c') return run(() => ops.copySelected(s) && toast('Copied'));
      if (mod && k.toLowerCase() === 'x') return run(() => ops.copySelected(s) && ops.deleteSelected(s));
      if (mod && k.toLowerCase() === 'v') return run(() => ops.paste(s, this.player.time));
      if (mod && k.toLowerCase() === 'd') return run(() => ops.duplicateSelected(s));
      if (mod && k.toLowerCase() === 'a') return run(() => s.select(s.project.tracks.flatMap((t) => t.clips.map((c) => c.id))));
      if (mod && k.toLowerCase() === 'b') return run(() => ops.splitAt(s, this.player.time));
      if (mod) return;
      if (k === 's' || k === 'S') return run(() => ops.splitAt(s, this.player.time) || toast('Put the playhead over a clip to split it'));
      if (k === 'Delete' || k === 'Backspace') return run(() => ops.deleteSelected(s, e.shiftKey));
      if (k === 'ArrowLeft') return run(() => (e.shiftKey ? this.player.seek(this.player.time - 1) : this.step(-1)));
      if (k === 'ArrowRight') return run(() => (e.shiftKey ? this.player.seek(this.player.time + 1) : this.step(1)));
      if (k === 'ArrowUp') return run(() => this.jumpCut(-1));
      if (k === 'ArrowDown') return run(() => this.jumpCut(1));
      if (k === 'Home') return run(() => this.player.seek(0));
      if (k === 'End') return run(() => this.player.seek(projectDuration(s.project)));
      if (k === 'm' || k === 'M') return run(() => ops.setMarker(s, this.player.time));
      if (k === 'n' || k === 'N') return run(() => { this.timeline.snap = !this.timeline.snap; this.timeline.updateToolbar(); toast(this.timeline.snap ? 'Snapping on' : 'Snapping off'); });
      if (k === '+' || k === '=') return run(() => this.timeline.setZoom(this.timeline.pps * 1.4));
      if (k === '-' || k === '_') return run(() => this.timeline.setZoom(this.timeline.pps / 1.4));
      if (k === 'k' || k === 'K') return run(() => this.player.pause());
      if (k === 'l' || k === 'L') return run(() => this.player.play());
      if (k === 'j' || k === 'J') return run(() => this.player.seek(this.player.time - 2));
      if (k === 'Escape') return run(() => s.select([]));
    });
  }
}

function loadFonts() {
  if (document.querySelector('link[data-fonts]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = googleFontsHref();
  link.dataset.fonts = '1';
  document.head.append(link);
}

