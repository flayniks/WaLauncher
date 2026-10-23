// On-device vision models from MediaPipe (Apache-2.0): person segmentation for background removal and
// face detection for auto reframe. The library and models download the first time they're used.

const VISION_VERSION = '1.0.1';
const visionUrl = (path) => `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/${path}`;
export const MODELS = {
  selfie: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
  face: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite',
};

let visionPromise = null;
function vision() {
  if (!visionPromise) {
    visionPromise = (async () => {
      const url = visionUrl('vision_bundle.mjs');
      const mod = await import(/* @vite-ignore */ url);
      const fileset = await mod.FilesetResolver.forVisionTasks(visionUrl('wasm'));
      return { mod, fileset };
    })();
    visionPromise.catch(() => (visionPromise = null));
  }
  return visionPromise;
}

// Tries the GPU first and falls back to the CPU, which works everywhere.
async function create(factory, options) {
  try {
    return await factory({ ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } });
  } catch {
    return factory({ ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
  }
}

const friendly = (e) => new Error('The AI model could not be downloaded. Check your connection; sandboxed previews block it, the downloaded app works. (' + (e && e.message) + ')');

// ---------- person segmentation ----------

let segmenter = null;
let segmenterPromise = null;

export const matteReady = () => !!segmenter;

export function loadMatte() {
  if (segmenter) return Promise.resolve(segmenter);
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { mod, fileset } = await vision();
      segmenter = await create((o) => mod.ImageSegmenter.createFromOptions(fileset, o), {
        baseOptions: { modelAssetPath: MODELS.selfie },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      window.dispatchEvent(new Event('clipwave:ai'));
      return segmenter;
    })().catch((e) => {
      segmenterPromise = null;
      throw friendly(e);
    });
  }
  return segmenterPromise;
}

const work = document.createElement('canvas');
const workCtx = work.getContext('2d', { willReadFrequently: false });
const stillCache = new WeakMap();

// Person mask for a picture: {data: Uint8Array RGBA (mask in every channel), w, h}, or null while the model loads.
// Still images are cached; video frames are computed each time.
export function computeMatte(image, w, h, still) {
  if (!segmenter || !image || !w || !h) return null;
  if (still && stillCache.has(image)) return stillCache.get(image);
  const k = 256 / Math.max(w, h);
  work.width = Math.max(16, Math.round(w * k));
  work.height = Math.max(16, Math.round(h * k));
  try {
    workCtx.drawImage(image, 0, 0, work.width, work.height);
    const res = segmenter.segment(work);
    const mask = res.confidenceMasks && res.confidenceMasks[0];
    if (!mask) return null;
    const f = mask.getAsFloat32Array();
    const out = new Uint8Array(mask.width * mask.height * 4);
    for (let i = 0; i < f.length; i++) {
      const v = Math.max(0, Math.min(255, Math.round(f[i] * 255)));
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = out[i * 4 + 3] = v;
    }
    const result = { data: out, w: mask.width, h: mask.height };
    for (const m of res.confidenceMasks) m.close();
    if (res.close) res.close();
    if (still) stillCache.set(image, result);
    return result;
  } catch (e) {
    console.warn('Segmentation failed', e);
    return null;
  }
}

// ---------- face detection ----------

let detectorPromise = null;

export function loadFaces() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const { mod, fileset } = await vision();
      return create((o) => mod.FaceDetector.createFromOptions(fileset, o), {
        baseOptions: { modelAssetPath: MODELS.face },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.45,
      });
    })().catch((e) => {
      detectorPromise = null;
      throw friendly(e);
    });
  }
  return detectorPromise;
}

// Center of the biggest face in a picture, as fractions of its width and height, or null.
export function faceCenter(detector, canvas) {
  const res = detector.detect(canvas);
  let best = null;
  for (const d of res.detections || []) {
    const b = d.boundingBox;
    if (!b) continue;
    const area = b.width * b.height;
    if (!best || area > best.area) best = { area, x: (b.originX + b.width / 2) / canvas.width, y: (b.originY + b.height / 2) / canvas.height };
  }
  return best;
}

export const MATTE_SHADER = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform sampler2D uBlurred;
uniform vec4 uCrop;   // mask uv window for the cropped picture: x0, y0, width, height (bottom-up)
uniform float uLo, uHi;
uniform int uMode;    // 0 remove background, 1 blur background
void main() {
  vec4 c = texture2D(uTex, vUv);
  float m = smoothstep(uLo, uHi, texture2D(uMask, uCrop.xy + vUv * uCrop.zw).a);
  if (uMode == 1) {
    vec4 b = texture2D(uBlurred, vUv);
    gl_FragColor = vec4(mix(b.rgb, c.rgb, m), c.a);
  } else {
    gl_FragColor = vec4(c.rgb, c.a * m);
  }
}`;
