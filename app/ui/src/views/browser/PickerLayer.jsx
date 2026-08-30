import { useEffect, useRef, useState } from "react";
import { notify } from "../../lib/notify.js";
import { toggleMode } from "../../state/browserPanelStore.js";
import { pushHandoff } from "../../state/browserComposerHandoff.js";
import { makeLabel } from "../../lib/attachmentTokens.js";
import { ElementPopover } from "./ElementPopover.jsx";

// PickerLayer — the cursor-mode overlay, reimplemented for the embedded
// WebContentsView. The human's mouse is over the NATIVE view, not this DOM, so
// there is no canvas surface to capture pointer events on. Instead the main
// process drives Chromium's own inspect overlay over the live page (CDP
// Overlay.setInspectMode via the tab's debugger): hovering highlights elements ON
// the real page (native highlight), and a click resolves the chosen element —
// the click is consumed by the overlay, never delivered to the page.
//
// On pick, the element's compact identity is attached to this pane's composer as
// a ~40-80 token chip (never outerHTML, box, or a screenshot) and shown in an
// ElementPopover result card. The @eN ref is minted in the same per-tab ref space
// the agent resolves against, so the agent can act on the picked element.

// The compact identity shown as the chip's [label] token.
export function elementLabel(el) {
  const detail = el.name || el.locator || el.role || "";
  return makeLabel(detail ? `${el.tag} · ${detail}` : el.tag);
}

// The payload that reaches the agent: only the durable identity fields. NEVER
// outerHTML, box, or a screenshot — that is the whole point of the picker.
export function elementPayload(el) {
  return { ref: el.ref, tag: el.tag, role: el.role, name: el.name, locator: el.locator };
}

// One hand-off attachment: kind "element", the identity label, and the compact
// payload inline in the path-or-value slot.
export function elementAttachment(el) {
  return { type: "element", label: elementLabel(el), path: JSON.stringify(elementPayload(el)) };
}

export function PickerLayer({ paneId, tabId }) {
  const rootRef = useRef(null);
  const [result, setResult] = useState(null); // the picked element, once resolved

  // Start Chromium's inspect mode on the live view; resolve when the human clicks
  // (element) or cancels (null). On unmount, abandon any in-flight pick.
  useEffect(() => {
    const view = window.eosBrowserView;
    if (!view || !tabId || typeof view.pickElement !== "function") { toggleMode(paneId, "pick"); return; }
    let cancelled = false;
    notify.info("Click an element on the page to attach it to chat · Esc to cancel");
    view.pickElement(tabId).then((el) => {
      if (cancelled) return;
      if (!el) { toggleMode(paneId, "pick"); return; }
      // Hide the native view so the result card (DOM) isn't occluded by it, then
      // attach the element to the composer.
      view.overlayOpen(true);
      pushHandoff(paneId, [elementAttachment(el)]);
      setResult(el);
    }).catch(() => { if (!cancelled) toggleMode(paneId, "pick"); });
    return () => {
      cancelled = true;
      view.cancelPick?.();
      view.overlayOpen(false);
    };
  }, [paneId, tabId]);

  // Escape cancels the pick / dismisses the result; a click on the result backdrop
  // dismisses it. Both return to plain view.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        window.eosBrowserView?.cancelPick?.();
        toggleMode(paneId, "pick");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paneId]);

  // Centre the result card in the layer (ElementPopover positions by inline
  // left/top from these coords; ~220x150 card).
  const layer = rootRef.current;
  const cx = layer ? Math.max(4, layer.clientWidth / 2 - 110) : 24;
  const cy = layer ? Math.max(4, layer.clientHeight / 2 - 90) : 24;

  // While picking, the native view is on top of this DOM (Chromium renders its own
  // inspect highlight + cursor there), so the layer is empty — the feedback is the
  // native highlight and the info toast. The result card shows only after the pick,
  // once the native view is hidden.
  return (
    <div
      className={"picker-layer" + (result ? " has-result" : "")}
      ref={rootRef}
      onClick={() => { if (result) toggleMode(paneId, "pick"); }}
    >
      {result && (
        <>
          <div className="picker-added" style={{ left: cx, top: cy - 26 }}>Added to chat</div>
          <ElementPopover element={result} x={cx} y={cy} bounds={{ width: layer?.clientWidth ?? 0, height: layer?.clientHeight ?? 0 }} />
        </>
      )}
    </div>
  );
}
