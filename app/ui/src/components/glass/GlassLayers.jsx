import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { GAIN_MAX, regularGlass } from "../../lib/liquidGlass.js";

// A liquid-glass surface (the composer card + pill): ybouane/liquidglass
// "Regular Glass", see lib/liquidGlass.js. Render it as the FIRST child of a
// `position: relative; isolation: isolate` host — the layers sit under the
// host's content (styles in glass.css). The host itself never gets a
// backdrop-filter, so glass popovers inside it still see through.
//
// The backdrop runs through an SVG filter built from maps sized to the host,
// rebuilt on resize; the drop shadow is drawn on a canvas around it. Chromium
// only — elsewhere the surface stays clear.
export function GlassLayers() {
  const hostRef = useRef(null);
  const shadowRef = useRef(null);
  const layerRef = useCallback((node) => {
    shadowRef.current = node;
    hostRef.current = node?.parentElement ?? null;
  }, []);
  const id = "lg-glass-" + useId().replace(/[^\w-]/g, "");
  const glass = useRegularGlass(hostRef);

  useLayoutEffect(() => {
    const canvas = shadowRef.current;
    if (!canvas || !glass) return;
    const { width, height, data } = glass.shadow;
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
  }, [glass]);

  return (
    <>
      <canvas ref={layerRef} className="lg-shadow" aria-hidden="true" />
      <span className="lg-backdrop" style={glass ? { backdropFilter: `url(#${id})` } : undefined} aria-hidden="true" />
      {glass && <GlassFilter id={id} glass={glass} />}
    </>
  );
}

// Each colour channel is displaced by its own map (red and blue split along the
// edge normal), then recombined: fin = col · gain + light.
const CHANNELS = [
  ["r", "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"],
  ["g", "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"],
  ["b", "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"],
];

// feDisplacementMap samples nearest-neighbour where the reference's WebGL
// texture is bilinear, so each channel is sampled at four taps half a map step
// apart (the map shifted by one level in x, y, both) and averaged. A tap never
// crosses a pixel where the map is neutral, so the flat middle stays sharp.
const TAPS = [[0, 0], [1, 0], [0, 1], [1, 1]];
const LEVEL = -1 / 255;

function GlassFilter({ id, glass }) {
  const { w, h, scale, disp, shade } = glass;
  const image = (href, result) => (
    <feImage key={result} href={href} x="0" y="0" width={w} height={h} preserveAspectRatio="none" result={result} />
  );
  const average = (a, b, result) => (
    <feComposite key={result} in={a} in2={b} operator="arithmetic" k2="0.5" k3="0.5" result={result} />
  );
  const channel = ([c, matrix], i) => [
    image(disp[i], c + "m"),
    ...TAPS.map(([x, y], t) => [
      (x || y) ? (
        <feComponentTransfer key={c + "m" + t} in={c + "m"} result={c + "m" + t}>
          <feFuncR type="linear" slope="1" intercept={x * LEVEL} />
          <feFuncG type="linear" slope="1" intercept={y * LEVEL} />
        </feComponentTransfer>
      ) : null,
      <feDisplacementMap key={c + "d" + t} in="SourceGraphic" in2={(x || y) ? c + "m" + t : c + "m"} scale={scale}
        xChannelSelector="R" yChannelSelector="G" result={c + "d" + t} />,
    ]),
    average(c + "d0", c + "d1", c + "a"),
    average(c + "d2", c + "d3", c + "b"),
    average(c + "a", c + "b", c + "d"),
    <feColorMatrix key={c} in={c + "d"} type="matrix" values={matrix} result={c} />,
  ];
  return (
    <svg className="lg-filter-svg" width="0" height="0" aria-hidden="true">
      <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        {CHANNELS.map(channel)}
        <feComposite in="r" in2="g" operator="arithmetic" k2="1" k3="1" result="rg" />
        <feComposite in="rg" in2="b" operator="arithmetic" k2="1" k3="1" result="col" />
        {image(shade, "shade")}
        <feColorMatrix in="shade" type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1" result="gain" />
        <feColorMatrix in="shade" type="matrix" values="0 0 0 -1 1  0 0 0 -1 1  0 0 0 -1 1  0 0 0 0 1" result="light" />
        <feComposite in="col" in2="gain" operator="arithmetic" k1={GAIN_MAX} result="lit" />
        <feComposite in="lit" in2="light" operator="arithmetic" k2="1" k3="1" />
      </filter>
    </svg>
  );
}

function useRegularGlass(hostRef) {
  const [glass, setGlass] = useState(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let raf = 0;
    let last = "";
    const build = () => {
      raf = 0;
      const w = host.offsetWidth, h = host.offsetHeight, dpr = window.devicePixelRatio || 1;
      if (w < 2 || h < 2 || `${w}x${h}@${dpr}` === last) return;
      last = `${w}x${h}@${dpr}`;
      const radius = parseFloat(getComputedStyle(host).borderTopLeftRadius) || 0;
      const g = regularGlass(w, h, dpr, radius);
      const url = (data) => pngUrl(data, g.width, g.height);
      setGlass({ w, h, scale: g.scale, disp: g.disp.map(url), shade: url(g.shade), shadow: g.shadow });
    };
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(build); });
    ro.observe(host);
    build();
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [hostRef]);
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
