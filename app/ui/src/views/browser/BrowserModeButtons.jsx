import { useEffect, useRef, useState } from "react";
import { toggleMode, setDevice } from "../../state/browserPanelStore.js";
import { BrowserDeviceMenu } from "./BrowserDeviceMenu.jsx";

// Top-right panel controls: pencil (annotate), cursor (pick element) and phone
// (device emulation), in the PanelShell header's actions slot beside the shared
// fullscreen/close pair. Pencil and cursor are ONE store enum, so lighting one
// always clears the other; the phone is separate state and opens the device menu.
//
// The browser page renders in a native WebContentsView floating above this DOM,
// so the device dropdown would be occluded by it — opening the menu hides the
// view (overlayOpen) for the menu's lifetime so the dropdown draws on top.
export function BrowserModeButtons({ paneId, mode, device }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  // Hide the native view while the dropdown is open so it isn't occluded; restore
  // on close (and on unmount, so a menu left open never wedges the view hidden).
  useEffect(() => {
    window.eosBrowserView?.overlayOpen(menuOpen);
    return () => window.eosBrowserView?.overlayOpen(false);
  }, [menuOpen]);

  return (
    <div className="browser-modes" ref={ref}>
      <button
        className={"fv-icon-btn" + (mode === "annotate" ? " on" : "")}
        title="Annotate"
        aria-label="Annotate"
        aria-pressed={mode === "annotate"}
        onClick={() => toggleMode(paneId, "annotate")}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11.4 2.6a1.6 1.6 0 0 1 2.3 2.3L6 12.5 2.8 13.5l1-3.2 7.6-7.7z" />
        </svg>
      </button>
      <button
        className={"fv-icon-btn" + (mode === "pick" ? " on" : "")}
        title="Select element"
        aria-label="Select element"
        aria-pressed={mode === "pick"}
        onClick={() => toggleMode(paneId, "pick")}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
          <path d="M3 2.2 12.4 7.6l-4 .9-1.8 3.8L3 2.2z" />
        </svg>
      </button>
      <button
        className={"fv-icon-btn" + (menuOpen || device !== "responsive" ? " on" : "")}
        title="Device"
        aria-label="Device"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
          <rect x="4.5" y="1.5" width="7" height="13" rx="1.6" /><path d="M7 12.6h2" />
        </svg>
      </button>
      {menuOpen && (
        <BrowserDeviceMenu
          device={device}
          onPick={(d) => { setDevice(paneId, d); setMenuOpen(false); }}
        />
      )}
    </div>
  );
}
