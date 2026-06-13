// WebGL1 shaders for the living flame — a layered 2.5D puppet.
//
// One parameterized program, drawn once per layer (glow → core → tips). The
// SAME shader behaves differently per layer via uniforms:
//   • glow → fully tinted to the state color, soft, gently pulsing (additive)
//   • core → the face/body: NO distortion, keeps its own designed color
//            (u_tint = 0) so Ignis never washes out, only breathes
//   • tips → the licking flame: heavy heat-haze distortion, tinted to the state
//            color, white-hot at the brightest pixels, with rising embers
//
// Depth comes from parallax (u_offset, scaled per layer). When the real face
// parts arrive (eyes / mouth), each becomes another pass with its own animation.

export const VERT_SRC = /* glsl */ `
attribute vec2 a_pos;          // fullscreen clip-space quad, -1..1
varying vec2 v_uv;             // 0..1, y up
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

export const FRAG_SRC = /* glsl */ `
precision highp float;

varying vec2 v_uv;

uniform sampler2D u_tex;        // this layer, current expression
uniform sampler2D u_texNext;    // this layer, expression we crossfade toward
uniform float u_texMix;         // 0..1 crossfade
uniform float u_time;           // seconds
uniform vec3  u_color;          // live state color
uniform float u_tint;           // 0 = keep art color (face), 1 = recolor (fire)
uniform float u_distort;        // heat-haze amplitude for this layer
uniform float u_turbulence;     // churn / frequency
uniform float u_ember;          // rising-ember intensity (tips only)
uniform float u_brightness;     // emission multiplier
uniform float u_breath;         // breathing scale (~1.0)
uniform float u_motion;         // 1 full motion, 0 frozen (reduced motion)
uniform float u_opacity;        // per-layer master opacity
uniform float u_whitehot;       // white-hot core amount
uniform vec2  u_offset;         // parallax offset for this layer

// --- Ashima 2D simplex noise (MIT) ---
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x){ return mod289(((x * 34.0) + 1.0) * x); }
float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * snoise(p); p *= 2.02; a *= 0.5; }
  return s;
}

float hash21(vec2 p){
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

float luma(vec3 c){ return max(c.r, max(c.g, c.b)); }

// sparse rising sparks
float embers(vec2 uv, float t){
  float acc = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 g = uv * vec2(7.0, 2.6) + vec2(fi * 3.7, 0.0);
    g.y += t * (0.5 + 0.25 * fi);
    vec2 id = floor(g);
    vec2 f  = fract(g) - 0.5;
    float r = hash21(id + fi * 11.0);
    if (r < 0.78) continue;
    vec2 off = (vec2(hash21(id + 1.0), hash21(id + 2.0)) - 0.5) * 0.6;
    float d = length(f - off);
    float spark = smoothstep(0.16, 0.0, d);
    float flicker = 0.6 + 0.4 * sin(t * 6.0 + r * 30.0);
    acc += spark * flicker;
  }
  return clamp(acc, 0.0, 1.0);
}

void main(){
  // breathing + parallax
  vec2 uv = (v_uv - 0.5) / u_breath + 0.5 + u_offset;

  float t = u_time;
  float up = clamp(uv.y, 0.0, 1.0);

  // heat-haze displacement (zero on the core pass, where u_distort = 0)
  vec2 duv = uv;
  if (u_distort > 0.0001) {
    vec2 q = uv * (2.5 + u_turbulence * 2.0);
    q.y -= t * 0.5 * u_motion;
    vec2 disp = vec2(fbm(q), fbm(q + vec2(4.7, 2.3)));
    duv = uv + disp * (u_distort * mix(0.25, 1.0, up) * u_motion);
  }

  // sample this layer, crossfading expressions, with its real alpha
  vec4 sa = texture2D(u_tex, duv);
  vec4 sb = texture2D(u_texNext, duv);
  vec4 t4 = mix(sa, sb, u_texMix);
  vec3 art = t4.rgb;
  float al = t4.a;

  // color: keep the art's own color (face), or recolor to the state hue (fire)
  float L = luma(art);
  vec3 fire = u_color * L;
  fire = mix(fire, vec3(1.0), smoothstep(0.92, 1.0, L) * u_whitehot);
  vec3 col = mix(art, fire, u_tint);
  col *= u_brightness;
  col /= max(1.0, max(col.r, max(col.g, col.b)));  // cap, preserve hue

  float alpha = al * u_opacity;

  // embers rise from the bright body (tips pass only)
  float e = 0.0;
  if (u_ember > 0.001) {
    float emask = smoothstep(0.10, 0.40, L);
    e = embers(uv, t * u_motion) * u_ember * (0.4 + emask) * u_motion;
  }
  vec3 ecol = (u_color + vec3(0.5)) * e;

  // premultiplied output
  float outa = clamp(alpha + e * 0.8, 0.0, 1.0);
  vec3 outc = col * alpha + ecol;
  gl_FragColor = vec4(outc, outa);
}
`;
