import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { notify } from "../../lib/notify.js";
import { browserFetch, toggleMode } from "../../state/browserPanelStore.js";
import { pushHandoff } from "../../state/browserComposerHandoff.js";
import { makeLabel } from "../../lib/attachmentTokens.js";
import { canvasToPage } from "./paintFrame.js";
import { ElementPopover } from "./ElementPopover.jsx";

// PickerLayer — the cursor-mode overlay (plan §4 Phase 7). Unlike the annotation
// overlay it does NOT freeze the frame: the live page keeps streaming underneath
// while a transparent surface (pinned over the canvas box) captures the pointer,
// highlights the element under the cursor and shows an ElementPopover. A click
// attaches THAT element to this pane's composer as a compact chip — no HTML, no
// screenshot, just the ~40-80 token BrowserElement.
//
// The surface shares the canvas geometry (top-pinned, full width, same aspect),
// so pointer offsets translate to viewport px with the SAME canvasToPage the
// live canvas uses for input, and the highlight scales back as a percentage box.

// Canvas CSS offset → a `{hover:[x,y]}` probe in viewport CSS px.
export function pickerHoverRequest(offsetX, offsetY, cssW, cssH, viewport) {
  const { x, y } = canvasToPage(offsetX, offsetY, cssW, cssH, viewport);
  return { hover: [x, y] };
}

// BrowserElement.box (viewport CSS px) → a percentage rect over the surface —
// the inverse of canvasToPage, so the highlight lands exactly on the element.
export function boxToPercentRect([x, y, w, h], viewport) {
  const pct = (v, total) => `${(v / total) * 100}%`;
  return {
    left: pct(x, viewport.width),
    top: pct(y, viewport.height),
    width: pct(w, viewport.width),
    height: pct(h, viewport.height),
  };
}

// The compact identity shown as the chip's [label] token. BrowserElement carries
// no class list, so identity is the tag plus its accessible name (or the durable
// locator when unnamed).
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
// payload inline in the path-or-value slot (buildAttachmentSuffix writes it as
// `- [label] (element): <json>`).
export function elementAttachment(el) {
  return { type: "element", label: elementLabel(el), path: JSON.stringify(elementPayload(el)) };
}

export function PickerLayer({ paneId, tabId, viewport }) {
  const surfaceRef = useRef(null);
  const [element, setElement] = useState(null);
  const [cursor, setCursor] = useState(null); // { x, y } surface CSS px
  const inFlightRef = useRef(false);
  const pendingRef = useRef(null); // latest [x,y] viewport px awaiting a probe

  // One in-flight probe at a time; the pointer fires far faster than the daemon
  // should be polled, so coalesce to the LATEST position and fire again only
  // when a newer one landed while the last was outstanding.
  const probe = useCallback(async () => {
    if (inFlightRef.current || !tabId) return;
    const point = pendingRef.current;
    if (!point) return;
    pendingRef.current = null;
    inFlightRef.current = true;
    try {
      const r = await browserFetch(api.routes.browserElements(tabId), {
        method: "POST",
        body: JSON.stringify({ hover: point }),
      });
      if (r.ok && r.body?.ref) setElement(r.body);
      // A failed hover is transient (throttled, superseded by the next move) —
      // stay quiet; the deliberate click path surfaces failures instead.
    } finally {
      inFlightRef.current = false;
      if (pendingRef.current) void probe();
    }
  }, [tabId]);

  const onMove = (e) => {
    if (!viewport) return;
    const rect = surfaceRef.current.getBoundingClientRect();
    const local = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setCursor(local);
    pendingRef.current = pickerHoverRequest(local.x, local.y, rect.width, rect.height, viewport).hover;
    void probe();
  };

  const onLeave = () => {
    pendingRef.current = null;
    setElement(null);
    setCursor(null);
  };

  // Click attaches the highlighted element; if none is resolved yet (clicked
  // before a hover landed) mint one from the click point via `{at:[x,y]}`.
  const attach = async (e) => {
    e.preventDefault();
    let el = element;
    if (!el && viewport && tabId) {
      const rect = surfaceRef.current.getBoundingClientRect();
      const { x, y } = canvasToPage(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, viewport);
      const r = await browserFetch(api.routes.browserElements(tabId), {
        method: "POST",
        body: JSON.stringify({ at: [x, y] }),
      });
      if (!r.ok || !r.body?.ref) {
        notify.error(`Element pick failed: ${r.body?.error ?? r.status}`);
        return;
      }
      el = r.body;
    }
    if (!el) return;
    pushHandoff(paneId, [elementAttachment(el)]);
    toggleMode(paneId, "pick"); // one-shot: attaching returns to plain view
  };

  // Escape leaves pick mode, matching the annotation overlay's Close.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); toggleMode(paneId, "pick"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paneId]);

  const highlight = element && viewport ? boxToPercentRect(element.box, viewport) : null;
  const bounds = surfaceRef.current
    ? { width: surfaceRef.current.clientWidth, height: surfaceRef.current.clientHeight }
    : null;

  return (
    <div
      ref={surfaceRef}
      className="picker-surface"
      style={{ aspectRatio: viewport ? `${viewport.width} / ${viewport.height}` : undefined }}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onClick={attach}
      onContextMenu={(e) => e.preventDefault()}
    >
      {highlight && <div className="picker-highlight" style={highlight} />}
      {element && cursor && <ElementPopover element={element} x={cursor.x} y={cursor.y} bounds={bounds} />}
    </div>
  );
}
