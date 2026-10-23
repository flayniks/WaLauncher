// Inspector panels for the heavier tools: background cutout, stabilization, reverse and read-aloud.

import { h, icon, slider, segmented, section, toast, select } from './dom.js';
import { findClip, makeClip } from '../model.js';
import { loadMatte, matteReady } from '../ai.js';
import { analyzeShake } from '../stabilize.js';
import { reverseMedia, swapToReversed } from '../reverse.js';
import { speak, VOICES } from '../tts.js';
import { trackWithSpace } from '../ops.js';

// A button that runs a long job with a progress bar and a way to cancel it.
export function jobButton(label, iconName, run, { primary = false } = {}) {
  const status = h('p', { class: 'job-status', role: 'status' });
  const fill = h('div', { class: 'progress-fill' });
  const bar = h('div', { class: 'progress' }, fill);
  let ctrl = null;
  const btn = h('button', { type: 'button', class: 'btn wide' + (primary ? ' primary' : '') }, icon(iconName, 15), h('span', null, label));
  const progress = (p, msg) => {
    fill.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
    status.textContent = (msg || 'Working') + (p > 0 && p < 1 ? ` ${Math.round(p * 100)}%` : '');
  };
  btn.onclick = async () => {
    if (ctrl) {
      ctrl.abort();
      return;
    }
    ctrl = new AbortController();
    btn.lastChild.textContent = 'Cancel';
    bar.classList.add('show');
    progress(0, 'Starting');
    try {
      const msg = await run(progress, ctrl.signal);
      status.textContent = msg || 'Done';
      if (msg) toast(msg);
    } catch (e) {
      status.textContent = e.name === 'AbortError' ? 'Canceled' : e.message;
      if (e.name !== 'AbortError') {
        console.error(e);
        toast(e.message, 'error', 7000);
      }
    } finally {
      ctrl = null;
      btn.lastChild.textContent = label;
      bar.classList.remove('show');
    }
  };
  return h('div', { class: 'job' }, btn, bar, status);
}

export function buildCutout(insp, c) {
  const pct = (v) => Math.round(v * 100) + '%';
  const cut = () => insp.clip.cutout || {};
  const mode = (c.cutout && c.cutout.mode) || 'off';
  const note = h('p', { class: 'hint' });
  const setMode = (v) => {
    insp.edit((cl) => (cl.cutout = { threshold: 0.5, softness: 0.2, blur: 0.5, ...(cl.cutout || {}), mode: v }), true, 'Background');
    if (v !== 'off' && !matteReady()) {
      toast('Loading the person cutout model…');
      loadMatte().then(
        () => toast('Background removal is ready'),
        (e) => toast(e.message, 'error', 7000),
      );
    }
  };
  note.textContent = matteReady() || mode === 'off' ? 'Finds people in the picture on your computer, no green screen needed. Put another clip on the track below to replace the background.' : 'Loading the model (about 250 KB, once)…';
  insp.add(section('Background',
    segmented({ options: [['off', 'Off'], ['remove', 'Remove'], ['blur', 'Blur']], get: () => (insp.clip.cutout && insp.clip.cutout.mode) || 'off', set: setMode }),
    note,
  ));
  if (mode === 'off') return;
  insp.add(section('Edge',
    slider({ label: 'Threshold', min: 0.05, max: 0.95, step: 0.01, format: pct, get: () => cut().threshold ?? 0.5, set: (v, f) => insp.edit((cl) => (cl.cutout.threshold = v), f, 'Cutout') }),
    slider({ label: 'Softness', min: 0.01, max: 0.8, step: 0.01, format: pct, get: () => cut().softness ?? 0.2, set: (v, f) => insp.edit((cl) => (cl.cutout.softness = v), f, 'Cutout') }),
    mode === 'blur' ? slider({ label: 'Blur', min: 0, max: 1, step: 0.01, format: pct, get: () => cut().blur ?? 0.5, set: (v, f) => insp.edit((cl) => (cl.cutout.blur = v), f, 'Cutout') }) : null,
  ));
}

