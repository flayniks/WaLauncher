// Library panel: the AI editor chat, quick one-click edits and the API key setting.

import { h, icon, iconButton, modal, toast } from './dom.js';
import { getKey, setKey, runClaude, runLocal, apiErrorMessage, LOCAL_HELP } from '../assistant.js';
import { openExternal } from '../net.js';

const QUICK = [
  ['Remove silences', 'remove the silences'],
  ['Cut to the beat', 'cut to the beat'],
  ['Highlight reel', 'make a 30 second highlight reel'],
  ['Add captions', 'add captions'],
  ['Make it vertical', 'make it vertical 9:16'],
  ['Add music', 'add upbeat music'],
  ['Transitions', 'add zoom transitions'],
  ['Cinematic look', 'give it a cinematic look'],
];

const EXAMPLES = [
  'Turn this into a 30 second TikTok with captions, music and quick cuts',
  'Add a title that says “Summer 2026” with a pop animation for the first 3 seconds',
  'Cut out the boring parts and add a vintage film look',
];

function state(lib) {
  return (lib.ai = lib.ai || { log: [], history: [], running: false, ctrl: null, draft: '' });
}

export function renderAssistant(lib) {
  const st = state(lib);
  const hasKey = !!getKey();
  const panel = lib.panel;
  const logEl = h('div', { class: 'ai-log', role: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { id: 'ai-input', rows: 3, placeholder: hasKey ? 'Tell me the edit you want…' : 'Try: remove the silences', 'aria-label': 'Ask the AI editor', value: st.draft });
  input.addEventListener('input', () => (st.draft = input.value));
  const send = h('button', { type: 'button', class: 'btn primary', onclick: () => submit(lib, input.value) }, icon(st.running ? 'close' : 'send', 15), st.running ? 'Stop' : 'Send');
  if (st.running) send.onclick = () => st.ctrl && st.ctrl.abort();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!st.running) submit(lib, input.value);
    }
  });

  panel.append(
    h('div', { class: 'lib-head' }, h('h3', null, 'AI Editor'),
      h('span', { class: 'ai-mode ' + (hasKey ? 'on' : '') , title: hasKey ? 'Claude is editing with your API key' : 'Offline commands. Add an API key for full AI editing.' }, hasKey ? 'Claude' : 'Offline'),
      iconButton('key', 'AI settings', () => keyDialog(lib), { size: 16 })),
    h('div', { class: 'chip-grid quick' }, QUICK.map(([label, cmd]) => h('button', { type: 'button', class: 'chip-btn', disabled: st.running, onclick: () => submit(lib, cmd, { local: true }) }, icon('wand', 13), label))),
    logEl,
    h('div', { class: 'ai-compose' }, input, h('div', { class: 'ai-compose-row' }, h('span', { class: 'hint' }, 'Enter to send · Ctrl+Z undoes the whole edit'), send)),
  );

  if (!st.log.length) {
    logEl.append(h('div', { class: 'ai-msg assistant' },
      h('p', null, hasKey ? 'Tell me what you want and I’ll edit it: cuts, music, captions, text, effects, color, the lot.' : 'I can make edits for you. The buttons above work right away.'),
      hasKey ? h('ul', { class: 'ai-examples' }, EXAMPLES.map((ex) => h('li', null, h('button', { type: 'button', class: 'linklike', onclick: () => submit(lib, ex) }, ex)))) : h('p', { class: 'hint' }, LOCAL_HELP),
      hasKey ? null : h('button', { type: 'button', class: 'btn small', onclick: () => keyDialog(lib) }, icon('key', 14), 'Add a Claude API key'),
    ));
  }
  for (const item of st.log) logEl.append(renderItem(item));
  requestAnimationFrame(() => (logEl.scrollTop = logEl.scrollHeight));
  if (!st.running) setTimeout(() => input.focus({ preventScroll: true }), 20);
}

