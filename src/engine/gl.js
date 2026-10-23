// Thin WebGL2 layer: programs, textures, framebuffers and a full-screen quad.
// Every texture is stored bottom-up (UNPACK_FLIP_Y) so uploads and render targets share one orientation,
// which is also the orientation gl-transitions expects.

export const VERTEX_SHADER = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export class GL {
  constructor(canvas, { preserveDrawingBuffer = false } = {}) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;
    this.programs = new Map();
    this.failed = new Set();
    this.fboPool = new Map();
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.quad = buf;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.disable(gl.BLEND);
    this.white = this.texture();
    gl.bindTexture(gl.TEXTURE_2D, this.white.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.white.w = this.white.h = 1;
  }

  // Compiles once per key. Returns null (and remembers) when the source does not compile.
  program(key, fragSrc, vertSrc = VERTEX_SHADER) {
    if (this.programs.has(key)) return this.programs.get(key);
    if (this.failed.has(key)) return null;
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(log);
      }
      return s;
    };
    try {
      const vs = compile(gl.VERTEX_SHADER, vertSrc);
      const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const uniforms = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        const name = info.name.replace(/\[0\]$/, '');
        uniforms[name] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
      }
      const prog = { p, uniforms, key };
      this.programs.set(key, prog);
      return prog;
    } catch (e) {
      console.warn('Shader failed:', key, e.message);
      this.failed.add(key);
      return null;
    }
  }

  texture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, w: 0, h: 0 };
  }

  upload(t, source, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    t.w = w;
    t.h = h;
    return t;
  }

  deleteTexture(t) {
    if (t && t.tex) this.gl.deleteTexture(t.tex);
  }

  fbo(w, h) {
    const gl = this.gl;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const t = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    t.w = w;
    t.h = h;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex: t.tex, w, h };
  }

  // Temporary render targets, reused across frames. Call release() when done with one.
  acquire(w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const key = w + 'x' + h;
    const list = this.fboPool.get(key);
    if (list && list.length) return list.pop();
    return this.fbo(w, h);
  }

  release(f) {
    if (!f) return;
    const key = f.w + 'x' + f.h;
    if (!this.fboPool.has(key)) this.fboPool.set(key, []);
    const list = this.fboPool.get(key);
    if (list.length < 6) list.push(f);
    else this.deleteFbo(f);
  }

  deleteFbo(f) {
    const gl = this.gl;
    gl.deleteFramebuffer(f.fb);
    gl.deleteTexture(f.tex);
  }

  // Runs a program over the whole target. `textures` maps sampler names to {tex}; `uniforms` maps names to values.
  draw(prog, target, uniforms = {}, textures = {}) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    const w = target ? target.w : gl.drawingBufferWidth;
    const h = target ? target.h : gl.drawingBufferHeight;
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    let unit = 0;
    for (const name in textures) {
      const u = prog.uniforms[name];
      if (!u) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, textures[name] ? textures[name].tex : this.white.tex);
      gl.uniform1i(u.loc, unit);
      unit++;
    }
    for (const name in uniforms) {
      const u = prog.uniforms[name];
      if (!u) continue;
      setUniform(gl, u, uniforms[name]);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  clear(target, r = 0, g = 0, b = 0, a = 1) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : gl.drawingBufferWidth, target ? target.h : gl.drawingBufferHeight);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose() {
    const gl = this.gl;
    for (const list of this.fboPool.values()) for (const f of list) this.deleteFbo(f);
    this.fboPool.clear();
    for (const p of this.programs.values()) gl.deleteProgram(p.p);
    this.programs.clear();
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}

function setUniform(gl, u, v) {
  switch (u.type) {
    case gl.FLOAT:
      if (u.size > 1) gl.uniform1fv(u.loc, v);
      else gl.uniform1f(u.loc, +v || 0);
      break;
    case gl.FLOAT_VEC2:
      gl.uniform2fv(u.loc, v);
      break;
    case gl.FLOAT_VEC3:
      gl.uniform3fv(u.loc, v);
      break;
    case gl.FLOAT_VEC4:
      gl.uniform4fv(u.loc, v);
      break;
    case gl.INT:
    case gl.BOOL:
      if (u.size > 1) gl.uniform1iv(u.loc, v);
      else gl.uniform1i(u.loc, typeof v === 'boolean' ? (v ? 1 : 0) : Math.round(+v || 0));
      break;
    case gl.INT_VEC2:
    case gl.BOOL_VEC2:
      gl.uniform2iv(u.loc, v.map((x) => Math.round(+x)));
      break;
    case gl.INT_VEC3:
      gl.uniform3iv(u.loc, v.map((x) => Math.round(+x)));
      break;
    case gl.INT_VEC4:
      gl.uniform4iv(u.loc, v.map((x) => Math.round(+x)));
      break;
    case gl.FLOAT_MAT3:
      gl.uniformMatrix3fv(u.loc, false, v);
      break;
    case gl.FLOAT_MAT4:
      gl.uniformMatrix4fv(u.loc, false, v);
      break;
    default:
      break;
  }
}
