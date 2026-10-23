// Core GLSL programs used by the compositor. Effects live in effects.js, transitions in transitions.js.

export const HEADER = `
precision highp float;
varying vec2 vUv;
`;

// Small helpers shared by effects. hsv conversions are the well-known public-domain versions by Sam Hocevar.
export const COMMON = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float rand(vec2 co) { return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.02; a *= 0.5; }
  return v;
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
`;

export const COPY = HEADER + `
uniform sampler2D uTex;
uniform vec4 uRect; // uv scale (xy) and offset (zw)
uniform float uDim;
void main() {
  vec2 uv = vUv * uRect.xy + uRect.zw;
  vec4 c = texture2D(uTex, uv);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) c = vec4(0.0);
  gl_FragColor = vec4(c.rgb * (1.0 - uDim), c.a);
}`;

export const FILL = HEADER + `
uniform vec4 uColor;
uniform vec4 uColor2;
uniform float uAngle;
uniform int uMode; // 0 solid, 1 linear gradient
void main() {
  if (uMode == 0) { gl_FragColor = uColor; return; }
  vec2 d = vec2(cos(uAngle), sin(uAngle));
  float t = clamp(dot(vUv - 0.5, d) + 0.5, 0.0, 1.0);
  gl_FragColor = mix(uColor, uColor2, t);
}`;

// Places a layer on the frame: affine transform, crop, opacity, mask and blend mode in one pass.
export const COMPOSITE = HEADER + COMMON + `
uniform sampler2D uDst;
uniform sampler2D uSrc;
uniform mat3 uInv;      // canvas pixels (y down) -> layer unit square [-0.5, 0.5]
uniform vec2 uCanvas;
uniform vec2 uFw;       // one canvas pixel measured in unit-square units
uniform vec2 uElem;     // layer size in canvas pixels before scaling (for round masks)
uniform vec4 uCrop;     // x0, y0, x1, y1 of the source in top-left uv
uniform float uOpacity;
uniform int uBlend;
uniform int uMaskType;
uniform vec4 uMask;     // center x, y (unit), width, height (fraction of layer)
uniform float uMaskRot;
uniform float uMaskFeather;
uniform float uMaskRound;
uniform int uMaskInvert;

vec3 blendOverlay(vec3 b, vec3 s) { return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b)); }
vec3 blendSoft(vec3 b, vec3 s) {
  vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
  return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (d - b), step(0.5, s));
}
vec3 blendMode(vec3 b, vec3 s, int m) {
  if (m == 1) return b * s;
  if (m == 2) return 1.0 - (1.0 - b) * (1.0 - s);
  if (m == 3) return blendOverlay(b, s);
  if (m == 4) return min(b, s);
  if (m == 5) return max(b, s);
  if (m == 6) return min(vec3(1.0), b / max(1.0 - s, 1e-4));
  if (m == 7) return 1.0 - min(vec3(1.0), (1.0 - b) / max(s, 1e-4));
  if (m == 8) return blendOverlay(s, b);
  if (m == 9) return blendSoft(b, s);
  if (m == 10) return abs(b - s);
  if (m == 11) return b + s - 2.0 * b * s;
  if (m == 12) return min(vec3(1.0), b + s);
  if (m == 13) { vec3 hb = rgb2hsv(b); vec3 hs = rgb2hsv(s); return hsv2rgb(vec3(hs.x, hs.y, hb.z)); }
  if (m == 14) { vec3 hb = rgb2hsv(b); vec3 hs = rgb2hsv(s); return hsv2rgb(vec3(hb.x, hb.y, hs.z)); }
  return s;
}

