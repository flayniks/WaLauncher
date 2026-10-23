// Export dialog: settings, progress with time left, and the finished file.

import { h, icon, modal, select, toast } from './dom.js';
import { exportProject, exportSize, RESOLUTIONS } from '../engine/exporter.js';
import { projectDuration, fmtTime, makeClip } from '../model.js';
import { projectCredits } from '../stock.js';
import { insertTrack } from '../ops.js';

const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');

export function openExport(app) {
  const p = app.store.project;
  const duration = projectDuration(p);
  if (!(duration > 0)) {
    toast('The timeline is empty. Add a clip first.', 'warn');
    return;
  }
  app.player.pause();
  const short = Math.min(p.width, p.height);
  const st = app.exportSettings || { resolution: short >= 1080 ? 1080 : 720, fps: p.fps || 30, quality: 'high', format: 'mp4' };
  app.exportSettings = st;
  const nameIn = h('input', { type: 'text', id: 'export-name', value: p.name || 'My video', 'aria-label': 'File name' });
  const info = h('p', { class: 'hint export-info' });
  const updateInfo = () => {
    const [w, hh] = exportSize(p, st.resolution);
    const mbps = (w * hh * st.fps * ({ low: 0.05, medium: 0.09, high: 0.14, max: 0.22 }[st.quality])) / 1e6;
    info.textContent = st.format === 'wav' ? `Audio only, ${fmtTime(duration)}, about ${fmtSize(duration * 48000 * 4)}.` : `${w} × ${hh}, ${st.fps} fps, ${fmtTime(duration)}. About ${fmtSize((mbps * 1e6 * duration) / 8 + duration * 24000)}.`;
  };
  const settings = h('div', { class: 'export-grid' },
    h('div', { class: 'row' }, h('label', { for: 'export-name' }, 'Name'), nameIn),
    select({ label: 'Resolution', options: RESOLUTIONS.map(([l, v]) => [String(v), l]), get: () => String(st.resolution), set: (v) => { st.resolution = +v; updateInfo(); } }),
    select({ label: 'Frame rate', options: ['24', '25', '30', '50', '60'].map((v) => [v, v + ' fps']), get: () => String(st.fps), set: (v) => { st.fps = +v; updateInfo(); } }),
    select({ label: 'Quality', options: [['low', 'Smaller file'], ['medium', 'Good'], ['high', 'High (recommended)'], ['max', 'Maximum']], get: () => st.quality, set: (v) => { st.quality = v; updateInfo(); } }),
    select({ label: 'Format', options: [['mp4', 'MP4 (H.264, plays everywhere)'], ['webm', 'WebM (VP9)'], ['wav', 'Audio only (WAV)']], get: () => st.format, set: (v) => { st.format = v; updateInfo(); } }),
    info,
  );
  updateInfo();
  const bar = h('div', { class: 'progress show' }, h('div', { class: 'progress-fill' }));
  const status = h('p', { class: 'export-status', role: 'status' });
  const progressView = h('div', { class: 'export-progress', hidden: true }, bar, status);
  const resultView = h('div', { class: 'export-result', hidden: true });
  // Creative Commons files on the timeline need a credit line wherever the video is posted.
  const credits = projectCredits(p, app.media);
  const creditBox = credits.length
    ? h('div', { class: 'credits-box' },
      h('h4', null, `Credits for ${credits.length} file${credits.length > 1 ? 's' : ''}`),
      h('p', { class: 'hint' }, 'Paste these into your video description, or add them as an end card.'),
      h('textarea', { rows: Math.min(5, credits.length + 1), readOnly: true, id: 'export-credits', 'aria-label': 'Credits', value: credits.join('\n') }),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small', onclick: () => {
          const text = credits.join('\n');
          navigator.clipboard.writeText(text).then(() => toast('Credits copied'), () => { const ta = document.getElementById('export-credits'); ta.select(); toast('Press Ctrl+C to copy'); });
        } }, 'Copy credits'),
        h('button', { type: 'button', class: 'btn small', onclick: () => {
          const end = projectDuration(app.store.project);
          app.store.commit('Credits card', (pp) => {
            const t = insertTrack(pp, 'text');
            const c = makeClip('text', { start: end, duration: Math.max(3, Math.min(8, credits.length * 1.2)) });
            Object.assign(c.text, { content: 'Credits\n' + credits.map((l) => l.replace(/ https?:\/\/\S+/g, '').replace(/\. To view a copy.*$/, '')).join('\n'), size: 30, weight: 600, font: 'Poppins', wrap: 0.9, lineHeight: 1.35 });
            t.clips.push(c);
          });
          toast('Added a credits card at the end');
          updateInfo();
        } }, 'Add as end card'),
      ))
    : null;
  if (creditBox) settings.append(creditBox);
  const body = h('div', null, settings, progressView, resultView);
  let ctrl = null;
  const startBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => run() }, icon('export', 16), 'Export');
  const cancelBtn = h('button', { type: 'button', class: 'btn', onclick: () => (ctrl ? ctrl.abort() : dlg.close()) }, 'Cancel');
  const dlg = modal('Export', body, [cancelBtn, startBtn]);

  async function run() {
    ctrl = new AbortController();
    settings.hidden = true;
    progressView.hidden = false;
    startBtn.disabled = true;
    const t0 = performance.now();
    try {
      const res = await exportProject(app.store.project, app.media, st, (frac, msg, eta) => {
        bar.firstChild.style.width = (frac * 100).toFixed(1) + '%';
        status.textContent = `${msg} ${Math.round(frac * 100)}%` + (eta ? ` · about ${Math.ceil(eta)}s left` : '');
      }, ctrl.signal);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      const name = (nameIn.value.trim() || 'My video') + '.' + res.ext;
      progressView.hidden = true;
      resultView.hidden = false;
      const url = URL.createObjectURL(res.blob);
      const media = st.format === 'wav' ? h('audio', { src: url, controls: true }) : h('video', { src: url, controls: true, playsInline: true, class: 'export-video' });
      resultView.append(
        media,
        h('p', null, h('strong', null, name), ` · ${fmtSize(res.blob.size)} · made in ${secs}s` + (res.codec ? ` · ${res.codec.toUpperCase()}${res.audioCodec ? ' + ' + res.audioCodec.toUpperCase() : ''}` : '')),
        h('button', { type: 'button', class: 'btn primary wide', onclick: () => app.saveFile(res.blob, name) }, icon('export', 16), 'Save file'),
      );
      startBtn.hidden = true;
      cancelBtn.textContent = 'Close';
      ctrl = null;
    } catch (e) {
      ctrl = null;
      progressView.hidden = true;
      settings.hidden = false;
      startBtn.disabled = false;
      if (e.name === 'AbortError') toast('Export canceled');
      else {
        console.error(e);
        toast(e.message || 'Export failed', 'error', 7000);
      }
    }
  }
}
