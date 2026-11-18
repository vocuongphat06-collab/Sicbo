// threeui-fx.js - Authentic ThreeUI Signature Shaders & Interactive Motion Primitives
// 1. 5-Pass WebGL2 Liquid-Metal Dispersion & Chromatic Rim Shader (ported from MengTo/threeui)
// 2. Spring-Physics Proximity Dock Magnification
// 3. 3D Counter-Parallax (--px, --py) & Smooth Conic Specular Rim ([data-spec])

(function () {
  'use strict';

  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let graphicsQuality = 'high';
  try {
    const q = localStorage.getItem('sicbo_graphics_quality');
    if (q === 'high' || q === 'balanced' || q === 'eco') graphicsQuality = q;
  } catch (_) {}

  const liquidControllers = [];
  let motionController = null;

  window.ThreeUIFX = {
    getGraphicsQuality() {
      return graphicsQuality;
    },
    setGraphicsQuality(mode) {
      const valid = (mode === 'high' || mode === 'balanced' || mode === 'eco') ? mode : 'high';
      graphicsQuality = valid;
      liquidControllers.forEach(ctrl => ctrl.applyQuality(valid));
      if (motionController) motionController.applyQuality(valid);
    }
  };

  /* =====================================================================
     1. LIQUID-METAL DISPERSION SHADER CTA
     ===================================================================== */
  function mountLiquidMetal(host) {
    const cv = host.querySelector('.liquid-fx');
    const btn = host.querySelector('.liquid-button');
    if (!cv || !btn) return;

    const gl = cv.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance'
    });

    if (!gl) {
      host.classList.add('liquid-fallback');
      return;
    }

    const VERT = `#version 300 es
in vec2 position; void main(){ gl_Position = vec4(position,0.,1.); }`;

    const HEAD = `#version 300 es
precision highp float;
out vec4 o;

uniform vec2  uC;
uniform vec2  uHalf;
uniform float uT;
uniform float uHover;
uniform float uPress;
uniform vec4  uRip[3];
uniform vec4  uRipK;
uniform vec4  uRipK2;
uniform vec4  uPtr;
uniform vec4  uPtrK;

#define PI 3.14159265

float sdPill(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + r;
  return min(max(q.x,q.y),0.) + length(max(q,0.)) - r;
}

float ripple(vec2 p, float t){
  float sum = 0.;
  for(int i = 0; i < 3; i++){
    if(uRip[i].w < 0.5) continue;
    float age = t - uRip[i].z;
    if(age < 0. || age > 4.) continue;
    vec2  rp = p - uRip[i].xy;
    float facet = 1. + uRipK2.x * cos(uRipK2.y * atan(rp.y, rp.x) + age * 2.1 + float(i) * 2.4);
    float x = (length(rp) - age * uRipK.x * facet) / uRipK.y;
    sum += exp(-pow(abs(x) + 1e-4, uRipK2.z)) * exp(-age * uRipK.z);
  }
  return sum;
}

float pointerW(vec2 p){
  if(uPtr.z < 0.001) return 0.;
  float d = length(p - uPtr.xy) / uPtrK.x;
  return exp(-d*d) * uPtr.z;
}

vec2 pointerWarp(vec2 p){
  float w = pointerW(p);
  if(w <= 0.) return vec2(0.);
  return normalize(p - uPtr.xy + vec2(1e-5)) * w * (uPtrK.y + uPtrK.z * uPtr.w);
}
`;

    const FRAG_RIM = HEAD + `
uniform float uBw;
uniform float uE[8];

float perim(vec2 d, float a, float r){
  float P = 4.*a + 2.*PI*r;
  float s;
  if(d.x >= a){
    float th = atan(d.y, d.x - a); if(th < 0.) th += 2.*PI;
    s = (th <= PI*0.5) ? r*th : P - r*(2.*PI - th);
  } else if(d.x <= -a){
    float th = atan(d.y, d.x + a); if(th < 0.) th += 2.*PI;
    s = r*PI*0.5 + 2.*a + r*(th - PI*0.5);
  } else if(d.y >= 0.){
    s = r*PI*0.5 + (a - d.x);
  } else {
    s = r*PI*1.5 + 2.*a + (d.x + a);
  }
  return s / P;
}
float pb(float u, float w){ u = fract(u); float x = min(u, 1.-u); return exp(-(x*x)/(w*w)); }

float rimHot(float s, float t){
  float v = uE[0];
  v += 0.64 * pb(s - t*uE[4],             0.075);
  v += 0.46 * pb(s + t*uE[4]*0.63 + 0.41, 0.135);
  v += 0.32 * pb(s - t*uE[4]*0.34 + 0.73, 0.200);
  return v;
}
float rimBand(float sd, float off){ return 1. - smoothstep(0., uBw*1.05, abs(sd + uBw*0.55 + off)); }

void main(){
  vec2  d  = gl_FragCoord.xy - uC;
  float sd = sdPill(d, uHalf, uHalf.y);
  if(sd > uBw*2.5 || sd < -uBw*3.5){ o = vec4(0.); return; }

  float a = max(uHalf.x - uHalf.y, 0.);
  float s = perim(d, a, uHalf.y);
  float top = mix(1., 0.5 + 0.5 * (d.y / uHalf.y), uE[5]);

  vec2  p   = vec2(d.x, -d.y) / (uHalf.y * 2.);
  float lift = 1. + uPress * uE[6] + ripple(p, uT) * uE[7]
             + pointerW(p) * uPtrK.w;

  o = vec4(vec3(
    rimBand(sd,  uE[2]) * rimHot(s + uE[3], uT),
    rimBand(sd,  0.   ) * rimHot(s,         uT),
    rimBand(sd, -uE[2]) * rimHot(s - uE[3], uT)
  ) * uE[1] * top * lift, 1.);
}`;

    const FRAG_SCENE = HEAD + `
uniform float uP[21];

float h21(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vn(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.-2.*f);
  float a = h21(i), b = h21(i+vec2(1,0)), c = h21(i+vec2(0,1)), d = h21(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y) * 2. - 1.;
}
float fbm(vec2 p, float g){
  float s = 0., a = 1., n = 0.;
  for(int i=0;i<4;i++){ s += a*vn(p); n += a; p = p*2.03 + 11.7; a *= g; }
  return s / n;
}
float fbm(vec2 p){ return fbm(p, 0.5); }

float wig(float x, float t, float seed){
  return vn(vec2(x,          t*0.150 + seed)) * 0.60
       + vn(vec2(x*2.07 + 4., t*0.105 + seed)) * 0.27
       + vn(vec2(x*4.30 - 7., t*0.080 + seed)) * 0.13;
}

float valleyAt(vec2 p, float t){ return wig(p.x*uP[0], t, 0.0) * uP[1]; }
float densAt  (vec2 p, float t){ return uP[2] * exp(uP[3] * wig(p.x*uP[4] + 9.0, t, 2.7)); }

float surface(vec2 p, float t){
  float V = (p.y - valleyAt(p,t)) * densAt(p,t);
  V += uP[5] * fbm(p*vec2(0.8, 1.7)*uP[6] + vec2(t*0.05, -t*0.03), uP[17]);
  return V - uP[7];
}
float tone(float v){
  float u = fract(v);
  float e = uP[9], W = uP[10] * 0.5;
  return smoothstep(0.5-W-e, 0.5-W, u) * (1. - smoothstep(0.5+W, 0.5+W+e, u));
}
vec3 spec(float t){ return clamp(vec3(1.5) - abs(4.*t - vec3(3.,2.,1.)), 0., 1.); }

void main(){
  vec2  d  = gl_FragCoord.xy - uC;
  float sd = sdPill(d, uHalf, uHalf.y);
  float pill = 1. - smoothstep(-1., 1., sd);
  float S = uHalf.y * 2.;
  float t = uT;

  if(uHover <= 0.0015 || pill <= 0.0015){ o = vec4(0., 0., 0., pill); return; }

  vec2  p = vec2(d.x, -d.y) / S;
  vec2  q = p + pointerWarp(p);

  float h0 = surface(q, t);
  vec2  gp = vec2(dFdx(h0), -dFdy(h0)) * S;
  float V  = surface(q - gp * uP[8] / max(uP[2], .001), t);

  vec2  gd = normalize(gp + vec2(1e-5));
  V += uP[13] * fbm(vec2(dot(q,gd)*uP[14], dot(q, vec2(-gd.y,gd.x))*uP[14]*0.04) + vec2(0., t*0.06));

  float rip  = ripple(p, t);
  float well = pointerW(p);
  V += rip * uRipK.w;

  const int N = 21;
  float mid = 1. - pow(0.5, uP[12]);
  vec3 col = vec3(0.), wsum = vec3(0.);
  for(int i=0;i<N;i++){
    float k = float(i)/float(N-1);
    vec3  w = spec(k);
    col  += w * tone(V + ((1. - pow(1. - k, uP[12])) - mid) * uP[11]);
    wsum += w;
  }
  col /= wsum;
  col = pow(col, vec3(uP[15]));

  float lit = smoothstep(uP[18], uP[19], q.y - valleyAt(q, t));
  lit *= mix(1., lit, 0.55);
  col *= uP[16] * lit;
  col = col * (1. + rip * 1.15 + well * 0.60);

  o = vec4(col * pill * uHover, pill);
}`;

    const FRAG_DOWN = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uTex, uTex2;
uniform vec2 uDstTexel;
uniform vec2 uSrcTexel;
uniform float uAdd;
void main(){
  vec2 uv = gl_FragCoord.xy * uDstTexel;
  vec2 e = uDstTexel * 0.25;
  vec4 s = texture(uTex, uv + vec2(-e.x,-e.y)) + texture(uTex, uv + vec2( e.x,-e.y))
         + texture(uTex, uv + vec2(-e.x, e.y)) + texture(uTex, uv + vec2( e.x, e.y));
  s *= 0.25;
  if(uAdd > 0.5){
    vec4 r = texture(uTex2, uv + vec2(-e.x,-e.y)) + texture(uTex2, uv + vec2( e.x,-e.y))
           + texture(uTex2, uv + vec2(-e.x, e.y)) + texture(uTex2, uv + vec2( e.x, e.y));
    s.rgb += r.rgb * 0.25;
  }
  o = s;
}`;

    const FRAG_BLUR = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uTex; uniform vec2 uTexel; uniform vec2 uDir; uniform float uR;
void main(){
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec2 st = uTexel * uDir * uR;
  vec4 s = texture(uTex, uv) * 0.1964;
  s += (texture(uTex, uv + st*1.4118) + texture(uTex, uv - st*1.4118)) * 0.2969;
  s += (texture(uTex, uv + st*3.2941) + texture(uTex, uv - st*3.2941)) * 0.0944;
  s += (texture(uTex, uv + st*5.1765) + texture(uTex, uv - st*5.1765)) * 0.0104;
  o = s;
}`;

    const FRAG_COMP = HEAD + `
uniform sampler2D uSoft, uRim, uGlow;
uniform vec2  uRes;
uniform float uGlowGain, uGlowIn, uOccl, uDim, uPunch;

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 glow = texture(uGlow, uv).rgb;

  vec2  d    = gl_FragCoord.xy - uC;
  float sd   = sdPill(d, uHalf, uHalf.y);
  float pill = 1. - smoothstep(-1., 1., sd);

  vec4 m = texture(uSoft, uv);
  float veil = 1. - smoothstep(0.46, 0.88, abs(d.y) / uHalf.y);
  vec3 metal = pow(max(m.rgb / max(m.a, 1e-3), 0.), vec3(uPunch));
  vec3 core = metal * pill * mix(1., uDim, veil) + texture(uRim, uv).rgb;

  float rip = ripple(vec2(d.x, -d.y) / (uHalf.y * 2.), uT);
  core += vec3(rip * rip) * uRipK2.w * pill * mix(1., 0.42, veil);

  float sdSh = sdPill(d + vec2(0., uHalf.y * 0.62), uHalf * 0.94, uHalf.y * 0.94);
  float occl = uOccl * exp(-max(sdSh, 0.) / (uHalf.y * 0.75));

  vec3 rgb = core + glow * uGlowGain * mix(1., uGlowIn, pill) * (1. - occl * (1. - pill));

  float a = clamp(max(rgb.r, max(rgb.g, rgb.b)), 0., 1.);
  o = vec4(min(rgb, vec3(1.)), a);
}`;

    const P = {
      valFreq: 0.50, valAmp: 0.55, dens: 2.40, densVar: 2.20, densFreq: 0.32,
      wobAmp: 0.12, wobFreq: 1.60, lift: 0.05, refract: 0.18, edge: 0.04,
      width: 0.46, disp: 0.31, skew: 1.50, fineAmp: 0.0, fineFreq: 9.0,
      gamma: 1.00, gain: 1.92, octGain: 0.32, litLo: -0.26, litHi: 0.10, dim: 0.42
    };
    const PKEYS = Object.keys(P);

    const E = {
      base: 0.24, hot: 0.88, chromA: 0.44, chromS: 0.032,
      speed: 0.075, top: 0.35, press: 0.88, ripple: 1.65
    };
    const EKEYS = Object.keys(E);

    const C = {
      glow: 1.75, glowR: 1.18, glowIn: 0.30, occl: 0.62, soften: 0.24, punch: 1.50
    };

    const R = {
      speed: 1.85, width: 0.20, decay: 1.35, amp: 1.35,
      facet: 0.18, lobes: 6.0, sharp: 1.15, emit: 0.48,
      ptrRad: 0.55, ptrAmp: 0.32, ptrFast: 0.40, ptrRim: 0.82,
      ptrLag: 0.0016, ptrVref: 4.5
    };

    function sh(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s));
      }
      return s;
    }

    function prog(fs) {
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'position');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(p));
      }
      const u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        u[info.name.replace('[0]', '')] = gl.getUniformLocation(p, info.name);
      }
      return { p, u };
    }

    let pScene, pRim, pDown, pBlur, pComp;
    try {
      pScene = prog(FRAG_SCENE);
      pRim = prog(FRAG_RIM);
      pDown = prog(FRAG_DOWN);
      pBlur = prog(FRAG_BLUR);
      pComp = prog(FRAG_COMP);
    } catch (err) {
      console.warn('Liquid-Metal shader fallback:', err);
      host.classList.add('liquid-fallback');
      return;
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const hasFloat = !!gl.getExtension('EXT_color_buffer_half_float');
    function makeTarget() {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo, w: 0, h: 0 };
    }

    function sizeTarget(t, w, h) {
      if (t.w === w && t.h === h) return;
      t.w = w;
      t.h = h;
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      if (hasFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    const T_core = makeTarget(), T_rim = makeTarget(),
          T_s1 = makeTarget(), T_s2 = makeTarget(),
          T_a = makeTarget(), T_b = makeTarget();

    let W = 0, H = 0, DPR = 1, BW = 0, BH = 0, CX = 0, CY = 0;
    let DOWN = 4;
    const GLOW_TEX = 129;
    let needResize = true;
    let rafId = null;
    let quality = graphicsQuality;
    let maxDpr = 1.25;
    let idleHz = 14;
    let activeMinMs = 0;
    let blurIters = 2;

    function resize() {
      const r = host.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      if (!r.width || !r.height || !br.width || !br.height) return;
      DPR = Math.min(window.devicePixelRatio || 1, maxDpr);
      const w = Math.max(2, Math.round(r.width * DPR));
      const h = Math.max(2, Math.round(r.height * DPR));
      if (w !== W || h !== H) {
        W = w;
        H = h;
        cv.width = W;
        cv.height = H;
      }
      BW = br.width * DPR;
      BH = br.height * DPR;
      CX = (br.left - r.left) * DPR + BW / 2;
      CY = H - ((br.top - r.top) * DPR + BH / 2);

      sizeTarget(T_core, W, H);
      sizeTarget(T_rim, W, H);
      const hw = Math.max(2, Math.ceil(W / 2)), hh = Math.max(2, Math.ceil(H / 2));
      sizeTarget(T_s1, hw, hh);
      sizeTarget(T_s2, hw, hh);
      DOWN = Math.max(2, Math.min(4, Math.round(BH / GLOW_TEX)));
      const dw = Math.max(2, Math.ceil(W / DOWN)), dh = Math.max(2, Math.ceil(H / DOWN));
      sizeTarget(T_a, dw, dh);
      sizeTarget(T_b, dw, dh);
      needResize = false;
    }

    const ro = new ResizeObserver(() => { needResize = true; });
    ro.observe(host);
    ro.observe(btn);
    window.addEventListener('resize', () => { needResize = true; });

    function drawTo(t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
      gl.viewport(0, 0, t ? t.w : W, t ? t.h : H);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    const uArr = new Float32Array(PKEYS.length);
    const eArr = new Float32Array(EKEYS.length);
    let hover = 0, hoverTarget = 0, clock = 0, last = performance.now();

    const RIP = [0, 1, 2].map(() => ({ x: 0, y: 0, t: -99, on: 0 }));
    const ripArr = new Float32Array(12);
    let ripNext = 0, press = 0, pressTarget = 0;

    const ptr = { x: 0, y: 0 }, ptrS = { x: 0, y: 0 };
    let ptrAmt = 0, ptrSpeed = 0;

    function addRipple(x, y) {
      const r = RIP[ripNext];
      ripNext = (ripNext + 1) % RIP.length;
      r.x = x;
      r.y = y;
      r.t = clock;
      r.on = 1;
    }

    function localPt(e) {
      const b = btn.getBoundingClientRect();
      const s = Math.max(b.height, 1);
      return [
        (e.clientX - (b.left + b.width / 2)) / s,
        (e.clientY - (b.top + b.height / 2)) / s
      ];
    }

    const IDLE_HZ = 14;
    let lastDraw = 0;
    const on = { over: false, press: false, focus: false };

    function sync() {
      hoverTarget = (on.over || on.press || on.focus) ? 1 : 0;
      pressTarget = on.press ? 1 : 0;
      host.classList.toggle('hot', hoverTarget > 0.5);
      host.classList.toggle('press', on.press);
    }

    btn.addEventListener('pointerenter', e => {
      if (e.pointerType !== 'mouse') return;
      [ptr.x, ptr.y] = localPt(e);
      ptrS.x = ptr.x;
      ptrS.y = ptr.y;
      ptrSpeed = 0;
      on.over = true;
      sync();
    });

    btn.addEventListener('pointerleave', e => {
      if (e.pointerType === 'mouse') {
        on.over = false;
        sync();
      }
    });

    window.addEventListener('pointermove', e => {
      if (!on.over && !on.press) return;
      [ptr.x, ptr.y] = localPt(e);
    }, { passive: true });

    btn.addEventListener('pointerdown', e => {
      [ptr.x, ptr.y] = localPt(e);
      on.press = true;
      sync();
      addRipple(ptr.x, ptr.y);
    });

    window.addEventListener('pointerup', () => { on.press = false; sync(); });
    window.addEventListener('pointercancel', () => { on.press = false; sync(); });

    // Expose programmatic pulse for Spacebar / Auto-Live Roll
    window.triggerLiquidRollPulse = function () {
      if (quality === 'eco') {
        host.classList.remove('eco-pulse');
        void host.offsetWidth;
        host.classList.add('eco-pulse');
        setTimeout(() => host.classList.remove('eco-pulse'), 420);
        return;
      }
      addRipple(0, 0);
      hover = Math.max(hover, 0.85);
      scheduleFrame();
    };

    function scheduleFrame() {
      if (rafId === null && !document.hidden && quality !== 'eco') {
        rafId = requestAnimationFrame(frame);
      }
    }

    function stopFrame() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    function frame(now) {
      rafId = null;
      if (document.hidden || quality === 'eco') return;

      const dtRaw = (now - last) / 1000;
      last = now;
      const dt = Math.min(Math.max(dtRaw, 0), 1 / 20);
      if (!REDUCED) clock += dt;

      const k = hoverTarget > hover ? 1 - Math.pow(0.0012, dt) : 1 - Math.pow(0.00012, dt);
      hover += (hoverTarget - hover) * k;
      if (Math.abs(hoverTarget - hover) < 0.0008) hover = hoverTarget;

      const pk = pressTarget > press ? 1 - Math.pow(1e-9, dt) : 1 - Math.pow(0.004, dt);
      press += (pressTarget - press) * pk;
      if (Math.abs(pressTarget - press) < 0.002) press = pressTarget;

      for (let i = 0; i < RIP.length; i++) {
        const r = RIP[i];
        if (r.on && clock - r.t > 4) r.on = 0;
        ripArr[i * 4] = r.x;
        ripArr[i * 4 + 1] = r.y;
        ripArr[i * 4 + 2] = r.t;
        ripArr[i * 4 + 3] = r.on;
      }
      const ripLive = RIP.some(r => r.on);

      const lag = 1 - Math.pow(R.ptrLag, dt);
      const dx = (ptr.x - ptrS.x) * lag;
      const dy = (ptr.y - ptrS.y) * lag;
      ptrS.x += dx;
      ptrS.y += dy;
      const inst = Math.min(Math.hypot(dx, dy) / Math.max(dt, 1e-3) / R.ptrVref, 1);
      ptrSpeed += (inst - ptrSpeed) * (1 - Math.pow(inst > ptrSpeed ? 0.001 : 0.02, dt));
      const wantWell = (on.over || on.press) ? 1 : 0;
      ptrAmt += (wantWell - ptrAmt) * (1 - Math.pow(0.004, dt));
      if (Math.abs(wantWell - ptrAmt) < 0.002) ptrAmt = wantWell;

      if (needResize) resize();
      if (!W || !H) {
        scheduleFrame();
        return;
      }

      const idle = !on.over && !on.press && !on.focus && !ripLive
                && hover < 0.002 && press < 0.002 && ptrAmt < 0.002;
      const minStepMs = idle ? (1000 / idleHz) : activeMinMs;
      if (minStepMs > 0 && (now - lastDraw) < minStepMs) {
        scheduleFrame();
        return;
      }
      lastDraw = now;

      for (let i = 0; i < uArr.length; i++) uArr[i] = P[PKEYS[i]];
      for (let i = 0; i < eArr.length; i++) eArr[i] = E[EKEYS[i]];
      const bw = Math.max(1.4, 3.2 * (BH / 516));

      // Pass 1: Prismatic Dispersion Metal Field
      gl.useProgram(pScene.p);
      gl.uniform2f(pScene.u.uC, CX, CY);
      gl.uniform2f(pScene.u.uHalf, BW / 2, BH / 2);
      gl.uniform1f(pScene.u.uT, clock);
      gl.uniform1f(pScene.u.uHover, hover);
      gl.uniform1f(pScene.u.uPress, press);
      gl.uniform4fv(pScene.u.uRip, ripArr);
      gl.uniform4f(pScene.u.uRipK, R.speed, R.width, R.decay, R.amp);
      gl.uniform4f(pScene.u.uRipK2, R.facet, R.lobes, R.sharp, R.emit);
      gl.uniform4f(pScene.u.uPtr, ptrS.x, ptrS.y, ptrAmt, ptrSpeed);
      gl.uniform4f(pScene.u.uPtrK, R.ptrRad, R.ptrAmp, R.ptrFast, R.ptrRim);
      gl.uniform1fv(pScene.u.uP, uArr);
      drawTo(T_core);

      // Pass 2: Crisp Chromatic Travelling Rim
      gl.useProgram(pRim.p);
      gl.uniform2f(pRim.u.uC, CX, CY);
      gl.uniform2f(pRim.u.uHalf, BW / 2, BH / 2);
      gl.uniform1f(pRim.u.uT, clock);
      gl.uniform1f(pRim.u.uBw, bw);
      gl.uniform1f(pRim.u.uPress, press);
      gl.uniform4fv(pRim.u.uRip, ripArr);
      gl.uniform4f(pRim.u.uRipK, R.speed, R.width, R.decay, R.amp);
      gl.uniform4f(pRim.u.uRipK2, R.facet, R.lobes, R.sharp, R.emit);
      gl.uniform4f(pRim.u.uPtr, ptrS.x, ptrS.y, ptrAmt, ptrSpeed);
      gl.uniform4f(pRim.u.uPtrK, R.ptrRad, R.ptrAmp, R.ptrFast, R.ptrRim);
      gl.uniform1fv(pRim.u.uE, eArr);
      drawTo(T_rim);

      // Pass 3: Half-Res Molten Softening Blur
      gl.useProgram(pDown.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, T_core.tex);
      gl.uniform1i(pDown.u.uTex, 0);
      gl.uniform1f(pDown.u.uAdd, 0);
      gl.uniform2f(pDown.u.uDstTexel, 1 / T_s1.w, 1 / T_s1.h);
      gl.uniform2f(pDown.u.uSrcTexel, 1 / W, 1 / H);
      drawTo(T_s1);

      gl.useProgram(pBlur.p);
      gl.uniform1i(pBlur.u.uTex, 0);
      gl.uniform2f(pBlur.u.uTexel, 1 / T_s1.w, 1 / T_s1.h);
      const sigTex = C.soften * (BH * 0.5) * 0.95;
      if (sigTex > 0.1 && (hover > 0.01 || ripLive)) {
        const iters = blurIters;
        gl.uniform1f(pBlur.u.uR, sigTex / Math.sqrt(iters) / 1.95);
        for (let i = 0; i < iters; i++) {
          gl.bindTexture(gl.TEXTURE_2D, T_s1.tex);
          gl.uniform2f(pBlur.u.uDir, 1, 0);
          drawTo(T_s2);
          gl.bindTexture(gl.TEXTURE_2D, T_s2.tex);
          gl.uniform2f(pBlur.u.uDir, 0, 1);
          drawTo(T_s1);
        }
      }

      // Pass 4: Outer Bloom Chain
      gl.useProgram(pDown.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, T_s1.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, T_rim.tex);
      gl.uniform1i(pDown.u.uTex, 0);
      gl.uniform1i(pDown.u.uTex2, 1);
      gl.uniform1f(pDown.u.uAdd, 1);
      gl.uniform2f(pDown.u.uDstTexel, 1 / T_a.w, 1 / T_a.h);
      gl.uniform2f(pDown.u.uSrcTexel, 1 / T_s1.w, 1 / T_s1.h);
      drawTo(T_a);

      gl.useProgram(pBlur.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(pBlur.u.uTex, 0);
      gl.uniform2f(pBlur.u.uTexel, 1 / T_a.w, 1 / T_a.h);
      const rs = C.glowR * (BH / DOWN) / GLOW_TEX;
      for (const r of [1.5, 4.5].map(v => v * rs)) {
        gl.uniform1f(pBlur.u.uR, r);
        gl.bindTexture(gl.TEXTURE_2D, T_a.tex);
        gl.uniform2f(pBlur.u.uDir, 1, 0);
        drawTo(T_b);
        gl.bindTexture(gl.TEXTURE_2D, T_b.tex);
        gl.uniform2f(pBlur.u.uDir, 0, 1);
        drawTo(T_a);
      }

      // Pass 5: Final Composite onto Transparent Canvas
      gl.useProgram(pComp.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, T_s1.tex);
      gl.uniform1i(pComp.u.uSoft, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, T_rim.tex);
      gl.uniform1i(pComp.u.uRim, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, T_a.tex);
      gl.uniform1i(pComp.u.uGlow, 2);
      gl.uniform2f(pComp.u.uRes, W, H);
      gl.uniform2f(pComp.u.uC, CX, CY);
      gl.uniform2f(pComp.u.uHalf, BW / 2, BH / 2);
      gl.uniform1f(pComp.u.uT, clock);
      gl.uniform4fv(pComp.u.uRip, ripArr);
      gl.uniform4f(pComp.u.uRipK, R.speed, R.width, R.decay, R.amp);
      gl.uniform4f(pComp.u.uRipK2, R.facet, R.lobes, R.sharp, R.emit);
      gl.uniform1f(pComp.u.uGlowGain, C.glow);
      gl.uniform1f(pComp.u.uGlowIn, C.glowIn);
      gl.uniform1f(pComp.u.uOccl, C.occl);
      gl.uniform1f(pComp.u.uDim, P.dim);
      gl.uniform1f(pComp.u.uPunch, C.punch);
      drawTo(null);

      scheduleFrame();
    }

    function applyQuality(mode) {
      quality = mode;
      if (mode === 'eco') {
        stopFrame();
        host.classList.add('liquid-fallback');
        cv.style.display = 'none';
        return;
      }
      host.classList.remove('liquid-fallback');
      cv.style.display = '';
      if (mode === 'balanced') {
        maxDpr = 1.0;
        idleHz = 8;
        activeMinMs = 1000 / 36;
        blurIters = 1;
      } else {
        maxDpr = 1.25;
        idleHz = 14;
        activeMinMs = 0;
        blurIters = 2;
      }
      needResize = true;
      last = performance.now();
      lastDraw = 0;
      scheduleFrame();
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopFrame();
      } else if (quality !== 'eco') {
        last = performance.now();
        lastDraw = 0;
        scheduleFrame();
      }
    });

    liquidControllers.push({ applyQuality });
    resize();
    applyQuality(graphicsQuality);
  }

  /* =====================================================================
     2. THREEUI SPRING DOCK MAGNIFICATION + 3D COUNTER-PARALLAX + SPECULAR RIM
     ===================================================================== */
  function clamp01(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  }

  function initThreeUIMotion() {
    const finePointer = !REDUCED && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    // Dock Setup
    const dockRoot = document.querySelector('.top-pill-nav');
    const dockItems = dockRoot
      ? Array.from(dockRoot.querySelectorAll('[data-dock]')).map(el => ({
          el,
          v: 0,
          vel: 0,
          target: 0
        }))
      : [];

    // Specular Rim Items
    const specItems = Array.from(document.querySelectorAll('[data-spec]')).map(el => ({
      el,
      ang: 2.4,
      tAng: 2.4,
      br: 0.35,
      tBr: 0.35,
      reach: el.classList.contains('top-pill-nav') ? 280 : 240
    }));

    let aimX = window.innerWidth * 0.5;
    let aimY = window.innerHeight * 0.5;
    let aimSeen = false;
    let aimMoved = false;
    let dockLive = false;
    let dockDirty = false;
    let specDirty = true;

    const pointerNorm = { x: 0, y: 0 };
    const smoothNorm = { x: 0, y: 0 };
    let lastPX = null, lastPY = null;

    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      aimX = e.clientX;
      aimY = e.clientY;
      aimSeen = true;
      aimMoved = true;
      dockDirty = true;
      specDirty = true;

      pointerNorm.x = (e.clientX / Math.max(window.innerWidth, 1)) * 2 - 1;
      pointerNorm.y = (e.clientY / Math.max(window.innerHeight, 1)) * 2 - 1;
    }, { passive: true });

    window.addEventListener('pointerleave', () => {
      aimSeen = false;
      pointerNorm.x = 0;
      pointerNorm.y = 0;
      dockItems.forEach(st => { st.target = 0; });
      dockLive = false;
      dockDirty = true;
      specItems.forEach(st => { st.tBr = 0.22; });
      specDirty = true;
    });

    let lastTick = performance.now();
    let motionRafId = null;
    let motionQuality = graphicsQuality;
    let lastMotionDraw = 0;

    function scheduleMotion() {
      if (motionRafId === null && !document.hidden && motionQuality !== 'eco') {
        motionRafId = requestAnimationFrame(stepMotion);
      }
    }

    function stopMotion() {
      if (motionRafId !== null) {
        cancelAnimationFrame(motionRafId);
        motionRafId = null;
      }
    }

    function stepMotion(now) {
      motionRafId = null;
      if (document.hidden || motionQuality === 'eco') return;
      if (motionQuality === 'balanced' && (now - lastMotionDraw) < (1000 / 40)) {
        scheduleMotion();
        return;
      }
      lastMotionDraw = now;
      const dt = Math.min(Math.max((now - lastTick) / 1000, 0), 0.05);
      lastTick = now;

      // 1. Eased --px, --py 3D Counter-Parallax for Alabaster Card Windows
      if (!REDUCED) {
        smoothNorm.x += (pointerNorm.x - smoothNorm.x) * 0.065;
        smoothNorm.y += (pointerNorm.y - smoothNorm.y) * 0.065;
        const nx = Math.round(smoothNorm.x * 1000) / 1000;
        const ny = Math.round(smoothNorm.y * 1000) / 1000;
        if (nx !== lastPX || ny !== lastPY) {
          lastPX = nx;
          lastPY = ny;
          document.documentElement.style.setProperty('--px', nx);
          document.documentElement.style.setProperty('--py', ny);
        }
      }

      // 2. Spring-Physics Dock Magnification
      if (finePointer && dockRoot && dockItems.length > 0) {
        if (aimSeen && aimMoved) {
          const rr = dockRoot.getBoundingClientRect();
          if (aimX > rr.left - 44 && aimX < rr.right + 44 && aimY > rr.top - 36 && aimY < rr.bottom + 84) {
            for (let i = 0; i < dockItems.length; i++) {
              const st = dockItems[i];
              const r = st.el.getBoundingClientRect();
              const prox = clamp01(1 - Math.abs(aimX - (r.left + r.width * 0.5)) / 120);
              st.target = prox * prox * (3 - 2 * prox);
            }
            dockLive = true;
            dockDirty = true;
          } else if (dockLive) {
            dockLive = false;
            dockDirty = true;
            for (let i = 0; i < dockItems.length; i++) dockItems[i].target = 0;
          }
        }

        if (dockDirty) {
          let moving = false;
          for (let i = 0; i < dockItems.length; i++) {
            const st = dockItems[i];
            st.vel += (st.target - st.v) * 190 * dt;
            st.vel *= Math.exp(-23 * dt);
            st.v += st.vel * dt;
            if (Math.abs(st.target - st.v) < 0.001 && Math.abs(st.vel) < 0.004) {
              st.v = st.target;
              st.vel = 0;
            } else {
              moving = true;
            }
            const v = Math.min(Math.max(st.v, 0), 1.08);
            const scale = 1 + v * 0.14;
            const liftY = v * 2.5;
            const padX = v * 5.5;
            st.el.style.transform = `translateY(${liftY.toFixed(2)}px) scale(${scale.toFixed(3)})`;
            st.el.style.marginLeft = `${padX.toFixed(2)}px`;
            st.el.style.marginRight = `${padX.toFixed(2)}px`;
          }
          if (!moving) dockDirty = false;
        }
      }

      // 3. Smooth Conic Specular Rim Tracking ([data-spec])
      if (finePointer && specItems.length > 0) {
        if (aimSeen && aimMoved) {
          for (let i = 0; i < specItems.length; i++) {
            const st = specItems[i];
            const r = st.el.getBoundingClientRect();
            const cx = r.left + r.width * 0.5;
            const cy = r.top + r.height * 0.5;
            const dx = Math.max(r.left - aimX, 0, aimX - r.right);
            const dy = Math.max(r.top - aimY, 0, aimY - r.bottom);
            const d = Math.hypot(dx, dy);
            st.tAng = d === 0
              ? Math.atan2(2 / Math.max(r.height, 1), -2 / Math.max(r.width, 1))
                + ((aimX - cx) / Math.max(r.width * 0.5, 1)) * 0.30
                + ((cy - aimY) / Math.max(r.height * 0.5, 1)) * 0.15
              : Math.atan2(cy - aimY, aimX - cx);
            const raw = clamp01(1 - d / st.reach);
            st.tBr = Math.max(0.24, raw * raw * (3 - 2 * raw));
          }
          specDirty = true;
        }

        if (specDirty) {
          let moving = false;
          for (let i = 0; i < specItems.length; i++) {
            const st = specItems[i];
            const diff = ((st.tAng - st.ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
            st.ang += diff * (1 - Math.exp(-dt * 8.5));
            st.br += (st.tBr - st.br) * (1 - Math.exp(-dt * 9.5));
            if (Math.abs(diff) < 0.001 && Math.abs(st.tBr - st.br) < 0.002) {
              st.ang = st.tAng;
              st.br = st.tBr;
            } else {
              moving = true;
            }
            st.el.style.setProperty('--spec-angle', `${st.ang.toFixed(4)}rad`);
            st.el.style.setProperty('--spec-bright', `${(clamp01(st.br) * 0.94).toFixed(3)}`);
          }
          if (!moving) specDirty = false;
        }
      }

      aimMoved = false;
      scheduleMotion();
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopMotion();
      } else if (motionQuality !== 'eco') {
        lastTick = performance.now();
        scheduleMotion();
      }
    });

    motionController = {
      applyQuality(mode) {
        motionQuality = mode;
        if (mode === 'eco') {
          stopMotion();
          document.documentElement.style.setProperty('--px', 0);
          document.documentElement.style.setProperty('--py', 0);
          lastPX = 0;
          lastPY = 0;
          dockItems.forEach(st => {
            st.v = 0;
            st.vel = 0;
            st.target = 0;
            st.el.style.transform = '';
            st.el.style.marginLeft = '';
            st.el.style.marginRight = '';
          });
          specItems.forEach(st => {
            st.el.style.setProperty('--spec-bright', '0.32');
          });
        } else {
          lastTick = performance.now();
          lastMotionDraw = 0;
          scheduleMotion();
        }
      }
    };

    if (!document.hidden && motionQuality !== 'eco') {
      scheduleMotion();
    } else if (motionQuality === 'eco') {
      motionController.applyQuality('eco');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-liquid-metal]').forEach(mountLiquidMetal);
    initThreeUIMotion();
  });
})();
