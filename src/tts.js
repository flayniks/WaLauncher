// Text to speech with Kokoro-82M (Apache-2.0) through kokoro-js, running in the browser.
// The model (about 90 MB) downloads once and is then cached by the browser.

const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export const VOICES = [
  ['af_heart', 'Heart · US female'],
  ['af_bella', 'Bella · US female'],
  ['af_nicole', 'Nicole · US female, soft'],
  ['af_sarah', 'Sarah · US female'],
  ['af_sky', 'Sky · US female'],
  ['af_nova', 'Nova · US female'],
  ['am_michael', 'Michael · US male'],
  ['am_fenrir', 'Fenrir · US male'],
  ['am_puck', 'Puck · US male'],
  ['am_adam', 'Adam · US male'],
  ['am_echo', 'Echo · US male'],
  ['bf_emma', 'Emma · UK female'],
  ['bf_isabella', 'Isabella · UK female'],
  ['bf_alice', 'Alice · UK female'],
  ['bm_george', 'George · UK male'],
  ['bm_fable', 'Fable · UK male'],
  ['bm_lewis', 'Lewis · UK male'],
  ['bm_daniel', 'Daniel · UK male'],
];

let ttsPromise = null;

function load(onProgress) {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const url = KOKORO_URL;
      const { KokoroTTS } = await import(/* @vite-ignore */ url);
      const files = new Map();
      return KokoroTTS.from_pretrained(MODEL, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (p) => {
          if (p.status !== 'progress' || !p.total) return;
          files.set(p.file, [p.loaded, p.total]);
          let a = 0, b = 0;
          for (const [l, t] of files.values()) {
            a += l;
            b += t;
          }
          onProgress && onProgress(b ? a / b : 0, 'Downloading voice model');
        },
      });
    })();
    ttsPromise.catch(() => (ttsPromise = null));
  }
  return ttsPromise;
}

function wav(samples, rate) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  out.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  w(36, 'data');
  out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

// Speaks `text` and returns a WAV blob.
export async function speak(text, { voice = 'af_heart', speed = 1 } = {}, onProgress) {
  text = (text || '').trim();
  if (!text) throw new Error('Type something to say first.');
  onProgress && onProgress(0, 'Loading voice model');
  let tts;
  try {
    tts = await load(onProgress);
  } catch (e) {
    throw new Error('The voice model could not be downloaded. Check your connection; sandboxed previews block it, the downloaded app works. (' + e.message + ')');
  }
  onProgress && onProgress(1, 'Speaking');
  let audio;
  try {
    audio = await tts.generate(text, { voice, speed });
  } catch (e) {
    // A failed voice download shows up as a parse error deep inside the library.
    if (/byte length|JSON|Unexpected token|fetch|429/i.test(e.message)) throw new Error('The voice could not be downloaded (the model server may be busy). Try again in a minute.');
    throw e;
  }
  return wav(audio.audio, audio.sampling_rate);
}
