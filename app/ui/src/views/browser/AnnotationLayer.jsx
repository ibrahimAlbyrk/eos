import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { notify } from "../../lib/notify.js";
import { toggleMode, browserFetch } from "../../state/browserPanelStore.js";
import { pushHandoff } from "../../state/browserComposerHandoff.js";
import {
  TOOLS, TEXT_SIZE,
  beginStroke, extendStroke, makeText, undoStrokes, clearStrokes,
  drawStrokes, exportAnnotation,
} from "./annotationExport.js";

// Pencil palette: the two neutrals (ink black, paper white) plus seven evenly
// spaced hues, so every common annotation colour is one click away. Index 0
// (black) is the default pen colour.
export const COLORS = [
  "#000000", // black
  "#ffffff", // white
  "#ff3b30", // red
  "#ff9500", // orange
  "#ffcc00", // yellow
  "#34c759", // green
  "#007aff", // blue
  "#af52de", // purple
  "#ff2d55", // pink
];

// AnnotationLayer — the pencil-mode overlay, reimplemented for the embedded
// WebContentsView (the old screencast <canvas> it froze is gone). The page is a
// native layer floating above React, so nothing the human draws can sit over it
// while it's on screen. The fix is the hide-on-overlay pattern:
//   1. Capture the current view (browserCapture → a temp JPEG) WHILE it's still
//      visible, so the still matches exactly what the human sees.
//   2. Hide the native view (overlayOpen) — now nothing occludes the DOM.
//   3. Show the captured still + a draw canvas in React and let the human draw.
//   4. "Add to chat" composites still+strokes (exportAnnotation, unchanged) and
//      hands the PNG to this pane's composer via the one-shot hand-off store.
//   5. On close, restore the native view.
//
// Coordinate rule (unchanged): strokes are recorded in DISPLAY CSS px; the export
// base is the capture's device px, so compositing scales display→device px — it
// never assumes 1:1.

// Largest box with the still's aspect that fits the container — the on-screen
// CSS-px box the still and the draw canvas share. Null until both are measured.
export function containBox(container, natural) {
  if (!container?.width || !container?.height || !natural?.width || !natural?.height) return null;
  const scale = Math.min(container.width / natural.width, container.height / natural.height);
  return { width: natural.width * scale, height: natural.height * scale };
}

