import './styles.css';
import { App } from './ui/app.js';

const app = new App(document.getElementById('app'));
window.clipwave = app;
app.init().catch((e) => {
  console.error(e);
  document.getElementById('app').textContent = 'Clipwave could not start: ' + e.message;
});

// Handles for automated tests and the browser console.
import { EFFECTS, effectSource } from './engine/effects.js';
import { TRANSITIONS, transitionSource } from './engine/transitions.js';
import { exportProject, mixAudio } from './engine/exporter.js';
import * as ops from './ops.js';
window.clipwaveDev = { EFFECTS, effectSource, TRANSITIONS, transitionSource, exportProject, mixAudio, ops };
