// deviceViewport — the device-menu emulated viewports (CSS px) and the centering
// math for the embedded view. The page renders in a native WebContentsView, so
// the "device frame" is not a DOM box (the old canvas-era DeviceFrame) but the
// native view itself, sized to the device rect and centered in the panel by the
// main process (app/src/main/browser/views.ts ViewManager.viewRectFor, which
// mirrors these dims + this formula). Kept here as the renderer-side source of
// truth so the centering stays unit-testable without Electron.

export const DEVICE_DIMS = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
};

// The on-screen rect for a device-emulated view: the device box centered inside
// the panel rect and clamped to it, so a device larger than the panel is bounded
// rather than overflowing into adjacent UI. Responsive (no dims) fills the panel.
export function centerDeviceRect(device, panel) {
  if (!panel) return null;
  const origin = { x: panel.x ?? 0, y: panel.y ?? 0 };
  const dims = DEVICE_DIMS[device];
  if (!dims) return { ...origin, width: panel.width, height: panel.height };
  const width = Math.min(dims.width, panel.width);
  const height = Math.min(dims.height, panel.height);
  return {
    x: origin.x + Math.round((panel.width - width) / 2),
    y: origin.y + Math.round((panel.height - height) / 2),
    width,
    height,
  };
}
