// Ready-made text styles and one-click project templates.

import { makeClip, makeTrack, newProject, DEFAULT_TEXT } from './model.js';
import { defaultParams, effectById } from './engine/effects.js';

const T = (over) => ({ ...structuredClone(DEFAULT_TEXT), ...over });
const noShadow = { enabled: false, color: 'rgba(0,0,0,0.5)', blur: 0, x: 0, y: 0 };

export const TEXT_TEMPLATES = [
  { name: 'Bold Title', text: T({ content: 'BIG NEWS', font: 'Anton', weight: 400, size: 180, letterSpacing: 4 }), anim: { in: { id: 'zoomPunch', duration: 0.4 } } },
  { name: 'Meme Caption', text: T({ content: 'WHEN THE CODE WORKS', font: 'Anton', weight: 400, size: 120, stroke: { width: 7, color: '#000000' }, shadow: noShadow }), transform: { y: -0.36 } },
  { name: 'Subtitle', text: T({ content: 'This is what I said', font: 'Poppins', weight: 600, size: 64, bg: { enabled: true, color: '#000000', opacity: 0.6, padding: 0.3, radius: 0.2, mode: 'line' }, shadow: noShadow }), transform: { y: 0.38 } },
  { name: 'Karaoke', text: T({ content: 'Sing every single word', font: 'Montserrat', weight: 900, size: 84, stroke: { width: 4, color: '#000000' }, highlight: '#ffd84d', anim: { loop: { id: 'karaoke', duration: 3 } } }), transform: { y: 0.32 } },
  { name: 'Word Pop', text: T({ content: 'Every word pops in', font: 'Poppins', weight: 800, size: 92, stroke: { width: 3, color: '#111111' }, anim: { in: { id: 'wordPop', duration: 1.2 }, loop: { id: 'highlightWord', duration: 3 } } }), transform: { y: 0.3 } },
  { name: 'Neon Sign', text: T({ content: 'OPEN LATE', font: 'Monoton', weight: 400, size: 130, color: '#ffe9ff', glow: { size: 34, color: '#ff3cac' }, shadow: noShadow, anim: { loop: { id: 'flicker', duration: 1.2 } } }) },
  { name: 'Typewriter', text: T({ content: 'Once upon a time…', font: 'Space Mono', weight: 400, size: 76, shadow: noShadow, anim: { in: { id: 'typewriter', duration: 1.6 } } }) },
  { name: 'Cinematic', text: T({ content: 'T H E   E N D', font: 'Cinzel', weight: 400, size: 96, letterSpacing: 10, shadow: { enabled: true, color: 'rgba(0,0,0,0.7)', blur: 20, x: 0, y: 0 }, anim: { in: { id: 'blurLetters', duration: 2 } } }) },
  { name: 'Lower Third', text: T({ content: 'Alex Rivera\nDirector', font: 'Barlow Condensed', weight: 700, size: 70, align: 'left', bg: { enabled: true, color: '#f2b33d', opacity: 1, padding: 0.4, radius: 0.08, mode: 'line' }, color: '#141414', shadow: noShadow }), transform: { x: -0.27, y: 0.3 }, anim: { in: { id: 'slideInLeft', duration: 0.5 }, out: { id: 'slideOutLeft', duration: 0.4 } } },
  { name: 'Subscribe', text: T({ content: '▶ SUBSCRIBE', font: 'Russo One', weight: 400, size: 70, bg: { enabled: true, color: '#e62117', opacity: 1, padding: 0.45, radius: 0.35, mode: 'box' }, shadow: { enabled: true, color: 'rgba(0,0,0,0.5)', blur: 18, x: 0, y: 8 } }), transform: { y: 0.3 }, anim: { in: { id: 'bounceIn', duration: 0.6 }, loop: { id: 'pulse', duration: 1 } } },
  { name: 'Gradient Pop', text: T({ content: 'SUMMER', font: 'Archivo Black', weight: 400, size: 190, gradient: { enabled: true, from: '#ff6ec4', to: '#ffd84d', angle: 0 }, stroke: { width: 5, color: '#1b1033' } }), anim: { in: { id: 'popIn', duration: 0.45 }, loop: { id: 'float', duration: 2.4 } } },
  { name: 'Wavy', text: T({ content: 'good vibes only', font: 'Pacifico', weight: 400, size: 110, color: '#fff3c4', anim: { loop: { id: 'wave', duration: 1.4 } } }) },
  { name: 'Retro Game', text: T({ content: 'LEVEL UP!', font: 'Press Start 2P', weight: 400, size: 72, color: '#7CFC00', stroke: { width: 4, color: '#000000' }, shadow: { enabled: true, color: '#000000', blur: 0, x: 6, y: 6 }, anim: { in: { id: 'dropLetters', duration: 1 } } }) },
  { name: 'Handwritten', text: T({ content: 'with love', font: 'Dancing Script', weight: 700, size: 130, color: '#ffffff', anim: { in: { id: 'fadeLetters', duration: 1.6 } } }) },
  { name: 'Glitch Title', text: T({ content: 'SYSTEM ERROR', font: 'Orbitron', weight: 900, size: 110, color: '#e6fbff', anim: { in: { id: 'glitchLetters', duration: 0.8 }, loop: { id: 'jitter', duration: 1 } } }), effects: [{ uid: 'g1', id: 'rgbsplit', params: defaultParams(effectById.get('rgbsplit')), enabled: true }] },
  { name: 'Rainbow', text: T({ content: 'PARTY TIME', font: 'Bangers', weight: 400, size: 150, letterSpacing: 3, stroke: { width: 5, color: '#1a1a1a' }, anim: { loop: { id: 'rainbow', duration: 2 } } }) },
  { name: 'Quote', text: T({ content: '“Make it simple,\nbut significant.”', font: 'Playfair Display', weight: 400, italic: true, size: 84, lineHeight: 1.3, anim: { in: { id: 'riseLetters', duration: 1.4 } } }) },
  { name: 'Countdown', text: T({ content: '3', font: 'Anton', weight: 400, size: 420, color: '#ffffff', stroke: { width: 10, color: '#000000' } }), duration: 1, anim: { in: { id: 'zoomIn', duration: 0.3 }, out: { id: 'zoomOut', duration: 0.3 } } },
  { name: 'Breaking', text: T({ content: 'BREAKING NEWS', font: 'Oswald', weight: 700, size: 72, color: '#ffffff', bg: { enabled: true, color: '#c8102e', opacity: 1, padding: 0.35, radius: 0, mode: 'box' }, shadow: noShadow }), transform: { y: 0.36 }, anim: { in: { id: 'slideInRight', duration: 0.4 } } },
  { name: 'Comic Shout', text: T({ content: 'POW!', font: 'Bangers', weight: 400, size: 220, color: '#ffd84d', stroke: { width: 9, color: '#e01b24' }, shadow: { enabled: true, color: '#000000', blur: 0, x: 10, y: 10 } }), transform: { rotation: -8 }, anim: { in: { id: 'jackInTheBox', duration: 0.6 }, loop: { id: 'tada', duration: 1.2 } } },
];

