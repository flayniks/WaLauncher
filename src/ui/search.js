// Library panel: search free songs, sound effects and photos (Openverse) and drop them on the timeline.

import { h, icon, iconButton, toast, segmented, select } from './dom.js';
import { fmtTime } from '../model.js';
import * as ops from '../ops.js';
import { searchAudio, searchPhotos, importResult, resolveResult } from '../stock.js';
import { openExternal } from '../net.js';

let previewAudio = null;
let playingId = null;

function stopPreview() {
  if (previewAudio) previewAudio.pause();
  playingId = null;
}

export function renderSearch(lib) {
  const st = (lib.search = lib.search || { kind: 'music', q: '', results: [], page: 1, pages: 1, total: 0, shape: '', commercial: false, status: '' });
  const panel = lib.panel;
  const status = h('p', { class: 'search-status', role: 'status' }, st.status);
  const input = h('input', { type: 'search', id: 'stock-q', placeholder: st.kind === 'image' ? 'Try: city at night, beach, coffee' : st.kind === 'sounds' ? 'Try: whoosh, applause, rain' : 'Try: lofi, epic, happy ukulele', value: st.q, 'aria-label': 'Search' });
  const results = h('div', { class: st.kind === 'image' ? 'photo-grid' : 'song-list' });

  const run = async (more = false) => {
    const q = input.value.trim();
    if (!q) {
      input.focus();
      return;
    }
    st.q = q;
    const page = more ? st.page + 1 : 1;
    status.textContent = 'Searching…';
    try {
      const res = st.kind === 'image' ? await searchPhotos(q, { page, shape: st.shape, commercial: st.commercial }) : await searchAudio(q, { kind: st.kind, page, commercial: st.commercial });
      st.results = more ? st.results.concat(res.results) : res.results;
      st.page = page;
      st.pages = res.pages;
      st.total = res.total;
      st.status = (res.total ? `${res.total.toLocaleString()} results` : 'Nothing found. Try other words.') + (res.note ? ' · ' + res.note : '');
    } catch (e) {
      st.status = e.message || 'Search failed. Check your connection.';
    }
    lib.render();
  };

  const kindSeg = segmented({ options: [['music', 'Songs'], ['sounds', 'Sounds'], ['image', 'Photos']], get: () => st.kind, set: (v) => {
    if (v === st.kind) return;
    stopPreview();
    Object.assign(st, { kind: v, results: [], page: 1, pages: 1, total: 0, status: '' });
    lib.render();
    if (st.q) run();
  } });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && run());
  const go = h('button', { type: 'button', class: 'btn primary', onclick: () => run() }, icon('search', 15), 'Search');
  const commercial = h('label', { class: 'check' }, Object.assign(h('input', { type: 'checkbox', id: 'stock-commercial', checked: st.commercial }), { onchange: (e) => { st.commercial = e.target.checked; if (st.q) run(); } }), 'Only ones I can use in videos that make money');

  panel.append(
    h('div', { class: 'lib-head' }, h('h3', null, 'Search')),
    kindSeg,
    h('div', { class: 'search-row' }, input, go),
    st.kind === 'image' ? select({ label: 'Shape', options: [['', 'Any'], ['wide', 'Wide'], ['tall', 'Tall'], ['square', 'Square']], get: () => st.shape, set: (v) => { st.shape = v; if (st.q) run(); } }) : null,
    commercial,
    status,
    results,
  );

  for (const r of st.results) results.append(r.kind === 'image' ? photoCard(lib, r) : songRow(lib, r));
  if (st.results.length && st.page < st.pages) panel.append(h('button', { type: 'button', class: 'btn wide', onclick: () => run(true) }, 'Load more'));
  const link = (href, text) => h('a', { href, onclick: (e) => { e.preventDefault(); openExternal(href); } }, text);
  panel.append(h('p', { class: 'credit' }, 'Free Creative Commons media from ', link('https://openverse.org', 'Openverse'), ', ', link('https://archive.org', 'Internet Archive'), ' and ', link('https://commons.wikimedia.org', 'Wikimedia Commons'), '. Credit the creators when you post: Export shows the credit lines for everything you used.'));
  if (!st.results.length && !st.q) setTimeout(() => input.focus({ preventScroll: true }), 30);
}

async function add(lib, r, btn) {
  if (btn) {
    btn.disabled = true;
    btn.classList.add('busy');
  }
  try {
    const m = await importResult(lib.media, r);
    ops.addMedia(lib.store, m, lib.app.player.time);
    toast(`Added “${r.title}” by ${r.creator}`);
  } catch (e) {
    toast(e.message || 'Could not download that file', 'error', 6000);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }
}

function songRow(lib, r) {
  const play = iconButton(playingId === r.id ? 'pause' : 'play', 'Preview', () => {
    if (playingId === r.id) {
      stopPreview();
      play.replaceChildren(icon('play', 16));
      return;
    }
    stopPreview();
    document.querySelectorAll('.song-row .ibtn.playing').forEach((b) => { b.classList.remove('playing'); b.replaceChildren(icon('play', 16)); });
    previewAudio = previewAudio || new Audio();
    resolveResult(r).then(() => {
      if (playingId !== r.id) return;
      previewAudio.src = r.url;
      previewAudio.play().catch(() => toast('This preview could not play here.', 'warn'));
    }, (e) => toast(e.message, 'warn'));
    previewAudio.onended = () => { playingId = null; play.replaceChildren(icon('play', 16)); play.classList.remove('playing'); };
    playingId = r.id;
    play.classList.add('playing');
    play.replaceChildren(icon('pause', 16));
  }, { size: 16, class: 'tiny' });
  const addBtn = iconButton('plus', 'Add to timeline', () => add(lib, r, addBtn), { size: 16, class: 'tiny add' });
  return h('div', { class: 'song-row', title: r.credit.attribution },
    play,
    h('div', { class: 'song-info' }, h('span', { class: 'name' }, r.title), h('span', { class: 'by' }, r.creator + (r.duration ? ' · ' + fmtTime(r.duration) : ''))),
    h('span', { class: 'lic' + (r.commercial ? '' : ' nc'), title: r.commercial ? 'Free to use, with credit' : 'Free for non-commercial videos, with credit' }, r.licenseLabel),
    addBtn,
  );
}

function photoCard(lib, r) {
  const b = h('button', { type: 'button', class: 'photo', title: `${r.title} by ${r.creator} (${r.licenseLabel}). Click to add.`, onclick: () => add(lib, r, b) },
    h('img', { src: r.thumb, alt: r.title, loading: 'lazy' }),
    h('span', { class: 'photo-meta' }, r.creator, ' · ', r.licenseLabel),
  );
  return b;
}
