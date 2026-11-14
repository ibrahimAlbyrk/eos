// First Light — the Eos screen saver scene in one full-screen pass. The Eos
// star hangs as the morning star over a still sea; dawn warms the horizon,
// rosy streaks drift, and the sea answers with a path of glints. Compiled at
// runtime by FirstLightRenderer; math is y-up and outputs sRGB-encoded color.
#include <metal_stdlib>
using namespace metal;

struct Uniforms {
  float4 meteor;  // start x, y as screen fractions (y up), heading in rad, age in s (< 0: none)
  float2 res;     // drawable size, px
  float2 drift;   // slow whole-scene drift, px
  float time;     // s since the saver started
  float intro;    // s since the ignition began
  float scale;    // px per design point (the scene is drawn for a 1440-pt-wide screen)
};

struct VertexOut {
  float4 position [[position]];
};

constant float PI = 3.14159265;
constant float TAU = 6.28318531;
// How much rose and saffron the dawn carries (0…1).
constant float WARMTH = 0.6;

// GLSL-style floored mod: arm indices run negative, where fmod would truncate.
static float gmod(float x, float y) { return x - y * floor(x / y); }
static float3 srgb(float r, float g, float b) { return pow(float3(r, g, b) / 255.0, float3(2.2)); }

static float hash12(float2 p) {
  float3 p3 = fract(float3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

static float3 hash32(float2 p) {
  float3 p3 = fract(float3(p.xyx) * float3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

static float vnoise(float2 p) {
  float2 i = floor(p), f = fract(p);
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + float2(1.0, 0.0)), u.x),
             mix(hash12(i + float2(0.0, 1.0)), hash12(i + float2(1.0, 1.0)), u.x), u.y);
}

static float fbm(float2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + float2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}

static float easeOutExpo(float x) { return x >= 1.0 ? 1.0 : 1.0 - pow(2.0, -10.0 * x); }
static float easeOutBack(float x) { float u = x - 1.0; return 1.0 + 2.4 * u * u * u + 1.4 * u * u; }
static float easeInOut(float x) { float v = -2.0 * x + 2.0; return x < 0.5 ? 4.0 * x * x * x : 1.0 - v * v * v / 2.0; }
static float3 softKnee(float3 c) { float3 o = max(c - 0.8, 0.0); return min(c, float3(0.8)) + (1.0 - exp(-o / 0.2)) * 0.2; }

static float3 starLayer(float2 px, float cell, float density, float seed, float t, float it, float scale) {
  float2 g = px / cell;
  float2 id = floor(g);
  float2 f = fract(g) - 0.5;
  float3 r = hash32(id + seed);
  if (r.x > density) return float3(0.0);
  float3 r2 = hash32(id + seed + 71.3);
  float2 pos = (r2.xy - 0.5) * 0.6;
  float d = length(f - pos) * cell;
  float size = mix(0.35, 1.1, r.y * r.y) * max(scale, 0.5);
  float tw = 0.62 + 0.38 * sin(t * (0.5 + 1.8 * r.z) + r2.z * TAU);
  float on = smoothstep(2.8 + 2.2 * r2.x, 3.5 + 2.2 * r2.x, it);
  float core = 1.0 - smoothstep(size - 0.4, size + 0.8, d);
  float halo = exp(-d / (size * 2.5 + 0.5)) * 0.18;
  float b = (0.25 + 0.75 * r.y * r.y) * tw * on;
  float3 c = mix(srgb(186.0, 208.0, 246.0), srgb(255.0, 236.0, 214.0), step(0.82, r2.y));
  return c * (core + halo) * b;
}

vertex VertexOut firstLightVertex(uint vid [[vertex_id]]) {
  float2 p = float2(float((vid << 1) & 2), float(vid & 2));
  VertexOut out;
  out.position = float4(p * 2.0 - 1.0, 0.0, 1.0);
  return out;
}

fragment float4 firstLightFragment(VertexOut in [[stage_in]], constant Uniforms& u [[buffer(0)]]) {
  float2 frag = float2(in.position.x, u.res.y - in.position.y);
  float2 px = frag - u.drift;
  float W = u.res.x, H = u.res.y, S = min(W, H);
  float t = u.time, it = u.intro, scale = u.scale, warmth = WARMTH;

  float horizonY = H * 0.37;
  float2 C = float2(W * 0.5, H * 0.60);
  float Ru = 0.062;

  // Ignition: a point of light, eight arms, the horizon, the glow, the sea.
  float eSky = smoothstep(0.2, 2.8, it);
  float eCore = easeOutExpo(clamp((it - 0.5) / 1.0, 0.0, 1.0));
  float eLine = easeInOut(clamp((it - 1.7) / 1.6, 0.0, 1.0));
  float eGlow = smoothstep(2.0, 4.4, it);
  float eRefl = clamp((it - 2.6) / 1.8, 0.0, 1.0);

  float breath = 0.5 + 0.5 * sin(t * TAU / 7.0);
  float tide = 0.5 + 0.5 * sin(t * TAU / 64.0 - 1.2);

  float3 cZenith = srgb(3.0, 5.0, 10.0);
  float3 cMid = srgb(7.0, 13.0, 26.0);
  float3 cLow = srgb(17.0, 33.0, 60.0);
  float3 cBlue = srgb(110.0, 164.0, 232.0);
  float3 cRose = srgb(224.0, 132.0, 118.0);
  float3 cSaff = srgb(242.0, 180.0, 100.0);
  float3 cFirst = srgb(255.0, 238.0, 214.0);
  float3 cSeaNear = srgb(10.0, 17.0, 30.0);
  float3 cSeaDeep = srgb(3.0, 5.0, 9.0);
  float3 cNavy = srgb(26.0, 46.0, 74.0);

  float dxN = (px.x - C.x) / W;
  float wide = exp(-dxN * dxN / (2.0 * 0.30 * 0.30));
  float warmH = exp(-dxN * dxN / (2.0 * 0.13 * 0.13));
  float dh = px.y - horizonY;
  float3 col = float3(0.0);

  if (dh >= 0.0) {
    // Sky: night to blue hour, dawn gathered at the seam.
    float h = dh / (H - horizonY);
    float dy = dh / H;
    float3 base = mix(cLow, cMid, smoothstep(0.0, 0.42, h));
    base = mix(base, cZenith, smoothstep(0.30, 1.0, h));
    float glowV = exp(-dy / 0.14);
    float warmV = exp(-dy / 0.032);
    float3 warm = mix(cRose, cSaff, warmV * warmV);
    col += base * eSky;
    col += cBlue * glowV * (0.3 + 0.7 * wide) * (0.09 + 0.05 * tide) * (1.0 - 0.7 * warmV * warmH * warmth) * eGlow;
    col += warm * warmV * warmH * warmth * (0.42 + 0.16 * tide) * eGlow;

    // Rosy fingers: thin streaks of cloud lit from below.
    float cloud = 0.0;
    float band = smoothstep(0.012, 0.05, dy) * (1.0 - smoothstep(0.14, 0.32, dy));
    if (band > 0.0) {
      float2 q = float2(px.x / H, dy);
      float n1 = fbm(float2(q.x * 2.2 + t * 0.006, q.y * 26.0));
      float n2 = fbm(float2(q.x * 3.4 - t * 0.004 + 5.3, q.y * 40.0 + 2.1));
      cloud = (smoothstep(0.52, 0.74, n1) * 0.75 + smoothstep(0.55, 0.76, n2) * 0.5) * band;
    }
    float3 lit = mix(srgb(46.0, 58.0, 96.0), mix(cRose, cSaff, 0.3), warmH * warmth * exp(-dy / 0.08));
    col += lit * cloud * (0.08 + 0.14 * warmH) * eGlow;

    // Stars, hidden by the streaks and faded near the glow; now and then a meteor.
    float mask = smoothstep(0.05, 0.40, h) * (1.0 - clamp(cloud * 2.0, 0.0, 1.0)) * eSky;
    float2 sp = px + float2(t * 0.8 * scale, 0.0);
    float3 st = starLayer(sp, 34.0 * scale, 0.16, 0.0, t, it, scale) * 0.55
              + starLayer(sp + 400.0, 96.0 * scale, 0.22, 19.0, t, it, scale);
    col += st * mask;
    if (u.meteor.w >= 0.0) {
      float age = u.meteor.w;
      float2 dir = float2(cos(u.meteor.z), sin(u.meteor.z));
      float2 head = float2(u.meteor.x * W, u.meteor.y * H) + dir * (0.45 * S) * age;
      float2 tail = head - dir * (0.14 * S * smoothstep(0.0, 0.3, age));
      float2 pa = px - tail, ba = head - tail;
      float hh = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-3), 0.0, 1.0);
      float dd = length(pa - ba * hh);
      float env = smoothstep(0.0, 0.10, age) * (1.0 - smoothstep(0.5, 1.0, age));
      float w = 0.6 * max(scale, 0.6);
      float m = exp(-dd * dd / (2.0 * w * w)) * hh * hh + exp(-length(px - head) / (2.0 * max(scale, 0.6))) * 0.35;
      col += srgb(205.0, 225.0, 255.0) * m * env * 0.9;
    }
  } else {
    // Sea: iso-depth swell lines, lit by the reflected dawn.
    float d = -dh;
    float dn = d / H;
    float dPt = d / scale;
    col += mix(cSeaNear, cSeaDeep, smoothstep(0.0, 0.22, dn)) * eSky;
    col += cBlue * exp(-dn / 0.045) * (0.35 + 0.65 * wide) * 0.05 * eGlow;
    col += mix(cRose, cSaff, 0.4) * exp(-dn / 0.018) * warmH * warmth * 0.07 * eGlow;

    float X = (px.x - C.x) / scale / (dPt + 8.0);
    float phase = 16.0 * log(dPt + 4.0);
    phase += 0.20 * sin(X * 5.0 + t * 0.9) + 0.12 * sin(X * 11.0 - t * 1.3 + phase * 0.35);
    float fw = max(fwidth(phase), 1e-4);
    float lineDist = abs(fract(phase) - 0.5) / fw;
    float spacing = 1.0 / fw;
    float idx = floor(phase);

    float line = clamp(0.5 * scale + 0.5 - lineDist, 0.0, 1.0);
    float lineFade = smoothstep(2.5 * scale, 8.0 * scale, spacing);
    float seg = smoothstep(0.32, 0.58, vnoise(float2(X * 7.0 + idx * 13.7 + t * 0.12, idx * 3.1)));
    float3 lc = cNavy * (0.22 + 0.42 * wide)
              + cBlue * exp(-dn / 0.08) * (0.3 + 0.7 * wide) * 0.22 * eGlow
              + mix(cRose, cSaff, 0.4) * warmH * exp(-dn / 0.03) * warmth * 0.25 * eGlow;
    col += lc * line * lineFade * seg * eSky;

    // The star's reflection: a widening path of flickering glints.
    float reveal = clamp((eRefl * 0.42 - dn) / 0.05, 0.0, 1.0);
    float halfW = 0.010 * W + d * 0.22;
    float cx = (px.x - C.x) / halfW;
    float colX = exp(-cx * cx);
    float colY = mix(1.0, 0.45, smoothstep(0.0, 0.33, dn));
    float cellW = (3.0 + dPt * 0.05) * scale;
    float cxw = (px.x - C.x) / cellW;
    float3 g = hash32(float2(floor(cxw), idx) + 3.7);
    float fx = fract(cxw);
    float taper = smoothstep(0.0, 0.3, fx) * (1.0 - smoothstep(0.7, 1.0, fx));
    float fl = 0.5 + 0.5 * sin(t * (2.0 + 5.0 * g.x) + g.y * TAU);
    float glint = step(0.35, g.z) * fl * fl * fl * taper;
    float gl = clamp(0.5 * scale + 1.0 - lineDist, 0.0, 1.0);
    float gFade = smoothstep(1.5 * scale, 5.0 * scale, spacing);
    float3 gc = mix(cBlue, cFirst, colX * (1.0 - smoothstep(0.0, 0.3, dn)));
    float amt = colX * colY * reveal * eCore;
    col += gc * glint * gl * gFade * amt * 1.5;
    float sh = vnoise(float2((px.x - C.x) / (4.5 * scale), dPt * 1.3 - t * 2.2));
    col += gc * smoothstep(0.6, 0.92, sh) * (1.0 - gFade) * amt * 1.1;
    col += cBlue * amt * 0.05 * (0.8 + 0.2 * breath);
  }

  // Horizon: a one-point seam of first light, drawn outward from under the star.
  {
    float adh = abs(dh);
    float hx = abs(dxN);
    float reach = eLine * 0.62;
    float extent = clamp((reach - hx) / max(reach * 0.45, 1e-3), 0.0, 1.0);
    float I = 0.22 + 0.78 * exp(-hx * hx / (2.0 * 0.12 * 0.12));
    float3 lc = mix(cBlue, cRose, exp(-hx * hx / (2.0 * 0.22 * 0.22)) * warmth);
    lc = mix(lc, cSaff, exp(-hx * hx / (2.0 * 0.10 * 0.10)) * warmth);
    lc = mix(lc, cFirst, exp(-hx * hx / (2.0 * 0.035 * 0.035)));
    float core = exp(-adh / (0.8 * max(scale, 0.6)));
    float bloom = exp(-adh / (6.0 * scale)) * 0.22 + exp(-adh / (36.0 * scale)) * 0.05;
    col += lc * (core * 0.85 + bloom) * I * extent * (0.85 + 0.15 * tide);
  }

  // The Eos star: eight capsule arms (folded into one sector), core, halo, spikes.
  {
    float2 q = (px - C) / S;
    float r = length(q);
    float ang = atan2(q.y, q.x);
    float sec = PI / 4.0;
    float k = floor((ang + sec * 0.5) / sec);
    float rr = Ru * 0.11;
    float dArm = 1e5;
    float gArm = 0.0;
    float gSelf = 0.0;
    for (int j = -1; j <= 1; j++) {
      float kk = k + float(j);
      float a = ang - kk * sec;
      float2 f = r * float2(cos(a), sin(a));
      float ord = gmod(10.0 - gmod(kk + 8.0, 8.0), 8.0);  // clockwise from twelve
      float g = easeOutBack(clamp((it - 1.0 - ord * 0.07) / 0.85, 0.0, 1.0));
      float L = (Ru - rr) * g * (1.0 + 0.024 * (breath - 0.5));
      float dd = length(f - float2(clamp(f.x, 0.0, L), 0.0)) - rr * mix(0.5, 1.0, clamp(g, 0.0, 1.0));
      if (dd < dArm) { dArm = dd; gArm = clamp(g, 0.0, 1.0); }
      if (j == 0) gSelf = clamp(g, 0.0, 1.0);
    }
    float dPx = dArm * S;
    float fill = clamp(0.5 - dPx, 0.0, 1.0) * eCore;
    float tt = r / Ru;
    float3 armCol = mix(srgb(240.0, 246.0, 255.0), srgb(140.0, 186.0, 242.0), smoothstep(0.10, 0.70, tt));
    armCol = mix(armCol, srgb(100.0, 154.0, 228.0), smoothstep(0.70, 1.05, tt));
    float bright = 0.93 + 0.07 * breath;
    float flare = exp(-(it - 1.25) * (it - 1.25) / 0.06) * 0.6;
    float halo = exp(-max(dPx, 0.0) / (Ru * S * 0.20)) * 0.28 * gArm;
    float core = exp(-r / (Ru * 0.30 * mix(0.25, 1.0, eCore))) * 0.85 * eCore;
    float bloom = exp(-r / (Ru * 1.3)) * (0.20 + flare) * eCore;
    float aura = exp(-r / (Ru * 5.0)) * 0.05 * eCore;
    float a0 = ang - k * sec;
    float2 f0 = r * float2(cos(a0), sin(a0));
    float along = f0.x / Ru;
    float across = abs(f0.y) * S;
    float slen = 0.75 + 0.25 * sin(t * 0.9 + gmod(k + 8.0, 8.0) * 1.7);
    float sw = (0.6 + along * 0.2) * max(scale, 0.6);
    float spike = exp(-across * across / (2.0 * sw * sw)) * smoothstep(0.7, 1.15, along) * exp(-(along - 1.0) / slen);
    spike *= 0.13 * gSelf;
    float3 glow = cBlue * (halo + bloom + aura) + srgb(225.0, 238.0, 255.0) * core + mix(cBlue, cFirst, 0.35) * spike;
    col = mix(col, armCol * 1.05, fill);
    col += glow * bright;
  }

  float2 vq = frag / u.res - 0.5;
  col *= 1.0 - 0.38 * smoothstep(0.25, 0.85, length(vq * float2(1.0, 0.85)));
  float3 c = pow(softKnee(max(col, 0.0)), float3(1.0 / 2.2));
  c += (hash12(frag + fract(t * 7.13) * 97.0) - 0.5) * (1.5 / 255.0);
  return float4(c, 1.0);
}