export function buildStabilize(insp, c) {
  const m = insp.app.media.get(c.mediaId);
  const st = () => insp.clip.stab;
  insp.strength = insp.strength ?? 0.5;
  insp.add(section('Stabilize',
    h('p', { class: 'hint' }, 'Measures the camera shake in this clip and smooths it out. The picture zooms in a little to hide the edges.'),
    slider({ label: 'Smoothness', min: 0, max: 1, step: 0.05, format: (v) => Math.round(v * 100) + '%', get: () => insp.strength, set: (v) => (insp.strength = v) }),
    jobButton(c.stab ? 'Analyze again' : 'Stabilize', 'wand', async (progress, signal) => {
      if (!m) throw new Error('The media for this clip is missing.');
      const clip = insp.clip;
      const from = clip.in || 0;
      const to = Math.min(m.duration, from + clip.duration * (clip.speed || 1));
      const res = await analyzeShake(m.blob, from, to, insp.strength, (p) => progress(p, 'Measuring shake'), signal);
      const id = clip.id;
      insp.store.commit('Stabilize', (p) => {
        const f = findClip(p, id);
        if (f) f.clip.stab = { enabled: true, zoom: res.zoom, strength: insp.strength, data: res.data };
      });
      return `Stabilized. Largest correction ${(res.maxShift * 100).toFixed(1)}% of the frame.`;
    }, { primary: !c.stab }),
  ));
  if (!c.stab) return;
  insp.add(section('Result',
    h('div', { class: 'row toggle-row' }, h('label', { for: 'stab-on' }, 'Stabilization on'),
      Object.assign(h('input', { type: 'checkbox', id: 'stab-on', class: 'switch', checked: c.stab.enabled }), { onchange: (e) => insp.edit((cl) => (cl.stab.enabled = e.target.checked), true, 'Stabilize') })),
    slider({ label: 'Zoom', min: 1, max: 1.5, step: 0.005, format: (v) => Math.round(v * 100) + '%', get: () => (st() ? st().zoom : 1), set: (v, f) => insp.edit((cl) => cl.stab && (cl.stab.zoom = v), f, 'Stabilize zoom') }),
    h('button', { type: 'button', class: 'btn ghost', onclick: () => insp.edit((cl) => (cl.stab = null), true, 'Remove stabilization') }, 'Remove'),
  ));
}

export function reverseSection(insp, c) {
  const m = insp.app.media.get(c.mediaId);
  const isReversed = m && m.reverseOf;
  return section('Reverse',
    h('p', { class: 'hint' }, isReversed ? 'This clip plays backwards. Reverse again to go back to the original file.' : 'Makes a backwards copy of the file (picture and sound) and swaps it in.'),
    jobButton(isReversed ? 'Play forwards again' : 'Reverse clip', 'loop', async (progress, signal) => {
      const lib = insp.app.media;
      const clip = insp.clip;
      const cur = lib.get(clip.mediaId);
      if (!cur) throw new Error('The media for this clip is missing.');
      let target = cur.reverseOf ? lib.get(cur.reverseOf) : cur.reversedId ? lib.get(cur.reversedId) : null;
      if (!target) target = await reverseMedia(lib, cur, (p) => progress(p, 'Rendering backwards'), signal);
      const id = clip.id;
      insp.store.commit('Reverse', (p) => {
        const f = findClip(p, id);
        if (f) swapToReversed(f.clip, cur, target);
      });
      return target.reverseOf ? 'Clip reversed' : 'Back to the original';
    }),
  );
}

export function readAloudSection(insp, c) {
  insp.voice = insp.voice || 'af_heart';
  return section('Read aloud',
    select({ label: 'Voice', options: VOICES, get: () => insp.voice, set: (v) => (insp.voice = v) }),
    jobButton('Make voiceover from this text', 'mic', async (progress) => {
      const clip = insp.clip;
      const blob = await speak(clip.text.content, { voice: insp.voice }, progress);
      const m = await insp.app.media.addBlob(blob, `Voice - ${clip.text.content.slice(0, 24).replace(/[\\/:*?"<>|\n]/g, ' ')}.wav`);
      if (!m) throw new Error('The voice clip could not be added.');
      const start = clip.start;
      insp.store.commit('Read aloud', (p) => {
        const a = makeClip('audio', { mediaId: m.id, start, duration: m.duration, name: m.name });
        trackWithSpace(p, 'audio', start, start + m.duration).clips.push(a);
      });
      return 'Voiceover added under the text';
    }),
    h('p', { class: 'hint' }, 'English voices by Kokoro, made on your computer. The voice model downloads once (about 90 MB).'),
  );
}