export function AnnotationLayer({ paneId, tabId }) {
  const rootRef = useRef(null);
  const freezeRef = useRef(null); // <canvas> the captured still is painted on
  const drawRef = useRef(null); // <canvas> the strokes render on
  const baseRef = useRef(null); // { image, width, height } — the capture, the export base
  const draftRef = useRef(null); // stroke in progress during a drag
  const drawingRef = useRef(false);
  const textEditRef = useRef(null); // event-time text value for blur/Escape

  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [strokes, setStrokes] = useState([]);
  const [textEdit, setTextEdit] = useState(null); // { x, y, value } | null
  const [exporting, setExporting] = useState(false);
  const [container, setContainer] = useState(null); // { width, height } CSS px of the layer
  const [natural, setNatural] = useState(null); // { width, height } of the captured still

  const box = containBox(container, natural);

  // Always restore the native view when the overlay unmounts (it is hidden only
  // after the capture below, but this guarantees no leftover hide on any exit).
  useEffect(() => () => window.eosBrowserView?.overlayOpen(false), []);

  // Capture the current view as the still + export base, fetched as bytes (not an
  // <img>) so the export canvas stays untainted and toBlob works. The capture runs
  // WHILE the native view is still visible (capturePage composites the on-screen
  // surface), so the still matches exactly what the human sees; only once it lands
  // do we hide the view so the DOM overlay can draw. On failure there is nothing to
  // annotate — say so and leave annotate mode.
  useEffect(() => {
    if (!tabId) return;
    let cancelled = false;
    let bmp = null;
    (async () => {
      const r = await browserFetch(api.routes.browserCapture(tabId), {
        method: "POST",
        body: JSON.stringify({ fullPage: false }),
      });
      if (cancelled) return;
      if (!r.ok || !r.body?.path) { failCapture(); return; }
      try {
        const resp = await fetch(api.imageUrl(r.body.path));
        const blob = await resp.blob();
        bmp = await createImageBitmap(blob);
        if (cancelled) { bmp.close?.(); return; }
        baseRef.current = { image: bmp, width: bmp.width, height: bmp.height };
        setNatural({ width: bmp.width, height: bmp.height });
        window.eosBrowserView?.overlayOpen(true); // now hide the live view
      } catch {
        failCapture();
      }
    })();
    return () => { cancelled = true; bmp?.close?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const failCapture = () => {
    notify.error("Couldn’t capture the page to annotate.");
    toggleMode(paneId, "annotate");
  };

  // Measure the layer so the still/draw box tracks it (contain-fit on resize).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setContainer({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Paint the captured still onto the freeze canvas at the box's device px.
  useEffect(() => {
    const canvas = freezeRef.current;
    const base = baseRef.current;
    if (!canvas || !base || !box) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    try { ctx.drawImage(base.image, 0, 0, box.width, box.height); } catch { /* torn bitmap */ }
  }, [box, natural]);

  // Redraw the stroke canvas: DPR-scaled backing store, committed strokes plus
  // the in-flight draft.
  const redraw = useCallback(() => {
    const canvas = drawRef.current;
    if (!canvas || !box) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(box.width * dpr);
    const h = Math.round(box.height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    drawStrokes(ctx, strokes);
    if (draftRef.current) drawStrokes(ctx, [draftRef.current]);
  }, [strokes, box]);

  useEffect(() => { redraw(); }, [redraw]);

  // Cmd/Ctrl+Z undoes the last stroke while annotating (not while typing text).
  useEffect(() => {
    const onKey = (e) => {
      if (textEdit) return;
      if ((e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        setStrokes((s) => undoStrokes(s));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [textEdit]);

  const pointAt = (e) => {
    const rect = drawRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const pt = pointAt(e);
    if (tool === "text") { openText(pt); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    draftRef.current = beginStroke(tool, color, pt);
    redraw();
  };

  const onPointerMove = (e) => {
    if (!drawingRef.current) return;
    draftRef.current = extendStroke(draftRef.current, pointAt(e));
    redraw();
  };

  const endStroke = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const draft = draftRef.current;
    draftRef.current = null;
    if (draft) setStrokes((s) => [...s, draft]);
  };

  // Text entry: a positioned <input> over the still; the stroke is recorded on
  // commit. textEditRef mirrors the value so blur/Escape read live text.
  const setText = (te) => { textEditRef.current = te; setTextEdit(te); };

  const commitText = () => {
    const te = textEditRef.current;
    if (!te) return;
    textEditRef.current = null;
    const v = te.value.trim();
    if (v) setStrokes((s) => [...s, makeText(color, { x: te.x, y: te.y }, v)]);
    setTextEdit(null);
  };

  const cancelText = () => { textEditRef.current = null; setTextEdit(null); };

  const openText = (pt) => { commitText(); setText({ x: pt.x, y: pt.y, value: "" }); };

  const close = () => toggleMode(paneId, "annotate"); // annotate → view

  const addToChat = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const base = baseRef.current;
      if (!base || !box) { notify.error("Nothing to add — the capture is not ready yet."); return; }
      const path = await exportAnnotation({
        base: base.image,
        target: { width: base.width, height: base.height },
        strokes,
        display: { width: box.width, height: box.height },
        name: `annotation-${Date.now()}.png`,
      });
      pushHandoff(paneId, [{ type: "image", path }]);
      close();
    } catch (e) {
      notify.error(`Add to chat failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  const boxStyle = box ? { width: box.width, height: box.height } : { visibility: "hidden" };

  return (
    <div className="annotation-layer" ref={rootRef}>
      <div className="annotation-surface" style={boxStyle}>
        <canvas ref={freezeRef} className="annotation-freeze" />
        <canvas
          ref={drawRef}
          className="annotation-draw"
          style={{ cursor: tool === "text" ? "text" : "crosshair" }}
          onMouseDown={(e) => { if (tool === "text") e.preventDefault(); }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onLostPointerCapture={endStroke}
        />
        {textEdit && (
          <input
            className="annotation-text-input"
            autoFocus
            value={textEdit.value}
            style={{ left: textEdit.x, top: textEdit.y, color, fontSize: TEXT_SIZE }}
            onChange={(e) => setText({ ...textEditRef.current, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitText(); }
              else if (e.key === "Escape") { e.preventDefault(); cancelText(); }
            }}
            onBlur={commitText}
          />
        )}
      </div>

      <div className="annotation-toolbar">
        <div className="annotation-tools">
          {TOOLS.map((t) => (
            <button
              key={t}
              className={"fv-icon-btn" + (tool === t ? " on" : "")}
              title={TOOL_TITLES[t]}
              aria-label={TOOL_TITLES[t]}
              aria-pressed={tool === t}
              onClick={() => setTool(t)}
            >
              {TOOL_ICONS[t]}
            </button>
          ))}
        </div>
        <div className="annotation-sep" />
        <div className="annotation-colors">
          {COLORS.map((c) => (
            <button
              key={c}
              className={"annotation-swatch" + (color === c ? " on" : "")}
              style={{ "--swatch": c }}
              title={`Colour ${c}`}
              aria-label={`Colour ${c}`}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <div className="annotation-sep" />
        <button
          className="fv-icon-btn"
          title="Clear drawing"
          aria-label="Clear drawing"
          disabled={strokes.length === 0}
          onClick={() => setStrokes(clearStrokes())}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4h10M6.5 4V2.6h3V4M5 4l.6 9h4.8L11 4" />
          </svg>
        </button>
        <div className="annotation-spacer" />
        <button className="fv-btn" onClick={close}>Close</button>
        <button className="fv-btn fv-btn--save" disabled={exporting} onClick={addToChat}>
          {exporting ? "Adding…" : "Add to chat"}
        </button>
      </div>
    </div>
  );
}

const TOOL_TITLES = {
  pen: "Pen",
  line: "Line",
  rect: "Rectangle",
  ellipse: "Ellipse",
  text: "Text",
};

const TOOL_ICONS = {
  pen: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.4 2.6a1.6 1.6 0 0 1 2.3 2.3L6 12.5 2.8 13.5l1-3.2 7.6-7.7z" />
    </svg>
  ),
  line: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M3 13 13 3" />
    </svg>
  ),
  rect: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
    </svg>
  ),
  ellipse: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <ellipse cx="8" cy="8" rx="6" ry="4.5" />
    </svg>
  ),
  text: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M3 4V3h10v1M8 3v10M6 13h4" />
    </svg>
  ),
};
