// Editor state: the project, selection, undo history and autosave.

import { snapshot, restore, findClip, packMain, sortClips, newProject } from './model.js';
import { db } from './db.js';

const MAX_UNDO = 120;

export class Store extends EventTarget {
  constructor() {
    super();
    this.project = newProject();
    this.selection = [];
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.saveTimer = 0;
    this.clipboard = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setProject(p) {
    this.project = p;
    this.selection = [];
    this.undoStack = [];
    this.redoStack = [];
    this.emit('project');
    this.emit('selection');
  }

  // A discrete change with one undo step.
  commit(label, fn) {
    const before = this.pending ? this.pending.snap : snapshot(this.project);
    this.pending = null;
    fn(this.project);
    this.normalize();
    const after = snapshot(this.project);
    if (after === before) return;
    this.undoStack.push({ label, snap: before });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.changed();
  }

  // Continuous edits (dragging a slider or a clip): call live() repeatedly, then end().
  live(fn) {
    if (!this.pending) this.pending = { snap: snapshot(this.project) };
    fn(this.project);
    this.emit('change', { live: true });
  }

  end(label) {
    if (!this.pending) return;
    const before = this.pending.snap;
    this.pending = null;
    this.normalize();
    if (snapshot(this.project) !== before) {
      this.undoStack.push({ label, snap: before });
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      this.redoStack = [];
    }
    this.changed();
  }

  cancelLive() {
    if (!this.pending) return;
    this.project = restore(this.pending.snap);
    this.pending = null;
    this.changed();
  }

  normalize() {
    const p = this.project;
    for (const t of p.tracks) sortClips(t);
    packMain(p);
    // Drop empty non-main tracks, except the one just created on purpose.
    p.tracks = p.tracks.filter((t) => t.main || t.clips.length || t.keep);
    for (const t of p.tracks) delete t.keep;
    this.selection = this.selection.filter((id) => findClip(p, id));
  }

  changed() {
    this.project.updated = Date.now();
    this.emit('change', { live: false });
    this.scheduleSave();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push({ label: s.label, snap: snapshot(this.project) });
    this.project = restore(s.snap);
    this.selection = this.selection.filter((id) => findClip(this.project, id));
    this.changed();
    this.emit('selection');
    return s.label;
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push({ label: s.label, snap: snapshot(this.project) });
    this.project = restore(s.snap);
    this.selection = this.selection.filter((id) => findClip(this.project, id));
    this.changed();
    this.emit('selection');
    return s.label;
  }

  select(ids, additive = false) {
    ids = Array.isArray(ids) ? ids : ids ? [ids] : [];
    if (additive) {
      const set = new Set(this.selection);
      for (const id of ids) set.has(id) ? set.delete(id) : set.add(id);
      this.selection = [...set];
    } else this.selection = ids;
    this.emit('selection');
  }

  selectedClips() {
    return this.selection.map((id) => findClip(this.project, id)).filter(Boolean);
  }

  primary() {
    const id = this.selection[this.selection.length - 1];
    return id ? findClip(this.project, id) : null;
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 600);
  }

  async save() {
    const p = this.project;
    await db.put('projects', JSON.parse(snapshot(p)));
    try {
      localStorage.setItem('clipwave:last', p.id);
    } catch {
      /* storage blocked */
    }
  }
}
