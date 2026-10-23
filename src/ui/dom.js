// Tiny DOM helpers and form controls shared by the panels.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const P = {
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>',
  prev: '<path d="M18 5v14l-10-7zM6 5v14"/>',
  next: '<path d="M6 5v14l10-7zM18 5v14"/>',
  split: '<path d="M12 3v18"/><path d="M8 7 5 4M8 17l-3 3M16 7l3-3M16 17l3 3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  magnet: '<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/>',
  snap: '<path d="M12 3v18M5 8l7 4 7-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="m17 9 5 6M22 9l-5 6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  transition: '<path d="M4 5h7v14H4zM13 5h7v14h-7"/><path d="M11 12h2"/>',
  filter: '<circle cx="9" cy="9" r="6"/><circle cx="15" cy="15" r="6"/>',
  sticker: '<path d="M14 3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h8l7-7V6a3 3 0 0 0-3-3h-4"/><path d="M14 21v-4a3 3 0 0 1 3-3h4"/><path d="M8 10h.01M14 10h.01M8.5 14a4 4 0 0 0 5 0"/>',
  template: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  captions: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3"/>',
  export: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M8 11h6"/>',
  fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  diamond: '<path d="M12 3l9 9-9 9-9-9z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  freeze: '<path d="M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1 19.1 4.9"/>',
  detach: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><path d="M3 3l4 4"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  loop: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  shape: '<rect x="3" y="3" width="8" height="8" rx="1"/><circle cx="17" cy="17" r="4"/><path d="M17 3l4 7h-8z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  wand: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  layers: '<path d="m12 2 10 6-10 6L2 8z"/><path d="m2 14 10 6 10-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
};

export function icon(name, size = 18) {
  const span = document.createElement('span');
  span.className = 'ico';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  return span;
}

export function iconButton(name, title, onClick, extra = {}) {
  return h('button', { class: 'ibtn ' + (extra.class || ''), title, 'aria-label': title, onclick: onClick, type: 'button', id: extra.id }, icon(name, extra.size || 18), extra.label ? h('span', { class: 'ibtn-label' }, extra.label) : null);
}

let idCounter = 0;
const nextId = (p) => `${p}-${++idCounter}`;

// Slider with an editable readout. get() returns the value; set(v, final) is called while dragging and on release.
// `parse` turns typed text back into a value; by default "80%" reads as 0.8 when the readout shows percent.
export function slider({ label, min, max, step = 0.01, get, set, format, parse, kf, id }) {
  const inputId = id || nextId('sl');
  const input = h('input', { type: 'range', min, max, step, id: inputId });
  const num = h('input', { type: 'text', inputmode: 'decimal', class: 'num', 'aria-label': label, spellcheck: false });
  const fmt = format || ((v) => (Math.abs(step) >= 1 ? String(Math.round(v)) : (+v).toFixed(2)));
  const read = parse || ((text) => {
    const n = parseFloat(String(text).replace(',', '.'));
    if (!isFinite(n)) return null;
    return /%/.test(fmt(get())) ? n / 100 : n;
  });
  const refresh = () => {
    const v = get();
    if (document.activeElement !== input) input.value = v;
    if (document.activeElement !== num) num.value = fmt(v);
  };
  input.addEventListener('input', () => {
    set(+input.value, false);
    num.value = fmt(+input.value);
  });
  input.addEventListener('change', () => set(+input.value, true));
  const commitText = () => {
    const v = read(num.value);
    if (v !== null) set(Math.min(+max, Math.max(+min, v)), true);
    refresh();
  };
  num.addEventListener('change', commitText);
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') num.blur();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const v = Math.min(+max, Math.max(+min, get() + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
      set(v, true);
      refresh();
    }
  });
  input.addEventListener('dblclick', () => {
    const def = input.dataset.default;
    if (def !== undefined) {
      set(+def, true);
      refresh();
    }
  });
  refresh();
  const row = h('div', { class: 'row slider-row' }, h('label', { for: inputId }, label), kf || null, input, num);
  row.refresh = refresh;
  row.input = input;
  return row;
}

export function colorInput({ label, get, set, id }) {
  const inputId = id || nextId('col');
  const input = h('input', { type: 'color', id: inputId });
  const refresh = () => {
    const v = get();
    input.value = /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000';
  };
  input.addEventListener('input', () => set(input.value, false));
  input.addEventListener('change', () => set(input.value, true));
  refresh();
  const row = h('div', { class: 'row color-row' }, h('label', { for: inputId }, label), input);
  row.refresh = refresh;
  return row;
}

export function select({ label, options, get, set, id }) {
  const selId = id || nextId('sel');
  const sel = h('select', { id: selId }, options.map(([v, l]) => h('option', { value: v }, l)));
  const refresh = () => (sel.value = get());
  sel.addEventListener('change', () => set(sel.value, true));
  refresh();
  const row = h('div', { class: 'row select-row' }, label ? h('label', { for: selId }, label) : null, sel);
  row.refresh = refresh;
  return row;
}

export function toggle({ label, get, set, id }) {
  const tid = id || nextId('tg');
  const input = h('input', { type: 'checkbox', id: tid, class: 'switch' });
  const refresh = () => (input.checked = !!get());
  input.addEventListener('change', () => set(input.checked, true));
  refresh();
  const row = h('div', { class: 'row toggle-row' }, h('label', { for: tid }, label), input);
  row.refresh = refresh;
  return row;
}

export function segmented({ options, get, set, label }) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label || '' });
  const btns = options.map(([v, l, ic]) =>
    h('button', { type: 'button', class: 'seg-btn', title: typeof l === 'string' ? l : '', onclick: () => { set(v, true); refresh(); } }, ic ? icon(ic, 16) : null, ic ? null : l),
  );
  btns.forEach((b) => wrap.append(b));
  const refresh = () => btns.forEach((b, i) => b.classList.toggle('on', options[i][0] === get()));
  refresh();
  const row = h('div', { class: 'row seg-row' }, label ? h('label', null, label) : null, wrap);
  row.refresh = refresh;
  return row;
}

export function section(title, ...children) {
  return h('section', { class: 'insp-section' }, title ? h('h4', null, title) : null, ...children);
}

let toastTimer = 0;
export function toast(msg, kind = 'info', ms = 2600) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), ms);
}

export function modal(title, body, actions = []) {
  const close = () => wrap.remove();
  const wrap = h(
    'div',
    { class: 'modal-wrap', onclick: (e) => e.target === wrap && close() },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('header', null, h('h3', null, title), iconButton('close', 'Close', close)), h('div', { class: 'modal-body' }, body), actions.length ? h('footer', null, actions) : null),
  );
  document.body.append(wrap);
  wrap.close = close;
  return wrap;
}

// Right-click menu. items: [label, fn, {disabled, danger, key}] or '-' for a divider.
export function contextMenu(x, y, items) {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  const menu = h(
    'div',
    { class: 'ctx-menu', role: 'menu' },
    items.map((it) =>
      it === '-'
        ? h('hr')
        : h('button', { type: 'button', role: 'menuitem', class: it[2] && it[2].danger ? 'danger' : '', disabled: it[2] && it[2].disabled, onclick: () => { menu.remove(); it[1](); } }, h('span', null, it[0]), it[2] && it[2].key ? h('kbd', null, it[2].key) : null),
    ),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  const off = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      removeEventListener('pointerdown', off, true);
    }
  };
  setTimeout(() => addEventListener('pointerdown', off, true));
  return menu;
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
