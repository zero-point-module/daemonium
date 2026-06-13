import { FRAG_SRC, VERT_SRC } from './shaders';

type GL = WebGLRenderingContext;

/** The three layer image URLs for one expression. */
export interface FlameLayers {
  core: string;
  tips: string;
  glow: string;
}

/** What the component pushes when the state (or a debug slider) changes. */
export interface FlameTargets {
  distort: number;
  turbulence: number;
  ember: number;
  brightness: number;
  breathAmp: number;
  breathSpeed: number;
  color: [number, number, number];
  layers: FlameLayers;
}

export interface FlameRenderer {
  setTargets(t: FlameTargets): void;
  setMotion(full: boolean): void;
  setPointer(x: number, y: number): void;
  resize(cssW: number, cssH: number, dpr: number): void;
  frame(nowMs: number): void;
  dispose(): void;
}

interface Live {
  distort: number;
  turbulence: number;
  ember: number;
  brightness: number;
  breathAmp: number;
  breathSpeed: number;
  color: [number, number, number];
}

type LayerName = 'glow' | 'core' | 'tips';

interface PassConfig {
  name: LayerName;
  distortMul: number; // multiplies the state distort
  tint: number;       // 0 = keep art color, 1 = recolor to state color
  whitehot: number;   // white-hot core amount
  depth: number;      // parallax multiplier (front layers move most)
  ember: boolean;     // emit rising sparks
  additive: boolean;  // additive blend (glow) vs over (core/tips)
}

// Back to front. Core stays its natural color and undistorted (stable face).
const PASSES: PassConfig[] = [
  { name: 'glow', distortMul: 0.35, tint: 1.0, whitehot: 0.0, depth: 0.30, ember: false, additive: true },
  { name: 'core', distortMul: 0.0,  tint: 0.0, whitehot: 0.0, depth: 0.60, ember: false, additive: false },
  { name: 'tips', distortMul: 1.0,  tint: 1.0, whitehot: 0.4, depth: 1.0,  ember: true,  additive: false },
];