float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float maskAlpha(vec2 u) {
  if (uMaskType == 0) return 1.0;
  vec2 p = (u - uMask.xy) * uElem;
  float a = radians(uMaskRot);
  p = vec2(cos(a) * p.x + sin(a) * p.y, -sin(a) * p.x + cos(a) * p.y);
  vec2 size = uMask.zw * uElem;
  float f = max(uMaskFeather * min(uElem.x, uElem.y), 1.0);
  float v = 1.0;
  if (uMaskType == 1) { // ellipse
    vec2 r = max(size * 0.5, vec2(1.0));
    float d = (length(p / r) - 1.0) * min(r.x, r.y);
    v = 1.0 - smoothstep(-f, f, d);
  } else if (uMaskType == 2) { // rectangle
    float r = uMaskRound * min(size.x, size.y) * 0.5;
    v = 1.0 - smoothstep(-f, f, sdBox(p, size * 0.5, r));
  } else if (uMaskType == 3) { // linear: keep the side above the line
    v = 1.0 - smoothstep(-f, f, p.y);
  } else if (uMaskType == 4) { // mirror: a band
    v = 1.0 - smoothstep(-f, f, abs(p.y) - size.y * 0.5);
  } else if (uMaskType == 5) { // heart
    vec2 q = p / max(min(size.x, size.y) * 0.5, 1.0);
    q.y = -q.y + 0.25;
    float d = pow(q.x * q.x + q.y * q.y - 0.5, 3.0) - q.x * q.x * q.y * q.y * q.y;
    v = 1.0 - smoothstep(-0.02 - f * 0.002, 0.02 + f * 0.002, d);
  } else if (uMaskType == 6) { // star
    vec2 q = p / max(min(size.x, size.y) * 0.5, 1.0);
    float an = atan(q.x, -q.y);
    float r = length(q);
    float k = 0.5 + 0.5 * cos(5.0 * an);
    float edge = mix(0.45, 1.0, pow(k, 3.0));
    v = 1.0 - smoothstep(edge - f * 0.004, edge + f * 0.004, r);
  }
  return uMaskInvert == 1 ? 1.0 - v : v;
}

void main() {
  vec4 dst = texture2D(uDst, vUv);
  vec2 px = vec2(vUv.x * uCanvas.x, (1.0 - vUv.y) * uCanvas.y);
  vec2 u = (uInv * vec3(px, 1.0)).xy;
  vec2 edge = (0.5 - abs(u)) / max(uFw, vec2(1e-6));
  float inside = clamp(min(edge.x, edge.y) + 0.5, 0.0, 1.0);
  if (inside <= 0.0) { gl_FragColor = dst; return; }
  vec2 iuv = mix(uCrop.xy, uCrop.zw, u + 0.5);
  vec4 src = texture2D(uSrc, vec2(iuv.x, 1.0 - iuv.y));
  float a = clamp(src.a * uOpacity * inside * maskAlpha(u), 0.0, 1.0);
  vec3 b = blendMode(dst.rgb, src.rgb, uBlend);
  gl_FragColor = vec4(mix(dst.rgb, b, a), a + dst.a * (1.0 - a));
}`;

// Basic adjustments plus the filter grade, in one pass.
export const COLOR = HEADER + COMMON + `
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uExposure, uBrightness, uContrast, uSaturation, uVibrance, uTemperature, uTint;
uniform float uHighlights, uShadows, uHue, uFade, uVignette, uGrain, uSharpen, uTime;
uniform vec3 uLift, uGamma, uGain, uShadowTint, uHighTint, uTone;
uniform float uGradeSat, uGradeContrast, uGradeFade, uMono;

