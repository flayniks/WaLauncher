// Video effects. Each one is a GLSL function `vec4 fx(vec2 uv)` reading uTex.
// Sizes are measured against the frame height so an effect looks the same in the preview and the export.
// Shaders marked "glfx.js" are ports of Evan Wallace's glfx.js (MIT).

import { HEADER, COMMON } from './shaders.js';

const P = (k, label, min, max, def, step = 0.01) => ({ k, label, min, max, def, step });
const C = (k, label, def) => ({ k, label, type: 'color', def });

export const EFFECTS = [
  // ---------- Trending ----------
  {
    id: 'glitch', name: 'Glitch', cat: 'Glitch', params: [P('amount', 'Amount', 0, 1, 0.6), P('speed', 'Speed', 0.1, 3, 1)],
    glsl: `
vec4 fx(vec2 uv) {
  float t = floor(uTime * p_speed * 12.0);
  float row = floor(uv.y * 18.0);
  float block = step(0.62, hash12(vec2(row, t)));
  float shift = (hash12(vec2(t, row + 9.0)) - 0.5) * 0.14 * p_amount * block;
  float jitter = (hash12(vec2(t * 1.3, 7.0)) - 0.5) * 0.02 * p_amount;
  vec2 u = uv + vec2(shift + jitter, 0.0);
  float ca = 0.014 * p_amount * (0.4 + hash12(vec2(t, 3.0)));
  vec4 g = texture2D(uTex, u);
  vec3 c = vec3(texture2D(uTex, u + vec2(ca, 0.0)).r, g.g, texture2D(uTex, u - vec2(ca, 0.0)).b);
  float line = step(0.985, hash12(vec2(floor(uv.y * 120.0), t)));
  c = mix(c, 1.0 - c, line * p_amount * 0.6);
  return vec4(c, g.a);
}` },
  {
    id: 'rgbsplit', name: 'RGB Split', cat: 'Glitch', params: [P('amount', 'Amount', 0, 1, 0.4), P('angle', 'Angle', 0, 360, 0, 1), P('pulse', 'Pulse', 0, 1, 0.5)],
    glsl: `
vec4 fx(vec2 uv) {
  float a = radians(p_angle);
  float k = p_amount * 0.03 * (1.0 - p_pulse + p_pulse * (0.5 + 0.5 * sin(uTime * 6.0)));
  vec2 d = vec2(cos(a), sin(a)) * k * vec2(uRes.y / uRes.x, 1.0);
  vec4 g = texture2D(uTex, uv);
  return vec4(texture2D(uTex, uv + d).r, g.g, texture2D(uTex, uv - d).b, g.a);
}` },
  {
    id: 'datamosh', name: 'Pixel Sort', cat: 'Glitch', params: [P('amount', 'Amount', 0, 1, 0.5), P('threshold', 'Threshold', 0, 1, 0.6)],
    glsl: `
vec4 fx(vec2 uv) {
  vec4 c = texture2D(uTex, uv);
  float acc = 0.0;
  vec4 best = c;
  for (int i = 1; i <= 24; i++) {
    vec2 u = uv + vec2(0.0, float(i) * 0.012 * p_amount);
    vec4 s = texture2D(uTex, u);
    if (luma(s.rgb) > p_threshold && luma(s.rgb) > luma(best.rgb)) { best = s; acc = 1.0; }
  }
  return mix(c, best, acc * p_amount);
}` },
  {
    id: 'shake', name: 'Camera Shake', cat: 'Camera', params: [P('amount', 'Amount', 0, 1, 0.5), P('speed', 'Speed', 0.1, 4, 1.5)],
    glsl: `
vec4 fx(vec2 uv) {
  float t = uTime * p_speed * 8.0;
  vec2 off = (vec2(vnoise(vec2(t, 1.7)), vnoise(vec2(3.1, t))) - 0.5) * 0.06 * p_amount;
  float rot = (vnoise(vec2(t * 0.7, 9.2)) - 0.5) * 0.06 * p_amount;
  float zoom = 1.0 - 0.07 * p_amount;
  vec2 p = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  p = vec2(cos(rot) * p.x - sin(rot) * p.y, sin(rot) * p.x + cos(rot) * p.y) * zoom;
  return texture2D(uTex, p * vec2(uRes.y / uRes.x, 1.0) + 0.5 + off);
}` },
  {
    id: 'beatzoom', name: 'Beat Zoom', cat: 'Camera', params: [P('amount', 'Amount', 0, 1, 0.4), P('bpm', 'BPM', 40, 200, 120, 1)],
    glsl: `
vec4 fx(vec2 uv) {
  float beat = fract(uTime * p_bpm / 60.0);
  float k = 1.0 - p_amount * 0.18 * exp(-beat * 7.0);
  vec2 u = (uv - 0.5) * k + 0.5;
  vec4 c = texture2D(uTex, u);
  c.rgb += exp(-beat * 9.0) * p_amount * 0.12;
  return c;
}` },
  {
    id: 'zoomblur', name: 'Zoom Blur', cat: 'Blur', params: [P('strength', 'Strength', 0, 1, 0.35), P('cx', 'Center X', 0, 1, 0.5), P('cy', 'Center Y', 0, 1, 0.5)],
    glsl: `
// glfx.js zoomBlur
vec4 fx(vec2 uv) {
  vec4 color = vec4(0.0);
  float total = 0.0;
  vec2 toCenter = vec2(p_cx, 1.0 - p_cy) - uv;
  float offset = rand(uv * 91.7);
  for (float t = 0.0; t <= 40.0; t++) {
    float percent = (t + offset) / 40.0;
    float weight = 4.0 * (percent - percent * percent);
    vec4 s = texture2D(uTex, uv + toCenter * percent * p_strength);
    s.rgb *= s.a;
    color += s * weight;
    total += weight;
  }
  color /= total;
  color.rgb /= color.a + 0.00001;
  return color;
}` },
  {
    id: 'motionblur', name: 'Motion Streak', cat: 'Blur', params: [P('strength', 'Strength', 0, 1, 0.3), P('angle', 'Angle', 0, 360, 0, 1)],
    glsl: `
vec4 fx(vec2 uv) {
  float a = radians(p_angle);
  vec2 d = vec2(cos(a), sin(a)) * p_strength * 0.12 * vec2(uRes.y / uRes.x, 1.0);
  vec4 c = vec4(0.0);
  float offset = rand(uv * 51.3);
  for (float t = -15.0; t <= 15.0; t++) {
    float pct = (t + offset - 0.5) / 15.0;
    c += texture2D(uTex, uv + d * pct) * (1.0 - abs(pct));
  }
  return c / 15.0;
}` },
  {
    id: 'blur', name: 'Blur', cat: 'Blur', twoPass: 'blur', params: [P('radius', 'Radius', 0, 1, 0.3)],
    glsl: `vec4 fx(vec2 uv) { return texture2D(uTex, uv); }` },
  {
    id: 'tiltshift', name: 'Tilt Shift', cat: 'Blur', params: [P('blur', 'Blur', 0, 1, 0.5), P('focus', 'Focus line', 0, 1, 0.5), P('band', 'Band', 0.02, 0.6, 0.18)],
    glsl: `
// after glfx.js tiltShift, single pass
vec4 fx(vec2 uv) {
  float dist = abs((1.0 - uv.y) - p_focus);
  float r = smoothstep(p_band * 0.5, p_band * 0.5 + 0.25, dist) * p_blur * 0.025;
  if (r <= 0.0) return texture2D(uTex, uv);
  vec4 c = vec4(0.0);
  float total = 0.0;
  for (float x = -3.0; x <= 3.0; x++) {
    for (float y = -3.0; y <= 3.0; y++) {
      float w = 1.0 - length(vec2(x, y)) / 4.5;
      if (w <= 0.0) continue;
      c += texture2D(uTex, uv + vec2(x * uRes.y / uRes.x, y) * r / 3.0) * w;
      total += w;
    }
  }
  vec4 o = c / total;
  o.rgb = mix(o.rgb, (o.rgb - 0.5) * 1.1 + 0.5, smoothstep(0.0, 0.3, dist));
  return o;
}` },
  {
    id: 'glow', name: 'Soft Glow', cat: 'Light', params: [P('amount', 'Amount', 0, 1, 0.6), P('threshold', 'Threshold', 0, 1, 0.55), P('size', 'Size', 0, 1, 0.5)],
    glsl: `
vec4 fx(vec2 uv) {
  vec4 base = texture2D(uTex, uv);
  vec3 acc = vec3(0.0);
  float total = 0.0;
  float rad = 0.004 + p_size * 0.03;
  for (int ring = 1; ring <= 4; ring++) {
    for (int i = 0; i < 12; i++) {
      float a = float(i) / 12.0 * 6.2831853 + float(ring) * 0.7;
      vec2 o = vec2(cos(a), sin(a)) * rad * float(ring) * vec2(uRes.y / uRes.x, 1.0);
      vec3 s = texture2D(uTex, uv + o).rgb;
      float w = 1.0 / float(ring);
      acc += max(s - p_threshold, 0.0) / max(1.0 - p_threshold, 0.05) * s * w;
      total += w;
    }
  }
  acc /= total;
  return vec4(base.rgb + acc * p_amount * 2.2, base.a);
}` },
  {
    id: 'shine', name: 'Shine Sweep', cat: 'Light', params: [P('speed', 'Speed', 0.1, 3, 0.8), P('width', 'Width', 0.02, 0.4, 0.12), P('strength', 'Strength', 0, 1, 0.6)],
    glsl: `
vec4 fx(vec2 uv) {
  vec4 c = texture2D(uTex, uv);
  float pos = fract(uTime * p_speed * 0.5) * 2.4 - 0.7;
  float d = (uv.x * uRes.x / uRes.y + (1.0 - uv.y)) * 0.5 - pos;
  float band = exp(-d * d / (p_width * p_width * 0.25));
  c.rgb += band * p_strength * 0.8;
  return c;
}` },
  {
    id: 'lightleak', name: 'Light Leak', cat: 'Light', params: [P('amount', 'Amount', 0, 1, 0.6), P('speed', 'Speed', 0, 2, 0.5), C('tint', 'Color', '#ff8a3d')],
    glsl: `
vec4 fx(vec2 uv) {
  vec4 c = texture2D(uTex, uv);
  float t = uTime * p_speed * 0.3;
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0) * 1.6;
  float n = fbm(p + vec2(t, -t * 0.7));
  float edge = smoothstep(0.35, 1.0, max(1.0 - uv.x, uv.y) + (n - 0.5) * 0.6);
  vec3 leak = mix(p_tint, vec3(1.0, 0.95, 0.75), n);
  vec3 o = 1.0 - (1.0 - c.rgb) * (1.0 - leak * edge * p_amount);
  return vec4(o, c.a);
}` },
  {
    id: 'flash', name: 'Strobe', cat: 'Light', params: [P('amount', 'Amount', 0, 1, 0.7), P('rate', 'Flashes / sec', 0.5, 12, 4, 0.5)],
    glsl: `
vec4 fx(vec2 uv) {
  vec4 c = texture2D(uTex, uv);
  float f = exp(-fract(uTime * p_rate) * 10.0);
  c.rgb = mix(c.rgb, vec3(1.0), f * p_amount);
  return c;
}` },
  {
    id: 'bokeh', name: 'Bokeh Lights', cat: 'Light', params: [P('amount', 'Amount', 0, 1, 0.6), P('size', 'Size', 0.2, 2, 1)],
    glsl: `
vec4 fx(vec2 uv) {
  vec4 c = texture2D(uTex, uv);
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0);
  vec3 add = vec3(0.0);
  for (int i = 0; i < 18; i++) {
    float fi = float(i);
    vec2 pos = vec2(hash12(vec2(fi, 1.0)) * uRes.x / uRes.y, fract(hash12(vec2(fi, 2.0)) + uTime * (0.02 + hash12(vec2(fi, 3.0)) * 0.04)));
    float r = (0.03 + hash12(vec2(fi, 4.0)) * 0.07) * p_size;
    float d = length(p - pos);
    float disc = smoothstep(r, r * 0.8, d) * (0.6 + 0.4 * smoothstep(r * 0.5, r, d));
    vec3 col = hsv2rgb(vec3(0.08 + hash12(vec2(fi, 5.0)) * 0.12, 0.55, 1.0));
    add += disc * col * (0.25 + 0.2 * sin(uTime * 2.0 + fi));
  }
  return vec4(1.0 - (1.0 - c.rgb) * (1.0 - add * p_amount), c.a);
}` },
  {
    id: 'sparkle', name: 'Sparkle', cat: 'Light', params: [P('amount', 'Amount', 0, 1, 0.7), P('density', 'Density', 0.2, 1, 0.6)],
    glsl: `
vec4 fx(vec2 uv) {
  vec4 c = texture2D(uTex, uv);
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0) * 14.0;
  vec2 cell = floor(p);
  vec2 f = fract(p) - 0.5;
  float h = hash12(cell);
  if (h > p_density) return c;
  vec2 o = (vec2(hash12(cell + 3.1), hash12(cell + 7.7)) - 0.5) * 0.6;
  vec2 d = f - o;
  float tw = pow(0.5 + 0.5 * sin(uTime * (3.0 + h * 5.0) + h * 40.0), 6.0);
  float star = (0.0025 / (abs(d.x * d.y) + 0.002)) * smoothstep(0.5, 0.0, length(d));
  float glint = star * tw * smoothstep(0.35, 0.8, luma(texture2D(uTex, uv).rgb) + 0.3);
  c.rgb += vec3(1.0, 0.97, 0.88) * glint * p_amount * 0.5;
  return c;
}` },
  // ---------- Retro ----------
  {
    id: 'vhs', name: 'VHS', cat: 'Retro', params: [P('amount', 'Amount', 0, 1, 0.7)],
    glsl: `
vec4 fx(vec2 uv) {
  float t = uTime;
  vec2 u = uv;
  u.x += (vnoise(vec2(u.y * 30.0, t * 4.0)) - 0.5) * 0.004 * p_amount;
  float bandPos = fract(t * 0.13);
  float band = 1.0 - smoothstep(0.0, 0.03, abs(u.y - bandPos));
  u.x += band * 0.03 * p_amount * (hash12(vec2(floor(t * 30.0), floor(u.y * 200.0))) - 0.5);
  float ca = 0.004 * p_amount;
  vec3 c = vec3(texture2D(uTex, u + vec2(ca, 0.0)).r, texture2D(uTex, u).g, texture2D(uTex, u - vec2(ca, 0.0)).b);
  vec3 bl = vec3(0.0);
  for (int i = -3; i <= 3; i++) bl += texture2D(uTex, u + vec2(float(i) * 0.003, 0.0)).rgb;
  bl /= 7.0;
  c = mix(c, vec3(luma(c)) + (bl - vec3(luma(bl))), 0.6 * p_amount);
  c += (hash12(uv * uRes + fract(t) * 500.0) - 0.5) * 0.14 * p_amount;
  c *= 1.0 - 0.09 * p_amount * (0.5 + 0.5 * sin(uv.y * uRes.y * 1.6));
  c = mix(c, c * vec3(1.05, 0.97, 1.08) + vec3(0.02, 0.0, 0.03), p_amount);
  c += band * 0.08 * p_amount;
  return vec4(c, texture2D(uTex, uv).a);
}` },
  {
    id: 'oldfilm', name: 'Old Film', cat: 'Retro', params: [P('amount', 'Amount', 0, 1, 0.8), P('scratches', 'Scratches', 0, 1, 0.5)],
    glsl: `
vec4 fx(vec2 uv) {
  float t = floor(uTime * 18.0);
  vec2 u = uv + vec2(0.0, (hash12(vec2(t, 1.0)) - 0.5) * 0.004 * p_amount);
  vec4 s = texture2D(uTex, u);
  vec3 c = s.rgb;
  float l = luma(c);
  vec3 sepia = vec3(l) * vec3(1.07, 0.95, 0.78);
  c = mix(c, sepia, p_amount * 0.85);
  c *= 1.0 - p_amount * 0.12 * hash12(vec2(t, 5.0));
  c += (hash12(uv * uRes * 0.5 + t * 17.0) - 0.5) * 0.18 * p_amount;
  float x = hash12(vec2(t, 9.0));
  float scratch = (1.0 - smoothstep(0.0, 0.0015, abs(uv.x - x))) * step(0.5, hash12(vec2(t, 11.0)));
  c = mix(c, vec3(0.92), scratch * p_scratches * 0.7);
  float spot = step(0.996, hash12(floor(uv * vec2(uRes.x / uRes.y, 1.0) * 70.0) + t));
  c = mix(c, vec3(0.08), spot * p_scratches);
  float d = distance(uv, vec2(0.5));
  c *= mix(1.0, smoothstep(0.82, 0.3, d), p_amount * 0.8);
  return vec4(c, s.a);
}` },
  {
    id: 'crt', name: 'CRT Screen', cat: 'Retro', params: [P('curve', 'Curve', 0, 1, 0.5), P('lines', 'Scanlines', 0, 1, 0.6)],
    glsl: `
vec4 fx(vec2 uv) {
  vec2 p = uv * 2.0 - 1.0;
  vec2 off = abs(p.yx) / mix(12.0, 3.5, p_curve);
  p += p * off * off;
  vec2 u = p * 0.5 + 0.5;
  if (u.x < 0.0 || u.y < 0.0 || u.x > 1.0 || u.y > 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec3 c = vec3(texture2D(uTex, u + vec2(0.0015, 0.0)).r, texture2D(uTex, u).g, texture2D(uTex, u - vec2(0.0015, 0.0)).b);
  float sl = 0.5 + 0.5 * sin(u.y * uRes.y * 1.4);
  c *= 1.0 - p_lines * 0.45 * sl;
  float mask = 0.5 + 0.5 * sin(u.x * uRes.x * 2.1);
  c *= 1.0 - p_lines * 0.12 * mask;
  c *= 1.12;
  float v = smoothstep(1.4, 0.6, length(p));
  return vec4(c * v, 1.0);
}` },
  {
    id: 'scanroll', name: 'TV Roll', cat: 'Retro', params: [P('amount', 'Amount', 0, 1, 0.5), P('speed', 'Speed', 0, 2, 0.6)],
    glsl: `
vec4 fx(vec2 uv) {
  float y = fract(uv.y + uTime * p_speed * 0.5 * p_amount);
  vec4 c = texture2D(uTex, vec2(uv.x, y));
  float bar = smoothstep(0.0, 0.03, y) * smoothstep(1.0, 0.97, y);
  c.rgb *= mix(0.2, 1.0, bar);
  c.rgb += (hash12(uv * uRes + fract(uTime) * 100.0) - 0.5) * 0.15 * p_amount;
  return c;
}` },
  {
    id: 'pixelate', name: 'Pixelate', cat: 'Retro', params: [P('size', 'Block size', 0.002, 0.1, 0.025, 0.001)],
    glsl: `
vec4 fx(vec2 uv) {
  vec2 cell = vec2(p_size * uRes.y / uRes.x, p_size);
  return texture2D(uTex, (floor(uv / cell) + 0.5) * cell);
}` },
  {
    id: 'hexpixel', name: 'Hex Pixels', cat: 'Retro', params: [P('size', 'Cell size', 0.004, 0.08, 0.02, 0.001)],
    glsl: `
// glfx.js hexagonalPixelate
vec4 fx(vec2 uv) {
  float scale = p_size * uRes.y;
  vec2 tex = (uv * uRes - uRes * 0.5) / scale;
  tex.y /= 0.866025404;
  tex.x -= tex.y * 0.5;
  vec2 a;
  if (tex.x + tex.y - floor(tex.x) - floor(tex.y) < 1.0) a = vec2(floor(tex.x), floor(tex.y));
  else a = vec2(ceil(tex.x), ceil(tex.y));
  vec2 b = vec2(ceil(tex.x), floor(tex.y));
  vec2 c = vec2(floor(tex.x), ceil(tex.y));
  vec3 TEX = vec3(tex.x, tex.y, 1.0 - tex.x - tex.y);
  vec3 A = vec3(a.x, a.y, 1.0 - a.x - a.y);
  vec3 B = vec3(b.x, b.y, 1.0 - b.x - b.y);
  vec3 Cc = vec3(c.x, c.y, 1.0 - c.x - c.y);
  float alen = length(TEX - A);
  float blen = length(TEX - B);
  float clen = length(TEX - Cc);
  vec2 choice;
  if (alen < blen) { if (alen < clen) choice = a; else choice = c; }
  else { if (blen < clen) choice = b; else choice = c; }
  choice.x += choice.y * 0.5;
  choice.y *= 0.866025404;
  choice *= scale / uRes;
  return texture2D(uTex, choice + 0.5);
}` },
  {
    id: 'led', name: 'LED Board', cat: 'Retro', params: [P('size', 'Dot size', 0.004, 0.05, 0.012, 0.001), P('glow', 'Glow', 0, 1, 0.5)],
    glsl: `
vec4 fx(vec2 uv) {
  vec2 cell = vec2(p_size * uRes.y / uRes.x, p_size);
  vec2 id = floor(uv / cell);
  vec2 f = fract(uv / cell) - 0.5;
  vec3 c = texture2D(uTex, (id + 0.5) * cell).rgb;
  float d = length(f);
  float dot_ = smoothstep(0.45, 0.3, d) + p_glow * 0.5 * smoothstep(0.7, 0.2, d);
  return vec4(c * dot_ * 1.2, 1.0);
}` },
  // ---------- Stylize ----------
  {
    id: 'halftone', name: 'Color Halftone', cat: 'Stylize', params: [P('size', 'Dot size', 0.002, 0.04, 0.008, 0.001), P('angle', 'Angle', 0, 90, 15, 1)],
    glsl: `
// glfx.js colorHalftone
float pattern(vec2 uv, float angle) {
  float s = sin(angle), c = cos(angle);
  vec2 tex = uv * uRes - uRes * 0.5;
  vec2 point = vec2(c * tex.x - s * tex.y, s * tex.x + c * tex.y) * (3.14159265 / (p_size * uRes.y));
  return (sin(point.x) * sin(point.y)) * 4.0;
}
vec4 fx(vec2 uv) {
  vec4 color = texture2D(uTex, uv);
  float angle = radians(p_angle);
  vec3 cmy = 1.0 - color.rgb;
  float k = min(cmy.x, min(cmy.y, cmy.z));
  cmy = (cmy - k) / (1.0 - k + 1e-5);
  cmy = clamp(cmy * 10.0 - 3.0 + vec3(pattern(uv, angle + 0.26179), pattern(uv, angle + 1.30899), pattern(uv, angle)), 0.0, 1.0);
  k = clamp(k * 10.0 - 5.0 + pattern(uv, angle + 0.78539), 0.0, 1.0);
  return vec4(1.0 - cmy - k, color.a);
}` },
  {
    id: 'dotscreen', name: 'Dot Screen', cat: 'Stylize', params: [P('size', 'Dot size', 0.002, 0.04, 0.006, 0.001), P('angle', 'Angle', 0, 90, 25, 1)],
    glsl: `
// glfx.js dotScreen
vec4 fx(vec2 uv) {
  vec4 color = texture2D(uTex, uv);
  float a = radians(p_angle);
  float s = sin(a), c = cos(a);
  vec2 tex = uv * uRes - uRes * 0.5;
  vec2 point = vec2(c * tex.x - s * tex.y, s * tex.x + c * tex.y) * (3.14159265 / (p_size * uRes.y));
  float pat = (sin(point.x) * sin(point.y)) * 4.0;
  float average = (color.r + color.g + color.b) / 3.0;
  return vec4(vec3(average * 10.0 - 5.0 + pat), color.a);
}` },
  {
    id: 'ink', name: 'Ink', cat: 'Stylize', params: [P('strength', 'Strength', 0, 1, 0.5)],
    glsl: `
// glfx.js ink
vec4 fx(vec2 uv) {
  vec2 dx = vec2(1.0 / uRes.x, 0.0) * uRes.y / 720.0;
  vec2 dy = vec2(0.0, 1.0 / uRes.y) * uRes.y / 720.0;
  vec4 color = texture2D(uTex, uv);
  float bigTotal = 0.0;
  float smallTotal = 0.0;
  vec3 bigAverage = vec3(0.0);
  vec3 smallAverage = vec3(0.0);
  for (float x = -2.0; x <= 2.0; x += 1.0) {
    for (float y = -2.0; y <= 2.0; y += 1.0) {
      vec3 s = texture2D(uTex, uv + dx * x + dy * y).rgb;
      bigAverage += s;
      bigTotal += 1.0;
      if (abs(x) + abs(y) < 2.0) { smallAverage += s; smallTotal += 1.0; }
    }
  }
  vec3 edge = max(vec3(0.0), bigAverage / bigTotal - smallAverage / smallTotal);
  float st = p_strength * p_strength * p_strength * p_strength * p_strength;
  return vec4(color.rgb - dot(edge, edge) * st * 100000.0, color.a);
}` },
  {
    id: 'sketch', name: 'Pencil Sketch', cat: 'Stylize', params: [P('strength', 'Lines', 0, 1, 0.6), P('paper', 'Paper', 0, 1, 0.4)],
    glsl: `
float L(vec2 u) { return luma(texture2D(uTex, u).rgb); }
vec4 fx(vec2 uv) {
  vec2 px = vec2(1.0 / uRes.x, 1.0 / uRes.y) * uRes.y / 720.0;
  float gx = -L(uv + vec2(-px.x, px.y)) - 2.0 * L(uv + vec2(-px.x, 0.0)) - L(uv - px) + L(uv + px) + 2.0 * L(uv + vec2(px.x, 0.0)) + L(uv + vec2(px.x, -px.y));
  float gy = -L(uv - px) - 2.0 * L(uv + vec2(0.0, -px.y)) - L(uv + vec2(px.x, -px.y)) + L(uv + vec2(-px.x, px.y)) + 2.0 * L(uv + vec2(0.0, px.y)) + L(uv + px);
  float e = clamp(length(vec2(gx, gy)) * (1.0 + p_strength * 4.0), 0.0, 1.0);
  float paper = 0.94 + (fbm(uv * uRes / 3.0) - 0.5) * 0.12 * p_paper;
  float tone = mix(1.0, L(uv) * 0.4 + 0.6, 0.5);
  return vec4(vec3(paper * tone * (1.0 - e)), texture2D(uTex, uv).a);
}` },
  {
    id: 'comic', name: 'Comic', cat: 'Stylize', params: [P('levels', 'Colors', 2, 8, 4, 1), P('edges', 'Outlines', 0, 1, 0.7)],
    glsl: `
float L(vec2 u) { return luma(texture2D(uTex, u).rgb); }
vec4 fx(vec2 uv) {
  vec4 s = texture2D(uTex, uv);
  vec3 hsv = rgb2hsv(s.rgb);
  hsv.y = min(1.0, hsv.y * 1.35);
  hsv.z = floor(hsv.z * p_levels + 0.5) / p_levels;
  vec3 c = hsv2rgb(hsv);
  vec2 px = vec2(1.0 / uRes.x, 1.0 / uRes.y) * uRes.y / 720.0 * 1.5;
  float gx = L(uv + vec2(px.x, 0.0)) - L(uv - vec2(px.x, 0.0));
  float gy = L(uv + vec2(0.0, px.y)) - L(uv - vec2(0.0, px.y));
  float e = smoothstep(0.08, 0.25, length(vec2(gx, gy)));
  return vec4(mix(c, vec3(0.05), e * p_edges), s.a);
}` },
  {
    id: 'neon', name: 'Neon Edges', cat: 'Stylize', params: [P('glow', 'Glow', 0, 1, 0.7), P('cycle', 'Color cycle', 0, 2, 0.5), P('keep', 'Keep image', 0, 1, 0.15)],
    glsl: `
float L(vec2 u) { return luma(texture2D(uTex, u).rgb); }
vec4 fx(vec2 uv) {
  vec2 px = vec2(1.0 / uRes.x, 1.0 / uRes.y) * uRes.y / 720.0 * 1.5;
  float gx = L(uv + vec2(px.x, 0.0)) - L(uv - vec2(px.x, 0.0));
  float gy = L(uv + vec2(0.0, px.y)) - L(uv - vec2(0.0, px.y));
  float e = smoothstep(0.03, 0.3, length(vec2(gx, gy)));
  vec3 col = hsv2rgb(vec3(fract(uv.x * 0.5 + uv.y * 0.3 + uTime * p_cycle * 0.2), 0.85, 1.0));
  vec4 s = texture2D(uTex, uv);
  vec3 c = s.rgb * p_keep + col * e * (1.0 + p_glow * 1.5);
  return vec4(c, s.a);
}` },
  {
    id: 'oilpaint', name: 'Oil Paint', cat: 'Stylize', params: [P('radius', 'Brush', 1, 6, 4, 1)],
    glsl: `
// Kuwahara filter: four quadrants, keep the mean of the calmest one.
vec4 fx(vec2 uv) {
  vec2 px = vec2(1.0 / uRes.x, 1.0 / uRes.y) * uRes.y / 720.0;
  vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
  vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);
  float n = 0.0;
  for (int j = 0; j <= 6; j++) {
    for (int i = 0; i <= 6; i++) {
      if (float(i) > p_radius || float(j) > p_radius) continue;
      vec3 c;
      c = texture2D(uTex, uv + vec2(-float(i), -float(j)) * px).rgb; m0 += c; s0 += c * c;
      c = texture2D(uTex, uv + vec2(float(i), -float(j)) * px).rgb; m1 += c; s1 += c * c;
      c = texture2D(uTex, uv + vec2(float(i), float(j)) * px).rgb; m2 += c; s2 += c * c;
      c = texture2D(uTex, uv + vec2(-float(i), float(j)) * px).rgb; m3 += c; s3 += c * c;
      n += 1.0;
    }
  }
  m0 /= n; m1 /= n; m2 /= n; m3 /= n;
  float v0 = dot(abs(s0 / n - m0 * m0), vec3(1.0));
  float v1 = dot(abs(s1 / n - m1 * m1), vec3(1.0));
  float v2 = dot(abs(s2 / n - m2 * m2), vec3(1.0));
  float v3 = dot(abs(s3 / n - m3 * m3), vec3(1.0));
  vec3 c = m0; float v = v0;
  if (v1 < v) { v = v1; c = m1; }
  if (v2 < v) { v = v2; c = m2; }
  if (v3 < v) { v = v3; c = m3; }
  return vec4(c, texture2D(uTex, uv).a);
}` },
  {
    id: 'emboss', name: 'Emboss', cat: 'Stylize', params: [P('strength', 'Strength', 0, 1, 0.6)],
    glsl: `
vec4 fx(vec2 uv) {
  vec2 px = vec2(1.0 / uRes.x, 1.0 / uRes.y) * uRes.y / 720.0 * 1.5;
  vec3 a = texture2D(uTex, uv - px).rgb;
  vec3 b = texture2D(uTex, uv + px).rgb;
  float e = luma(b - a) * (2.0 + p_strength * 6.0) + 0.5;
  vec4 s = texture2D(uTex, uv);
  return vec4(mix(s.rgb, vec3(e), p_strength), s.a);
}` },
  {
    id: 'posterize', name: 'Posterize', cat: 'Stylize', params: [P('levels', 'Levels', 2, 12, 5, 1)],
    glsl: `vec4 fx(vec2 uv) { vec4 s = texture2D(uTex, uv); return vec4(floor(s.rgb * p_levels + 0.5) / p_levels, s.a); }` },
  {
    id: 'thermal', name: 'Thermal', cat: 'Stylize', params: [P('mix', 'Amount', 0, 1, 1)],
    glsl: `
vec3 heat(float t) {
  vec3 a = vec3(0.0, 0.0, 0.25), b = vec3(0.4, 0.0, 0.6), c = vec3(1.0, 0.1, 0.1), d = vec3(1.0, 0.85, 0.0), e = vec3(1.0);
  if (t < 0.25) return mix(a, b, t / 0.25);
  if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c, d, (t - 0.5) / 0.25);
  return mix(d, e, (t - 0.75) / 0.25);
}
vec4 fx(vec2 uv) { vec4 s = texture2D(uTex, uv); return vec4(mix(s.rgb, heat(luma(s.rgb)), p_mix), s.a); }` },
  {
    id: 'nightvision', name: 'Night Vision', cat: 'Stylize', params: [P('noise', 'Noise', 0, 1, 0.5), P('scope', 'Scope', 0, 1, 1)],
    glsl: `
vec4 fx(vec2 uv) {
  vec4 s = texture2D(uTex, uv);
  float l = luma(s.rgb) * 1.7;
  l += (hash12(uv * uRes + fract(uTime) * 300.0) - 0.5) * 0.35 * p_noise;
  l *= 0.85 + 0.15 * sin(uv.y * uRes.y * 1.2);
  vec3 c = vec3(0.1, 1.0, 0.25) * l;
  vec2 p = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float scope = mix(1.0, smoothstep(0.48, 0.44, length(p)), p_scope);
  return vec4(c * scope, s.a);
}` },
  {
    id: 'duotone', name: 'Duotone', cat: 'Stylize', params: [C('dark', 'Shadows', '#1b1464'), C('light', 'Highlights', '#ff6fb5')],
    glsl: `vec4 fx(vec2 uv) { vec4 s = texture2D(uTex, uv); return vec4(mix(p_dark, p_light, smoothstep(0.05, 0.95, luma(s.rgb))), s.a); }` },
  {
    id: 'huecycle', name: 'Psychedelic', cat: 'Stylize', params: [P('speed', 'Speed', 0, 3, 1), P('amount', 'Amount', 0, 1, 0.8)],
    glsl: `
vec4 fx(vec2 uv) {
  vec4 s = texture2D(uTex, uv);
  vec3 h = rgb2hsv(s.rgb);
  h.x = fract(h.x + uTime * p_speed * 0.2 + uv.y * 0.3 * p_amount);
  h.y = min(1.0, h.y + 0.4 * p_amount);
  return vec4(mix(s.rgb, hsv2rgb(h), p_amount), s.a);
}` },
  {
    id: 'invert', name: 'Invert', cat: 'Stylize', params: [],
    glsl: `vec4 fx(vec2 uv) { vec4 s = texture2D(uTex, uv); return vec4(1.0 - s.rgb, s.a); }` },
  {
    id: 'frosted', name: 'Frosted Glass', cat: 'Stylize', params: [P('amount', 'Amount', 0, 1, 0.5)],
    glsl: `
vec4 fx(vec2 uv) {
  vec2 o = (vec2(hash12(uv * uRes), hash12(uv * uRes + 17.0)) - 0.5) * 0.03 * p_amount;
  vec4 c = texture2D(uTex, uv + o);
  c.rgb = mix(c.rgb, vec3(1.0), 0.08 * p_amount);
  return c;
}` },
  // ---------- Distort ----------
  {
    id: 'swirl', name: 'Swirl', cat: 'Distort', params: [P('angle', 'Angle', -10, 10, 3, 0.1), P('radius', 'Radius', 0.05, 1, 0.45), P('spin', 'Animate', 0, 1, 0)],
    glsl: `
// glfx.js swirl
vec4 fx(vec2 uv) {
  vec2 coord = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float distance_ = length(coord);
  float angle = p_angle * (1.0 - p_spin + p_spin * sin(uTime * 1.5));
  if (distance_ < p_radius) {
    float percent = (p_radius - distance_) / p_radius;
    float theta = percent * percent * angle;
    float s = sin(theta), c = cos(theta);
    coord = vec2(coord.x * c - coord.y * s, coord.x * s + coord.y * c);
  }
  return texture2D(uTex, coord * vec2(uRes.y / uRes.x, 1.0) + 0.5);
}` },
  {
    id: 'bulge', name: 'Fisheye', cat: 'Distort', params: [P('strength', 'Strength', -1, 1, 0.6), P('radius', 'Radius', 0.05, 1, 0.5)],
    glsl: `
// glfx.js bulgePinch
vec4 fx(vec2 uv) {
  vec2 coord = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float distance_ = length(coord);
  if (distance_ < p_radius) {
    float percent = distance_ / p_radius;
    if (p_strength > 0.0) coord *= mix(1.0, smoothstep(0.0, p_radius / max(distance_, 1e-4), percent), p_strength * 0.75);
    else coord *= mix(1.0, pow(percent, 1.0 + p_strength * 0.75) * p_radius / max(distance_, 1e-4), 1.0 - percent);
  }
  return texture2D(uTex, coord * vec2(uRes.y / uRes.x, 1.0) + 0.5);
}` },
  {
    id: 'wave', name: 'Wave', cat: 'Distort', params: [P('amp', 'Amount', 0, 1, 0.3), P('freq', 'Frequency', 1, 30, 8, 0.5), P('speed', 'Speed', 0, 5, 2)],
    glsl: `
vec4 fx(vec2 uv) {
  vec2 u = uv;
  u.x += sin(uv.y * p_freq + uTime * p_speed) * 0.03 * p_amp;
  u.y += cos(uv.x * p_freq * 0.7 + uTime * p_speed * 0.8) * 0.015 * p_amp;
  return texture2D(uTex, u);
}` },
  {
    id: 'ripple', name: 'Water Ripple', cat: 'Distort', params: [P('amp', 'Amount', 0, 1, 0.4), P('freq', 'Rings', 5, 80, 35, 1), P('speed', 'Speed', 0, 10, 4)],
    glsl: `
vec4 fx(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float d = length(p);
  float w = sin(d * p_freq - uTime * p_speed) * 0.012 * p_amp * smoothstep(0.9, 0.0, d);
  vec2 u = uv + normalize(p + 1e-5) * w;
  vec4 c = texture2D(uTex, u);
  c.rgb += w * 6.0;
  return c;
}` },
  {
    id: 'heatwave', name: 'Heat Haze', cat: 'Distort', params: [P('amount', 'Amount', 0, 1, 0.4), P('speed', 'Speed', 0, 3, 1)],
    glsl: `
vec4 fx(vec2 uv) {
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0) * 6.0;
  float n = fbm(p + vec2(0.0, -uTime * p_speed * 1.5));
  return texture2D(uTex, uv + vec2(n - 0.5, (n - 0.5) * 0.5) * 0.02 * p_amount);
}` },
  {
    id: 'kaleido', name: 'Kaleidoscope', cat: 'Distort', params: [P('segments', 'Segments', 2, 16, 6, 1), P('spin', 'Spin', -2, 2, 0.3)],
    glsl: `
vec4 fx(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x) + uTime * p_spin * 0.3;
  float seg = 6.2831853 / p_segments;
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  vec2 q = vec2(cos(a), sin(a)) * r;
  return texture2D(uTex, q * vec2(uRes.y / uRes.x, 1.0) + 0.5);
}` },
  {
    id: 'mirror', name: 'Mirror', cat: 'Split', params: [P('mode', 'Mode (1 side, 2 top, 3 quad)', 1, 3, 1, 1)],
    glsl: `
vec4 fx(vec2 uv) {
  vec2 u = uv;
  if (p_mode < 1.5) u.x = u.x > 0.5 ? 1.0 - u.x : u.x;
  else if (p_mode < 2.5) u.y = u.y < 0.5 ? 1.0 - u.y : u.y;
  else { u.x = u.x > 0.5 ? 1.0 - u.x : u.x; u.y = u.y < 0.5 ? 1.0 - u.y : u.y; }
  return texture2D(uTex, u);
}` },
  {
    id: 'split', name: 'Split Screen', cat: 'Split', params: [P('grid', 'Grid', 2, 5, 2, 1), P('gap', 'Gap', 0, 0.05, 0.006, 0.001)],
    glsl: `
vec4 fx(vec2 uv) {
  vec2 cell = fract(uv * p_grid);
  vec2 g = vec2(p_gap * uRes.y / uRes.x, p_gap) * p_grid;
  if (cell.x < g.x || cell.y < g.y || cell.x > 1.0 - g.x || cell.y > 1.0 - g.y) return vec4(0.0, 0.0, 0.0, 1.0);
  return texture2D(uTex, cell);
}` },
  {
    id: 'triple', name: 'Triple Stack', cat: 'Split', params: [P('zoom', 'Zoom', 1, 2, 1.2)],
    glsl: `
vec4 fx(vec2 uv) {
  float band = floor(uv.y * 3.0);
  float local = fract(uv.y * 3.0);
  vec2 u = vec2((uv.x - 0.5) / p_zoom + 0.5, 0.5 + (local - 0.5) / (3.0 * p_zoom));
  vec4 c = texture2D(uTex, u);
  if (band == 1.0) c.rgb = vec3(luma(c.rgb));
  return c;
}` },
  // ---------- Weather ----------
  {
    id: 'snow', name: 'Snow', cat: 'Weather', params: [P('amount', 'Amount', 0, 1, 0.7), P('speed', 'Speed', 0, 2, 0.6)],
    glsl: `
vec4 fx(vec2 uv) {
  vec4 c = texture2D(uTex, uv);
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0);
  float snow = 0.0;
  for (int l = 0; l < 4; l++) {
    float fl = float(l);
    float scale = 8.0 + fl * 6.0;
    vec2 q = p * scale + vec2(sin(uTime * 0.5 + fl) * 0.8, uTime * p_speed * (2.0 + fl));
    vec2 id = floor(q);
    vec2 f = fract(q) - 0.5;
    vec2 o = (vec2(hash12(id), hash12(id + 5.3)) - 0.5) * 0.7;
    float r = 0.05 + 0.06 * hash12(id + 2.1);
    snow += smoothstep(r, r * 0.3, length(f - o)) * step(hash12(id + 9.1), 0.35 + p_amount * 0.4) * (1.0 - fl * 0.15);
  }
  c.rgb = mix(c.rgb, vec3(1.0), clamp(snow, 0.0, 1.0) * p_amount);
  return c;
}` },
  {
    id: 'rain', name: 'Rain', cat: 'Weather', params: [P('amount', 'Amount', 0, 1, 0.6), P('angle', 'Wind', -1, 1, 0.2)],
    glsl: `
vec4 fx(vec2 uv) {
  vec4 c = texture2D(uTex, uv);
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0);
  p.x += p.y * p_angle * 0.3;
  float rain = 0.0;
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    vec2 q = p * vec2(60.0 + fl * 40.0, 2.0 + fl) + vec2(0.0, uTime * (6.0 + fl * 3.0));
    vec2 id = floor(q);
    float h = hash12(id);
    float drop = step(1.0 - 0.15 * p_amount, h) * smoothstep(0.0, 0.5, fract(q.y)) * smoothstep(1.0, 0.6, fract(q.y));
    drop *= smoothstep(0.5, 0.0, abs(fract(q.x) - 0.5) * 3.0);
    rain += drop * (0.6 - fl * 0.15);
  }
  c.rgb = mix(c.rgb * (1.0 - 0.15 * p_amount), vec3(0.85, 0.9, 1.0), clamp(rain, 0.0, 1.0) * 0.6);
  return c;
}` },
  {
    id: 'hearts', name: 'Floating Hearts', cat: 'Weather', params: [P('amount', 'Amount', 0, 1, 0.6), C('color', 'Color', '#ff4f7b')],
    glsl: `
float heartShape(vec2 p) {
  p.y = -p.y + 0.25;
  p *= 1.6;
  return pow(p.x * p.x + p.y * p.y - 0.5, 3.0) - p.x * p.x * p.y * p.y * p.y;
}
vec4 fx(vec2 uv) {
  vec4 c = texture2D(uTex, uv);
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0) * 6.0;
  p.y -= uTime * 0.6;
  vec2 id = floor(p);
  vec2 f = fract(p) - 0.5;
  float h = hash12(id);
  if (h > p_amount * 0.5) return c;
  f.x += sin(uTime * 2.0 + h * 30.0) * 0.12;
  float s = 0.3 + 0.25 * hash12(id + 4.0);
  float d = heartShape(f / s);
  float m = 1.0 - smoothstep(-0.02, 0.02, d);
  c.rgb = mix(c.rgb, p_color, m * 0.9);
  return c;
}` },
  {
    id: 'confetti', name: 'Confetti', cat: 'Weather', params: [P('amount', 'Amount', 0, 1, 0.6), P('speed', 'Speed', 0, 2, 0.8)],
    glsl: `
vec4 fx(vec2 uv) {
  vec4 c = texture2D(uTex, uv);
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    vec2 q = p * (10.0 + fl * 5.0) + vec2(0.0, uTime * p_speed * (1.5 + fl * 0.5));
    vec2 id = floor(q);
    vec2 f = fract(q) - 0.5;
    float h = hash12(id + fl * 13.0);
    if (h > p_amount * 0.6) continue;
    float a = uTime * (2.0 + h * 4.0) + h * 20.0;
    f = vec2(cos(a) * f.x - sin(a) * f.y, sin(a) * f.x + cos(a) * f.y);
    float w = 0.12 * abs(sin(uTime * 3.0 + h * 10.0)) + 0.03;
    float m = step(abs(f.x), w) * step(abs(f.y), 0.12);
    vec3 col = hsv2rgb(vec3(hash12(id + 2.0), 0.8, 1.0));
    c.rgb = mix(c.rgb, col, m);
  }
  return c;
}` },
  // ---------- Frame / Basic ----------
  {
    id: 'letterbox', name: 'Cinema Bars', cat: 'Basic', params: [P('size', 'Bar size', 0, 0.4, 0.12, 0.005), P('open', 'Animate open', 0, 1, 1, 1)],
    glsl: `
vec4 fx(vec2 uv) {
  float s = p_size;
  if (p_open > 0.5) s = mix(0.5, p_size, smoothstep(0.0, 0.12, uProg));
  vec4 c = texture2D(uTex, uv);
  if (uv.y < s || uv.y > 1.0 - s) return vec4(0.0, 0.0, 0.0, 1.0);
  return c;
}` },
  {
    id: 'vignette', name: 'Vignette', cat: 'Basic', params: [P('size', 'Size', 0, 1, 0.5), P('amount', 'Amount', 0, 1, 0.6)],
    glsl: `
// glfx.js vignette
vec4 fx(vec2 uv) {
  vec4 color = texture2D(uTex, uv);
  float dist = distance(uv, vec2(0.5, 0.5));
  color.rgb *= smoothstep(0.8, p_size * 0.799, dist * (p_amount + p_size));
  return color;
}` },
  {
    id: 'fadein', name: 'Fade from Black', cat: 'Basic', params: [P('length', 'Length', 0.05, 1, 0.3)],
    glsl: `vec4 fx(vec2 uv) { vec4 c = texture2D(uTex, uv); c.rgb *= smoothstep(0.0, p_length, uProg); return c; }` },
  {
    id: 'fadeout', name: 'Fade to Black', cat: 'Basic', params: [P('length', 'Length', 0.05, 1, 0.3)],
    glsl: `vec4 fx(vec2 uv) { vec4 c = texture2D(uTex, uv); c.rgb *= smoothstep(0.0, p_length, 1.0 - uProg); return c; }` },
  {
    id: 'blink', name: 'Eye Open', cat: 'Basic', params: [P('length', 'Length', 0.05, 1, 0.35)],
    glsl: `
vec4 fx(vec2 uv) {
  float k = smoothstep(0.0, p_length, uProg);
  float open = k * 0.75 + 0.03 * sin(k * 9.0) * (1.0 - k);
  vec2 p = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float lid = abs(p.y) - open * (0.6 - p.x * p.x * 0.35);
  vec4 c = texture2D(uTex, uv);
  c.rgb *= 1.0 - smoothstep(-0.05, 0.02, lid);
  return c;
}` },
  {
    id: 'flashwhite', name: 'Flash In', cat: 'Basic', params: [P('length', 'Length', 0.05, 1, 0.25)],
    glsl: `vec4 fx(vec2 uv) { vec4 c = texture2D(uTex, uv); c.rgb = mix(vec3(1.0), c.rgb, smoothstep(0.0, p_length, uProg)); return c; }` },
  {
    id: 'border', name: 'Film Frame', cat: 'Basic', params: [P('size', 'Border', 0, 0.15, 0.04, 0.005), P('round', 'Corner', 0, 0.2, 0.04, 0.005), C('color', 'Color', '#f4f1ea')],
    glsl: `
vec4 fx(vec2 uv) {
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  vec2 p = (uv - 0.5) * asp;
  vec2 b = asp * 0.5 - p_size;
  vec2 q = abs(p) - b + p_round;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - p_round;
  vec2 u = p / (b * 2.0) + 0.5;
  vec4 c = texture2D(uTex, u);
  return vec4(mix(c.rgb, p_color, smoothstep(-0.002, 0.002, d)), 1.0);
}` },
  {
    id: 'grain', name: 'Film Grain', cat: 'Basic', params: [P('amount', 'Amount', 0, 1, 0.4), P('size', 'Size', 0.5, 3, 1.2)],
    glsl: `
vec4 fx(vec2 uv) {
  vec4 c = texture2D(uTex, uv);
  float g = vnoise(uv * uRes / p_size + fract(uTime * 24.0) * 1000.0) - 0.5;
  c.rgb += g * p_amount * 0.35 * (1.0 - luma(c.rgb) * 0.5);
  return c;
}` },
  {
    id: 'bw', name: 'Black & White', cat: 'Basic', params: [P('contrast', 'Contrast', 0, 1, 0.4)],
    glsl: `vec4 fx(vec2 uv) { vec4 c = texture2D(uTex, uv); float l = luma(c.rgb); l = (l - 0.5) * (1.0 + p_contrast * 1.2) + 0.5; return vec4(vec3(l), c.a); }` },
  {
    id: 'sepia', name: 'Sepia', cat: 'Basic', params: [P('amount', 'Amount', 0, 1, 1)],
    glsl: `
// glfx.js sepia
vec4 fx(vec2 uv) {
  vec4 color = texture2D(uTex, uv);
  float r = color.r, g = color.g, b = color.b, amount = p_amount;
  color.r = min(1.0, (r * (1.0 - (0.607 * amount))) + (g * (0.769 * amount)) + (b * (0.189 * amount)));
  color.g = min(1.0, (r * 0.349 * amount) + (g * (1.0 - (0.314 * amount))) + (b * 0.168 * amount));
  color.b = min(1.0, (r * 0.272 * amount) + (g * 0.534 * amount) + (b * (1.0 - (0.869 * amount))));
  return color;
}` },
];

export const EFFECT_CATEGORIES = ['Glitch', 'Camera', 'Light', 'Blur', 'Retro', 'Stylize', 'Distort', 'Split', 'Weather', 'Basic'];

export const effectById = new Map(EFFECTS.map((e) => [e.id, e]));

export function defaultParams(def) {
  const out = {};
  for (const p of def.params) out[p.k] = p.def;
  return out;
}

export function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function effectSource(def) {
  let uniforms = 'uniform sampler2D uTex;\nuniform vec2 uRes;\nuniform float uTime;\nuniform float uProg;\nuniform float uMix;\n';
  for (const p of def.params) uniforms += `uniform ${p.type === 'color' ? 'vec3' : 'float'} p_${p.k};\n`;
  return (
    HEADER +
    COMMON +
    uniforms +
    def.glsl +
    `
void main() {
  vec4 o = texture2D(uTex, vUv);
  vec4 e = fx(vUv);
  gl_FragColor = mix(o, e, uMix);
}`
  );
}

export function effectUniforms(def, params) {
  const u = {};
  for (const p of def.params) {
    const v = params && params[p.k] !== undefined ? params[p.k] : p.def;
    u['p_' + p.k] = p.type === 'color' ? hexToRgb(v) : +v;
  }
  return u;
}
