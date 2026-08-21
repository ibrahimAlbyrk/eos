import { useLayoutEffect, useRef, useState } from "react";

// DeviceFrame — device-emulation presentation for the browser panel (plan §4
// Phase 8). Responsive fills the panel exactly as the bare canvas did; Mobile
// and Tablet emulate a viewport narrower than the panel, so the frame centres
// the emulated page with grey letterbox gutters, scaled to fit the panel while
// preserving the device aspect ratio.
//
// Coordinate correctness: the canvas AND both overlay leaves (annotate/pick) are
// this frame's children, so their `width:100%` (+ viewport aspect-ratio) resolve
// against the SAME emulated box, not the wider panel. canvasToPage (paintFrame)
// measures each element's own on-screen box, so a click/hover still maps to the
// emulated viewport — no silent misplacement of clicks or highlights under
// emulation.

// Emulated CSS-px viewports (contracts/src/browser.ts §3.1). Responsive has no
// fixed size — it tracks the panel — so it is absent here and the frame is a
// pass-through for it.
export const DEVICE_DIMS = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
};

// Largest box with the device aspect ratio that fits inside the container — the
// letterbox rectangle in on-screen CSS px. Null until the container is measured,
// so the box never flashes at the wrong size on first paint.
export function letterboxSize(container, dims) {
  if (!container?.width || !container?.height) return null;
  const scale = Math.min(container.width / dims.width, container.height / dims.height);
  return { width: dims.width * scale, height: dims.height * scale };
}

export function DeviceFrame({ device, busy, children }) {
  const ref = useRef(null);
  const [box, setBox] = useState(null);

  // Measure the gutter area and size the emulated box to fit it. Re-measures on
  // panel resize; cleared for Responsive (which has no fixed box).
  useLayoutEffect(() => {
    const dims = DEVICE_DIMS[device];
    if (!dims) { setBox(null); return; }
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox(letterboxSize({ width: el.clientWidth, height: el.clientHeight }, dims));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [device]);

  const loading = busy ? <div className="device-loading">Loading…</div> : null;

  if (!DEVICE_DIMS[device]) {
    return <div className="device-frame">{children}{loading}</div>;
  }

  return (
    <div ref={ref} className="device-frame is-emulated">
      <div
        className="device-viewport"
        style={box ? { width: box.width, height: box.height } : { visibility: "hidden" }}
      >
        {children}
      </div>
      {loading}
    </div>
  );
}
