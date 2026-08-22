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
// spaced hues, so every common annotation colour is one click away. Lives here
// rather than in annotationExport — strokes keep whatever colour was picked, so
// only the swatch row reads this list. Index 0 (black) is the default pen colour.
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

// AnnotationLayer — the pencil-mode overlay (plan §4 Phase 6). Architecture is
// capture-then-draw, and the order is not negotiable: nothing the human draws
// ever enters the page (an in-page canvas is visible to a hostile DOM), so the
// page is frozen to a bitmap and every stroke lives here in React.
//
// Freeze in two steps so it feels instant and still exports cleanly:
//   1. The moment the mode flips, copy the live canvas's current pixels into a
//      frozen <canvas> — no round trip, so nothing shifts under the pen. This
//      also becomes the export FALLBACK base.
//   2. In parallel request a full-quality capture (viewport, jpeg q80 — the live
//      stream is q60/maxWidth1024 and too soft to be what an agent reads) and
//      swap it in as the export base once it arrives. Same viewport, so geometry
//      maps 1:1 in CSS px; export scales display px → the base's device px.
//
// "Add to chat" composites base+strokes and hands the image to this pane's
// composer via the one-shot hand-off store — reusing the same /fs/paste path a
// pasted screenshot takes, never a second upload route.

// A freeze is only valid from a canvas that has actually painted a frame. A
// fresh or torn .browser-canvas keeps the default (non-zero) backing store, so a
// size check alone passes, yet it is fully transparent — copying it and showing
// the freeze's white backdrop is the white band seen on reopen. Streamed frames
// are opaque JPEGs, so a non-zero alpha at the centre pixel means a real frame
// is present; an unreadable or zero-sized canvas is treated as unpainted.
export function hasPaintedFrame(canvas) {
  if (!canvas || !canvas.width || !canvas.height) return false;
  try {
    const { data } = canvas.getContext("2d").getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1);
    return data[3] !== 0;
  } catch {
    return false;
  }
}

export function AnnotationLayer({ paneId, tabId }) {
  const rootRef = useRef(null);
  const freezeRef = useRef(null); // <canvas> holding the frozen frame (also the fallback base)
  const drawRef = useRef(null); // <canvas> the strokes render on
  const exportBaseRef = useRef(null); // { image, width, height } — the high-q capture once it lands
  const draftRef = useRef(null); // stroke in progress during a drag
  const drawingRef = useRef(false);
  const textEditRef = useRef(null); // event-time text value, so blur/Escape read the live text not a stale render closure

  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [strokes, setStrokes] = useState([]);
  const [textEdit, setTextEdit] = useState(null); // { x, y, value } | null
  const [exporting, setExporting] = useState(false);
  const [frozen, setFrozen] = useState(false); // a real frame has been copied into freezeRef

  // Redraw the whole stroke canvas: DPR-scaled backing store, committed strokes
  // plus the in-flight draft. Cheap — this is a frozen frame, not a 60fps path.
  const redraw = useCallback(() => {
    const canvas = drawRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    drawStrokes(ctx, strokes);
    if (draftRef.current) drawStrokes(ctx, [draftRef.current]);
  }, [strokes]);

  // Step 1 — freeze from the live canvas's current pixels the instant we mount
  // (before paint, so the last streamed frame is still there). The overlay then
  // covers the live canvas, so the page underneath is visually frozen and its
  // input is swallowed here. Guard: never freeze a canvas that has not painted a
  // real frame yet — a fresh/torn one keeps a non-zero default backing store but
  // is fully transparent, and copying it would show the freeze's white backdrop
  // as a band. If we ever mount before the first frame (defensive — a fresh open
  // starts in "view"), wait for one instead of committing a blank freeze.
  useLayoutEffect(() => {
    let raf = 0;
    const attempt = () => {
      const live = rootRef.current?.closest(".browser-body")?.querySelector(".browser-canvas");
      const freeze = freezeRef.current;
      if (!freeze) return;
      if (live && hasPaintedFrame(live)) {
        freeze.width = live.width;
        freeze.height = live.height;
        try { freeze.getContext("2d").drawImage(live, 0, 0); } catch { /* torn frame — capture still swaps in */ }
        setFrozen(true);
        redraw();
        return;
      }
      raf = requestAnimationFrame(attempt);
    };
    attempt();
    return () => { if (raf) cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Step 2 — the high-quality capture, fetched as bytes (not an <img>) so the
  // export canvas stays untainted and toBlob works. On any failure we keep the
  // frozen frame as the base and say so.
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
      if (!r.ok || !r.body?.path) { notify.warning("Full-quality capture unavailable — annotating the live frame."); return; }
      try {
        const resp = await fetch(api.imageUrl(r.body.path));
        const blob = await resp.blob();
        bmp = await createImageBitmap(blob);
        if (cancelled) { bmp.close?.(); return; }
        exportBaseRef.current = { image: bmp, width: bmp.width, height: bmp.height };
      } catch {
        notify.warning("Full-quality capture unavailable — annotating the live frame.");
      }
    })();
    return () => { cancelled = true; bmp?.close?.(); };
  }, [tabId]);

  // Redraw on stroke changes and keep the DPR backing store correct as the panel
  // resizes.
  useEffect(() => { redraw(); }, [redraw]);
  useEffect(() => {
    const canvas = drawRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [redraw]);

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

  // Text entry: a positioned <input> over the frozen frame; the stroke is
  // recorded only on commit. textEditRef mirrors the value so blur (click-away
  // commit) and Escape (cancel) read the live text, not a stale render closure.
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

  // Placing a new text point commits any in-progress one first, so clicking to
  // place the next label never drops the current text.
  const openText = (pt) => { commitText(); setText({ x: pt.x, y: pt.y, value: "" }); };

  const close = () => toggleMode(paneId, "annotate"); // annotate → view

  const addToChat = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const capture = exportBaseRef.current;
      const freeze = freezeRef.current;
      const base = capture?.image
        ? capture
        : (freeze?.width ? { image: freeze, width: freeze.width, height: freeze.height } : null);
      if (!base) { notify.error("Nothing to add — the frame is not ready yet."); return; }
      const rect = drawRef.current.getBoundingClientRect();
      const path = await exportAnnotation({
        base: base.image,
        target: { width: base.width, height: base.height },
        strokes,
        display: { width: rect.width, height: rect.height },
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

  return (
    <div className="annotation-layer" ref={rootRef}>
      <div className="annotation-surface">
        <canvas ref={freezeRef} className="annotation-freeze" style={frozen ? undefined : { display: "none" }} />
        <canvas
          ref={drawRef}
          className="annotation-draw"
          style={{ cursor: tool === "text" ? "text" : "crosshair" }}
          // Keep focus on the text input: clicking this non-focusable canvas would
          // otherwise move focus to <body> and blur (then tear down) the input.
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