export const EMOJI = {
  Faces: '😀 😂 🤣 😍 🥰 😎 🤩 🥳 😭 😱 🤯 😡 🤔 🙄 😴 🤤 🥶 🥵 🤡 👻 💀 👽 🤖 😈'.split(' '),
  Hands: '👍 👎 👏 🙌 🙏 💪 👀 👋 🤙 ✌️ 🤞 👉 👈 ☝️ 👇 🫶 🤝 ✍️ 🫡 🤌'.split(' '),
  Symbols: '🔥 ✨ 💯 ❤️ 💔 💥 ⚡ ⭐ 🌟 💫 ✅ ❌ ❗ ❓ ⚠️ 🎯 🚀 💎 👑 🏆 🎉 🎊 💡 📌'.split(' '),
  Things: '🎵 🎶 🎬 🎥 📷 📱 💻 🎮 🎧 🍕 🍔 🍿 ☕ 🍩 🌈 ☀️ 🌙 ⛈️ ❄️ 🌊 🌸 🍀 🐶 🐱 🦄'.split(' '),
  Arrows: '⬆️ ⬇️ ⬅️ ➡️ ↗️ ↘️ ↙️ ↖️ 🔄 🔁 ⤴️ ⤵️ 🔝 🔜'.split(' '),
};