function renderItem(item) {
  if (item.role === 'tool') {
    const el = h('div', { class: 'ai-tool ' + item.status }, h('span', { class: 'dot' }), h('span', { class: 'label' }, item.text), item.detail ? h('span', { class: 'detail' }, item.detail) : null);
    item.el = el;
    return el;
  }
  return h('div', { class: 'ai-msg ' + item.role }, item.text.split('\n').map((line) => h('p', null, line)));
}

async function submit(lib, text, { local = false } = {}) {
  const st = state(lib);
  text = (text || '').trim();
  if (!text || st.running) return;
  const app = lib.app;
  st.draft = '';
  st.log.push({ role: 'user', text });
  st.running = true;
  st.ctrl = new AbortController();
  lib.render();
  const mark = app.store.undoStack.length;
  // Tool steps show up live in the chat.
  const log = (label) => {
    const item = { role: 'tool', text: label, status: 'run' };
    st.log.push(item);
    if (lib.tab === 'ai') lib.render();
    return {
      progress: (p, msg) => {
        item.detail = (msg ? msg + ' ' : '') + (p > 0 && p < 1 ? Math.round(p * 100) + '%' : '');
        if (item.el) {
          const d = item.el.querySelector('.detail') || item.el.appendChild(h('span', { class: 'detail' }));
          d.textContent = item.detail;
        }
      },
      done: () => {
        item.status = 'done';
        item.detail = '';
        if (item.el) item.el.className = 'ai-tool done';
      },
      fail: (msg) => {
        item.status = 'fail';
        item.detail = msg;
        if (lib.tab === 'ai') lib.render();
      },
    };
  };
  try {
    if (getKey() && !local) {
      st.history = await runClaude(app, st.history, text, {
        log,
        signal: st.ctrl.signal,
        onText: (t) => {
          st.log.push({ role: 'assistant', text: t });
          if (lib.tab === 'ai') lib.render();
        },
      });
    } else {
      const res = await runLocal(app, text, { log });
      st.log.push({ role: 'assistant', text: res ? res.reply : (getKey() ? 'Use the box below to ask Claude for that.' : LOCAL_HELP) });
    }
  } catch (e) {
    st.log.push({ role: 'assistant', text: apiErrorMessage(e), error: true });
  } finally {
    st.running = false;
    st.ctrl = null;
    // One request, one undo step.
    app.store.collapseUndo(mark, 'AI edit');
    lib.render();
  }
}

function keyDialog(lib) {
  const input = h('input', { type: 'password', id: 'ai-key', value: getKey(), placeholder: 'sk-ant-…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Anthropic API key' });
  const dlg = modal('AI settings', h('div', { class: 'key-dialog' },
    h('p', null, 'The AI editor uses Claude. Paste an Anthropic API key to let it make any edit you describe. Without one, the quick buttons and simple commands still work offline.'),
    h('label', { for: 'ai-key' }, 'Anthropic API key'),
    input,
    h('p', { class: 'hint' }, 'Get a key at ', h('a', { href: 'https://console.anthropic.com/settings/keys', onclick: (e) => { e.preventDefault(); openExternal('https://console.anthropic.com/settings/keys'); } }, 'console.anthropic.com'), '. It stays on this computer and is sent only to Anthropic. Usage is billed to your Anthropic account.'),
  ), [
    getKey() ? h('button', { type: 'button', class: 'btn', onclick: () => { setKey(''); dlg.close(); toast('API key removed'); lib.render(); } }, 'Remove key') : null,
    h('button', { type: 'button', class: 'btn primary', onclick: () => {
      const k = input.value.trim();
      if (k && !/^sk-ant-/.test(k)) {
        toast('That does not look like an Anthropic API key (they start with sk-ant-).', 'warn', 5000);
        return;
      }
      setKey(k);
      dlg.close();
      lib.ai = null;
      toast(k ? 'Claude is ready' : 'Saved');
      lib.render();
    } }, 'Save'),
  ].filter(Boolean));
  setTimeout(() => input.focus(), 20);
}