void main() {
  vec4 src = texture2D(uTex, vUv);
  vec3 c = src.rgb;
  if (uSharpen > 0.0) {
    vec2 px = 1.0 / uRes;
    vec3 n = texture2D(uTex, vUv + vec2(px.x, 0.0)).rgb + texture2D(uTex, vUv - vec2(px.x, 0.0)).rgb
           + texture2D(uTex, vUv + vec2(0.0, px.y)).rgb + texture2D(uTex, vUv - vec2(0.0, px.y)).rgb;
    c += (c - n * 0.25) * uSharpen * 2.5;
  }
  c *= pow(2.0, uExposure);
  c += uBrightness * 0.35;
  float k = uContrast > 0.0 ? 1.0 / (1.0 - uContrast * 0.7) : 1.0 + uContrast;
  c = (c - 0.5) * k + 0.5;
  c *= vec3(1.0 + uTemperature * 0.18, 1.0 - uTint * 0.12, 1.0 - uTemperature * 0.18);
  c.rb *= 1.0 + uTint * 0.06;
  float l = luma(clamp(c, 0.0, 1.0));
  c += uShadows * 0.3 * (1.0 - smoothstep(0.0, 0.55, l));
  c += uHighlights * 0.3 * smoothstep(0.45, 1.0, l);
  if (uHue != 0.0) {
    float angle = uHue * 3.14159265;
    float s = sin(angle), co = cos(angle);
    vec3 w = (vec3(2.0 * co, -sqrt(3.0) * s - co, sqrt(3.0) * s - co) + 1.0) / 3.0;
    c = vec3(dot(c, w.xyz), dot(c, w.zxy), dot(c, w.yzx));
  }
  if (uVibrance != 0.0) { // glfx.js vibrance
    float avg = (c.r + c.g + c.b) / 3.0;
    float mx = max(c.r, max(c.g, c.b));
    c = mix(c, vec3(mx), (mx - avg) * (-uVibrance * 3.0));
  }
  l = luma(c);
  c = mix(vec3(l), c, 1.0 + uSaturation);
  // filter grade
  c = clamp(c, 0.0, 1.0);
  c = pow(max(c * uGain + uLift * (1.0 - c), 0.0), 1.0 / max(uGamma, vec3(0.05)));
  l = luma(c);
  c += uShadowTint * (1.0 - smoothstep(0.0, 0.6, l)) + uHighTint * smoothstep(0.4, 1.0, l);
  c = (c - 0.5) * (1.0 + uGradeContrast) + 0.5;
  l = luma(c);
  c = mix(vec3(l), c, 1.0 + uGradeSat);
  c = mix(c, vec3(l), uMono);
  c *= uTone;
  float fade = clamp(uFade + uGradeFade, 0.0, 1.0);
  c = c * (1.0 - 0.22 * fade) + 0.11 * fade;
  if (uVignette != 0.0) {
    float d = distance(vUv, vec2(0.5));
    c *= mix(1.0, smoothstep(0.85, 0.25, d), clamp(uVignette, 0.0, 1.0));
    if (uVignette < 0.0) c = mix(c, vec3(1.0), smoothstep(0.3, 0.9, d) * -uVignette);
  }
  if (uGrain > 0.0) {
    float g = hash12(vUv * uRes + fract(uTime * 13.7) * 311.0) - 0.5;
    c += g * uGrain * 0.25;
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
}`;

export const CHROMA = HEADER + COMMON + `
uniform sampler2D uTex;
uniform vec3 uKey;
uniform float uSimilarity, uSmoothness, uSpill;
vec2 cbcr(vec3 c) { return vec2(-0.169 * c.r - 0.331 * c.g + 0.5 * c.b, 0.5 * c.r - 0.419 * c.g - 0.081 * c.b); }
void main() {
  vec4 src = texture2D(uTex, vUv);
  float d = distance(cbcr(src.rgb), cbcr(uKey));
  float a = smoothstep(uSimilarity, uSimilarity + uSmoothness + 0.001, d);
  float spill = 1.0 - smoothstep(uSimilarity, uSimilarity + uSpill + 0.001, d);
  vec3 c = mix(src.rgb, vec3(luma(src.rgb)), spill * 0.85);
  gl_FragColor = vec4(c, src.a * a);
}`;

// Separable gaussian blur, 13 taps with linear sampling.
export const BLUR = HEADER + `
uniform sampler2D uTex;
uniform vec2 uDir; // texel step * radius scale
void main() {
  vec4 c = texture2D(uTex, vUv) * 0.1964825501511404;
  c += texture2D(uTex, vUv + uDir * 1.411764705882353) * 0.2969069646728344;
  c += texture2D(uTex, vUv - uDir * 1.411764705882353) * 0.2969069646728344;
  c += texture2D(uTex, vUv + uDir * 3.2941176470588234) * 0.09447039785044732;
  c += texture2D(uTex, vUv - uDir * 3.2941176470588234) * 0.09447039785044732;
  c += texture2D(uTex, vUv + uDir * 5.176470588235294) * 0.010381362401148057;
  c += texture2D(uTex, vUv - uDir * 5.176470588235294) * 0.010381362401148057;
  gl_FragColor = c;
}`;

export const BLEND_MODES = [
  ['normal', 'Normal'],
  ['multiply', 'Multiply'],
  ['screen', 'Screen'],
  ['overlay', 'Overlay'],
  ['darken', 'Darken'],
  ['lighten', 'Lighten'],
  ['dodge', 'Color dodge'],
  ['burn', 'Color burn'],
  ['hardlight', 'Hard light'],
  ['softlight', 'Soft light'],
  ['difference', 'Difference'],
  ['exclusion', 'Exclusion'],
  ['add', 'Add'],
  ['color', 'Color'],
  ['luminosity', 'Luminosity'],
];

export const MASK_TYPES = [
  ['none', 'None'],
  ['circle', 'Circle'],
  ['rect', 'Rectangle'],
  ['linear', 'Linear'],
  ['mirror', 'Mirror'],
  ['heart', 'Heart'],
  ['star', 'Star'],
];