// Project templates: pick some clips and get a finished edit with cuts, transitions, effects and titles.
export const PROJECT_TEMPLATES = [
  { id: 'montage', name: 'Fast Montage', desc: 'Quick 1.2s cuts with zoom transitions and a beat zoom.', aspect: '9:16', slot: 1.2, transition: 'CrossZoom', trDur: 0.35, effect: 'beatzoom', filter: 'vivid', title: { template: 'Bold Title', content: 'WEEKEND' }, clipAnim: null },
  { id: 'cinematic', name: 'Cinematic', desc: 'Slow 3s shots, film look, black bars and a title.', aspect: '16:9', slot: 3, transition: 'fadecolor', trDur: 0.8, effect: 'letterbox', filter: 'teal-orange', title: { template: 'Cinematic', content: 'A  S T O R Y' }, clipAnim: 'kenBurnsIn', grain: true },
  { id: 'vlog', name: 'Daily Vlog', desc: 'Clean cuts, soft fades and a lower third.', aspect: '16:9', slot: 2.5, transition: 'fade', trDur: 0.4, effect: null, filter: 'clean', title: { template: 'Lower Third', content: 'Day 01\nMy morning' }, clipAnim: null },
  { id: 'retro', name: 'Retro Tape', desc: 'VHS look, 70s colors and typewriter titles.', aspect: '4:3', slot: 2, transition: 'GlitchMemories', trDur: 0.5, effect: 'vhs', filter: 'kodak70', title: { template: 'Typewriter', content: 'SUMMER 1987' }, clipAnim: null },
  { id: 'hype', name: 'Hype Reel', desc: 'Glitch cuts, RGB split and a punchy title.', aspect: '9:16', slot: 0.9, transition: 'GlitchDisplace', trDur: 0.25, effect: 'rgbsplit', filter: 'cyberpunk', title: { template: 'Glitch Title', content: 'GAME ON' }, clipAnim: 'zoomPunch' },
  { id: 'memories', name: 'Memories', desc: 'Dreamy dissolves, soft glow and handwriting.', aspect: '1:1', slot: 2.8, transition: 'Dreamy', trDur: 1, effect: 'glow', filter: 'pastel', title: { template: 'Handwritten', content: 'remember this' }, clipAnim: 'kenBurnsOut' },
];

