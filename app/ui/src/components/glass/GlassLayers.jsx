import { useCallback, useEffect, useId, useRef, useState } from "react";
import { lensMap } from "../../lib/lensMap.js";
import { usePointerVar } from "../../hooks/usePointerVar.js";

// The layers of a large liquid-glass surface (the composer card): backdrop,
// tint, rim and the pointer light. Render it as the FIRST child of a
// `position: relative; isolation: isolate` host — the layers sit under the
// host's content (styles in glass.css). The host itself never gets a
// backdrop-filter, so glass popovers inside it still see through.
//
//   lens — { radius, bevel, scale }: edge refraction. An SVG displacement map
//          sized to the host, rebuilt on resize; the backdrop only references
//          it once it exists. Chromium only — WebKit keeps the plain blur.
//
// The light follows the cursor through --mx (px) on the host.
export function GlassLayers({ lens = null }) {
  const hostRef = useRef(null);
  const layerRef = useCallback((node) => { hostRef.current = node?.parentElement ?? null; }, []);
  const id = "lg-lens-" + useId().replace(/[^\w-]/g, "");
  const map = useLensMap(hostRef, lens?.radius, lens?.bevel);
  usePointerVar(hostRef, "--mx", "x");

  const refract = map && lens.scale > 0;
  const backdrop = refract
    ? { backdropFilter: `url(#${id}) blur(var(--lg-blur)) saturate(var(--lg-sat)) brightness(1.04)` }
    : undefined;

  return (
    <>
      <span ref={layerRef} className="lg-backdrop" style={backdrop} aria-hidden="true" />
      <span className="lg-tint" aria-hidden="true" />
      <span className="lg-rim" aria-hidden="true" />
      <span className="lg-sheen" aria-hidden="true" />
      <span className="lg-edge-light" aria-hidden="true" />
      {refract && <LensFilter id={id} map={map} scale={lens.scale} />}
    </>
  );
}

// R/G/B displaced at scale × 1 / 0.9 / 0.8 and recombined: a slight chromatic
// aberration along the rim.
const CHANNELS = [
  ["r", 1, "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"],
  ["g", 0.9, "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"],
  ["b", 0.8, "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"],
];

function LensFilter({ id, map, scale }) {
  return (
    <svg className="lg-lens-svg" width="0" height="0" aria-hidden="true">
      <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feImage href={map.href} x="0" y="0" width={map.w} height={map.h} preserveAspectRatio="none" result="map" />
        {CHANNELS.map(([c, k, matrix]) => [
          <feDisplacementMap key={c + "d"} in="SourceGraphic" in2="map" scale={scale * k}
            xChannelSelector="R" yChannelSelector="G" result={c + "d"} />,
          <feColorMatrix key={c} in={c + "d"} type="matrix" values={matrix} result={c} />,
        ])}
        <feComposite in="r" in2="g" operator="arithmetic" k2="1" k3="1" result="rg" />
        <feComposite in="rg" in2="b" operator="arithmetic" k2="1" k3="1" />
      </filter>
    </svg>
  );
}

function useLensMap(hostRef, radius, bevel) {
  const [map, setMap] = useState(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || radius == null) return undefined;
    let raf = 0;
    let last = "";
    const build = () => {
      raf = 0;
      const w = Math.round(host.offsetWidth), h = Math.round(host.offsetHeight);
      if (w < 2 || h < 2 || `${w}x${h}` === last) return;
      last = `${w}x${h}`;
      setMap({ href: lensMap(w, h, radius, bevel), w, h });
    };
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(build); });
    ro.observe(host);
    build();
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [hostRef, radius, bevel]);
  return map;
}