function compile(gl: GL, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[flame] shader compile:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function link(gl: GL, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('[flame] program link:', gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

// NPOT-safe texture (clamp + linear, no mipmaps).
function makeTexture(gl: GL, img?: TexImageSource): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (img) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

export function createFlameRenderer(canvas: HTMLCanvasElement): FlameRenderer | null {
  const opts: WebGLContextAttributes = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    depth: false,
    stencil: false,
  };
  const raw = canvas.getContext('webgl', opts) ??
    canvas.getContext('experimental-webgl', opts);
  if (!raw) return null;
  const gl = raw as GL;

  const prog = link(gl, VERT_SRC, FRAG_SRC);
  if (!prog) return null;
  gl.useProgram(prog);

  gl.enable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const U = {
    tex: gl.getUniformLocation(prog, 'u_tex'),
    texNext: gl.getUniformLocation(prog, 'u_texNext'),
    texMix: gl.getUniformLocation(prog, 'u_texMix'),
    time: gl.getUniformLocation(prog, 'u_time'),
    color: gl.getUniformLocation(prog, 'u_color'),
    tint: gl.getUniformLocation(prog, 'u_tint'),
    distort: gl.getUniformLocation(prog, 'u_distort'),
    turbulence: gl.getUniformLocation(prog, 'u_turbulence'),
    ember: gl.getUniformLocation(prog, 'u_ember'),
    brightness: gl.getUniformLocation(prog, 'u_brightness'),
    breath: gl.getUniformLocation(prog, 'u_breath'),
    motion: gl.getUniformLocation(prog, 'u_motion'),
    opacity: gl.getUniformLocation(prog, 'u_opacity'),
    whitehot: gl.getUniformLocation(prog, 'u_whitehot'),
    offset: gl.getUniformLocation(prog, 'u_offset'),
  };

  const placeholder = makeTexture(gl);
  const textures = new Map<string, WebGLTexture>();

  function load(src: string) {
    if (textures.has(src)) return;
    if (placeholder) textures.set(src, placeholder);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const tex = makeTexture(gl, img);
      if (tex) textures.set(src, tex);
    };
    img.src = src;
  }
  function texOf(src: string): WebGLTexture | null {
    return textures.get(src) ?? placeholder;
  }

  const cur: Live = {
    distort: 0.085, turbulence: 0.6, ember: 0.2, brightness: 1,
    breathAmp: 0.022, breathSpeed: 0.25, color: [1, 0.48, 0.09],
  };
  const tgt: Live = { ...cur, color: [...cur.color] as [number, number, number] };

  const base = (e: string): FlameLayers => ({
    core: `/daemon/${e}/core.png`,
    tips: `/daemon/${e}/tips.png`,
    glow: `/daemon/${e}/glow.png`,
  });
  let curL = base('idle');
  let nextL = curL;
  let mix = 0;
  let crossfading = false;

  let motion = 1;
  let last = 0;
  let phase = 0;
  let pointerX = 0;
  let pointerY = 0;
  let offX = 0;
  let offY = 0;

  (['glow', 'core', 'tips'] as LayerName[]).forEach((k) => load(curL[k]));

  function setTargets(t: FlameTargets) {
    tgt.distort = t.distort;
    tgt.turbulence = t.turbulence;
    tgt.ember = t.ember;
    tgt.brightness = t.brightness;
    tgt.breathAmp = t.breathAmp;
    tgt.breathSpeed = t.breathSpeed;
    tgt.color[0] = t.color[0];
    tgt.color[1] = t.color[1];
    tgt.color[2] = t.color[2];

    const showing = crossfading ? nextL.core : curL.core;
    if (t.layers.core !== showing) {
      (['glow', 'core', 'tips'] as LayerName[]).forEach((k) => load(t.layers[k]));
      if (crossfading) curL = nextL;
      nextL = t.layers;
      mix = 0;
      crossfading = true;
    }
  }

  function setMotion(full: boolean) { motion = full ? 1 : 0; }
  function setPointer(x: number, y: number) { pointerX = x; pointerY = y; }

  function resize(cssW: number, cssH: number, dpr: number) {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function frame(now: number) {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;

    const k = 1 - Math.exp(-dt / 0.22);
    cur.distort += (tgt.distort - cur.distort) * k;
    cur.turbulence += (tgt.turbulence - cur.turbulence) * k;
    cur.ember += (tgt.ember - cur.ember) * k;
    cur.brightness += (tgt.brightness - cur.brightness) * k;
    cur.breathAmp += (tgt.breathAmp - cur.breathAmp) * k;
    cur.breathSpeed += (tgt.breathSpeed - cur.breathSpeed) * k;
    cur.color[0] += (tgt.color[0] - cur.color[0]) * k;
    cur.color[1] += (tgt.color[1] - cur.color[1]) * k;
    cur.color[2] += (tgt.color[2] - cur.color[2]) * k;

    if (crossfading) {
      mix += dt / 0.6;
      if (mix >= 1) { mix = 1; crossfading = false; curL = nextL; }
    }

    phase += dt * cur.breathSpeed * Math.PI * 2 * motion;
    const breath = 1 + Math.sin(phase) * cur.breathAmp;

    const sway = motion * 0.010;
    const tx = motion * pointerX * 0.020 + Math.sin(now / 1000 * 0.30) * sway;
    const ty = motion * pointerY * 0.020 + Math.cos(now / 1000 * 0.23) * sway;
    const kp = 1 - Math.exp(-dt / 0.12);
    offX += (tx - offX) * kp;
    offY += (ty - offY) * kp;

    const glowOpacity = 0.55 + 0.25 * Math.sin(phase);
    const t = now / 1000;

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(U.time, t);
    gl.uniform3fv(U.color, cur.color);
    gl.uniform1f(U.turbulence, cur.turbulence);
    gl.uniform1f(U.brightness, cur.brightness);
    gl.uniform1f(U.breath, breath);
    gl.uniform1f(U.motion, motion);
    gl.uniform1f(U.texMix, crossfading ? mix : 0);

    for (let i = 0; i < PASSES.length; i++) {
      const p = PASSES[i];
      gl.blendFunc(gl.ONE, p.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);

      gl.uniform1f(U.distort, cur.distort * p.distortMul);
      gl.uniform1f(U.tint, p.tint);
      gl.uniform1f(U.whitehot, p.whitehot);
      gl.uniform1f(U.ember, p.ember ? cur.ember : 0);
      gl.uniform1f(U.opacity, p.name === 'glow' ? glowOpacity : 1);
      gl.uniform2f(U.offset, offX * p.depth, offY * p.depth);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texOf(curL[p.name]));
      gl.uniform1i(U.tex, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texOf(crossfading ? nextL[p.name] : curL[p.name]));
      gl.uniform1i(U.texNext, 1);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  function dispose() {
    textures.forEach((tex) => {
      if (tex !== placeholder) gl.deleteTexture(tex);
    });
    if (placeholder) gl.deleteTexture(placeholder);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(prog);
  }

  return { setTargets, setMotion, setPointer, resize, frame, dispose };
}