// Builds a new project from a template and a list of media items (video or image).
export function buildFromTemplate(tpl, mediaList) {
  const p = newProject(tpl.name, tpl.aspect);
  p.background = { type: 'blur', color: '#000000', blur: 0.7 };
  const main = p.tracks[0];
  let t = 0;
  for (const m of mediaList) {
    const isVideo = m.type === 'video';
    const dur = isVideo ? Math.min(tpl.slot, m.duration) : tpl.slot;
    const c = makeClip(isVideo ? 'video' : 'image', { mediaId: m.id, start: t, duration: dur, name: m.name });
    if (isVideo && m.duration > dur + 0.5) c.in = Math.max(0, m.duration / 2 - dur / 2);
    if (t > 0 && tpl.transition) c.transitionIn = { id: tpl.transition, duration: tpl.trDur };
    if (tpl.filter) c.filter = { id: tpl.filter, intensity: 0.75 };
    if (tpl.clipAnim) c.anim = { loop: { id: tpl.clipAnim, duration: dur } };
    // Fill the frame for vertical formats.
    if (m.width && m.height) {
      const contain = Math.min(p.width / m.width, p.height / m.height);
      const cover = Math.max(p.width / m.width, p.height / m.height);
      c.transform.scale = cover / contain;
    }
    main.clips.push(c);
    t += dur;
  }
  const total = t;
  if (tpl.effect) {
    const fx = makeTrack('effect');
    fx.clips.push(makeClip('effect', { start: 0, duration: total, effect: { id: tpl.effect, params: defaultParams(effectById.get(tpl.effect)) } }));
    p.tracks.unshift(fx);
  }
  if (tpl.grain) {
    const fx2 = makeTrack('effect');
    fx2.clips.push(makeClip('effect', { start: 0, duration: total, effect: { id: 'grain', params: defaultParams(effectById.get('grain')) } }));
    p.tracks.unshift(fx2);
  }
  if (tpl.title) {
    const preset = TEXT_TEMPLATES.find((x) => x.name === tpl.title.template);
    const tt = makeTrack('text');
    const c = makeClip('text', { start: 0.2, duration: Math.min(3, Math.max(1.5, total - 0.4)) });
    if (preset) {
      Object.assign(c.text, structuredClone(preset.text));
      if (preset.anim) c.anim = structuredClone(preset.anim);
      if (preset.transform) Object.assign(c.transform, preset.transform);
      if (preset.effects) c.effects = structuredClone(preset.effects);
    }
    c.text.content = tpl.title.content;
    tt.clips.push(c);
    p.tracks.unshift(tt);
  }
  return p;
}

// The project people see the first time they open the editor: titles, shapes and effects, no media needed.
export function demoProject() {
  const p = newProject('Welcome to Clipwave', '16:9');
  p.background = { type: 'gradient', color: '#1d2b53', color2: '#7e2553', angle: 135 };
  const text = makeTrack('text');
  const t1 = makeClip('text', { start: 0, duration: 4.5 });
  Object.assign(t1.text, structuredClone(TEXT_TEMPLATES.find((x) => x.name === 'Gradient Pop').text), { content: 'CLIPWAVE' });
  t1.anim = { in: { id: 'popIn', duration: 0.5 }, out: { id: 'blurOut', duration: 0.5 } };
  t1.transform.y = -0.06;
  const t2 = makeClip('text', { start: 0.6, duration: 3.9 });
  Object.assign(t2.text, { content: 'Drop your clips in the Media panel to start', font: 'Poppins', weight: 600, size: 52, anim: { in: { id: 'riseLetters', duration: 1.2 } } });
  t2.transform.y = 0.16;
  text.clips.push(t1);
  const text2 = makeTrack('text');
  text2.clips.push(t2);
  const t3 = makeClip('text', { start: 4.5, duration: 3.5 });
  Object.assign(t3.text, structuredClone(TEXT_TEMPLATES.find((x) => x.name === 'Karaoke').text), { content: 'Effects, transitions, keyframes, captions' });
  t3.transform.y = 0;
  text.clips.push(t3);
  const stickers = makeTrack('text');
  const s1 = makeClip('sticker', { start: 1.2, duration: 3.3 });
  s1.text.content = '✨';
  s1.transform = { x: 0.33, y: -0.28, scale: 1, rotation: 0, opacity: 1 };
  s1.anim = { in: { id: 'zoomIn', duration: 0.5 }, loop: { id: 'spin', duration: 4 } };
  const s2 = makeClip('shape', { start: 4.5, duration: 3.5 });
  s2.shape = { kind: 'roundrect', fill: '#000000', fillOpacity: 0.35, stroke: '#ffd84d', strokeWidth: 3, w: 1300, h: 220 };
  s2.anim = { in: { id: 'zoomIn', duration: 0.4 } };
  stickers.clips.push(s1);
  const panel = makeTrack('text');
  panel.clips.push(s2);
  const fx = makeTrack('effect');
  fx.clips.push(makeClip('effect', { start: 0, duration: 8, effect: { id: 'bokeh', params: defaultParams(effectById.get('bokeh')) } }));
  p.tracks = [text, text2, stickers, panel, fx, p.tracks[0]];
  return p;
}
