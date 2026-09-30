import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FROSTED_GLASS, GAIN_MAX, SHADOW_PAD, glassMaps } from "../../lib/liquidGlass.js";

// A liquid-glass surface (the composer card + pill): ybouane/liquidglass, see
// lib/liquidGlass.js. Render it as the FIRST child of a positioned
// `isolation: isolate` host — the layers sit under the host's content (styles
// in glass.css). The host itself never
// gets a backdrop-filter, so glass popovers inside it still see through. No
// ancestor may be a backdrop root (opacity < 1, filter, mask, clip-path) —
// the glass would see nothing behind it.
//
// The backdrop runs through an SVG filter built from maps sized to the host,
// with the drop shadow as an image beside it. Both layers reach SHADOW_PAD past
// the host: the refraction samples that ring too, and the filter's own mask
// cuts the glass to the host's shape. Chromium only — elsewhere the surface
// stays clear. `preset` is one of lib/liquidGlass.js's configs.
export function GlassLayers({ preset = FROSTED_GLASS }) {
  const hostRef = useRef(null);
  const layerRef = useCallback((node) => { hostRef.current = node?.parentElement ?? null; }, []);
  const id = "lg-glass-" + useId().replace(/[^\w-]/g, "");
  const glass = useGlassMaps(hostRef, preset);

  return (
    <>
      <span ref={layerRef} className="lg-backdrop" style={glass ? { backdropFilter: `url(#${id})` } : undefined} aria-hidden="true" />
      {glass && <img className="lg-shadow" src={glass.shadow} alt="" aria-hidden="true" />}
      {glass && <GlassFilter id={id} glass={glass} />}
    </>
  );
}

// The backdrop is refracted twice — sharp and blurred — each colour channel
// displaced by its own map (red and blue split along the edge normal) and
// recombined. Then, as in the reference: col = mix(sharp, blurred, blur mix)
// (here also mixed with the preset's solid fill), fin = col · gain + light,
// faded out over the edge by the mask (straight rgb = mask, alpha = mask²).
const CHANNELS = [
  ["r", "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"],
  ["g", "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"],
  ["b", "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"],
];

function GlassFilter({ id, glass }) {
  const { w, h, scale, blur, fill, disp, shade } = glass;
  const image = (href, result) => (
    <feImage key={result} href={href} x="0" y="0" width={w + SHADOW_PAD * 2} height={h + SHADOW_PAD * 2}
      preserveAspectRatio="none" result={result} />
  );
  const matrix = (input, values, result) => (
    <feColorMatrix key={result} in={input} type="matrix" values={values} result={result} />
  );
  const product = (a, b, result) => (
    <feComposite key={result} in={a} in2={b} operator="arithmetic" k1="1" result={result} />
  );
  const sum = (a, b, result) => (
    <feComposite key={result} in={a} in2={b} operator="arithmetic" k2="1" k3="1" result={result} />
  );
  const refract = (input, out) => [
    ...CHANNELS.flatMap(([c, values]) => [
      <feDisplacementMap key={out + c + "d"} in={input} in2={c + "m"} scale={scale}
        xChannelSelector="R" yChannelSelector="G" result={out + c + "d"} />,
      matrix(out + c + "d", values, out + c),
    ]),
    sum(out + "r", out + "g", out + "rg"),
    sum(out + "rg", out + "b", out),
  ];
  return (
    <svg className="lg-filter-svg" width="0" height="0" aria-hidden="true">
      <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        {CHANNELS.map(([c], i) => image(disp[i], c + "m"))}
        {image(shade, "shade")}
        <feGaussianBlur in="SourceGraphic" stdDeviation={blur} edgeMode="duplicate" result="blurred" />
        {refract("SourceGraphic", "sharp")}
        {refract("blurred", "frost")}
        {matrix("rm", "0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 0 1", "frostW")}
        {matrix("rm", "0 0 0 -1 1  0 0 0 -1 1  0 0 0 -1 1  0 0 0 0 1", "sharpW")}
        {product("frost", "frostW", "frostPart")}
        {product("sharp", "sharpW", "sharpPart")}
        {sum("frostPart", "sharpPart", "seen")}
        <feFlood className="lg-fill" result="fill" />
        <feComposite in="seen" in2="fill" operator="arithmetic" k2={1 - fill} k3={fill} result="col" />
        {matrix("shade", "1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1", "gain")}
        {matrix("shade", "0 0 0 -1 1  0 0 0 -1 1  0 0 0 -1 1  0 0 0 0 1", "light")}
        <feComposite in="col" in2="gain" operator="arithmetic" k1={GAIN_MAX} result="lit" />
        {sum("lit", "light", "fin")}
        {matrix("gm", "0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 1 0", "mask2")}
        <feComponentTransfer in="mask2" result="mask">
          <feFuncR type="gamma" exponent="0.5" />
          <feFuncG type="gamma" exponent="0.5" />
          <feFuncB type="gamma" exponent="0.5" />
        </feComponentTransfer>
        <feComposite in="fin" in2="mask" operator="arithmetic" k1="1" />
      </filter>
    </svg>
  );
}

// The maps are built before paint — on mount and on every resize — so a
// surface never shows a frame without glass, or with maps for its old size.
function useGlassMaps(hostRef, preset) {
  const [glass, setGlass] = useState(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const build = () => {
      const w = host.offsetWidth, h = host.offsetHeight, dpr = window.devicePixelRatio || 1;
      if (w < 2 || h < 2) return;
      const radius = parseFloat(getComputedStyle(host).borderTopLeftRadius) || 0;
      setGlass(cachedGlass(preset, w, h, dpr, radius));
    };
    const ro = new ResizeObserver(() => flushSync(build));
    ro.observe(host);
    build();
    return () => ro.disconnect();
  }, [hostRef, preset]);
  return glass;
}

// Building takes tens of ms, so the last few sizes per preset are kept: a menu
// reopens, or steps between its few heights, without rebuilding.
const CACHED_SIZES = 16;
const cache = new WeakMap();

function cachedGlass(preset, w, h, dpr, radius) {
  let sizes = cache.get(preset);
  if (!sizes) cache.set(preset, (sizes = new Map()));
  const key = `${w}x${h}@${dpr}r${radius}`;
  let glass = sizes.get(key);
  if (glass) {
    sizes.delete(key);
  } else {
    const g = glassMaps(w, h, dpr, radius, preset);
    const url = (data) => pngUrl(data, g.width, g.height);
    glass = { w, h, scale: g.scale, blur: g.blur, fill: preset.fill, disp: g.disp.map(url), shade: url(g.shade), shadow: url(g.shadow) };
    if (sizes.size >= CACHED_SIZES) sizes.delete(sizes.keys().next().value);
  }
  sizes.set(key, glass);
  return glass;
}

let scratch = null;
function pngUrl(data, w, h) {
  scratch ??= document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  scratch.getContext("2d").putImageData(new ImageData(data, w, h), 0, 0);
  return scratch.toDataURL();
}
