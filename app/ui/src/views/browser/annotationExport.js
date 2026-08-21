// annotationExport — the annotation overlay's model + export path, kept out of
// the React component so the geometry is pure and testable without a DOM.
//
// Coordinate rule (the crux): a stroke is recorded in DISPLAY CSS px — the box
// the human actually drew on. The export base is a different pixel size: the
// full-quality capture arrives at the viewport's device px, the fallback frozen
// frame at the live stream's downscaled px. So compositing scales strokes from
// display px up to the base's px (exportScale); it never assumes 1:1.

import { api } from "../../api/client.js";

export const COLORS = ["#ff3b30", "#ffcc00", "#34c759"]; // red / yellow / green swatches
export const TOOLS = ["pen", "line", "rect", "ellipse", "text"];
export const STROKE_WIDTH = 3; // display CSS px
export const TEXT_SIZE = 16; // display CSS px

// ---- stroke model ---------------------------------------------------------
// A stroke is a plain object; the tool decides its shape. pen carries a point
// list (freehand); line/rect/ellipse carry a start+end box; text a point+string.

export function beginStroke(tool, color, pt, width = STROKE_WIDTH) {
  if (tool === "pen") return { tool, color, width, points: [pt] };
  return { tool, color, width, x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
}

export function extendStroke(stroke, pt) {
  if (stroke.tool === "pen") return { ...stroke, points: [...stroke.points, pt] };
  return { ...stroke, x1: pt.x, y1: pt.y };
}

export function makeText(color, pt, text, fontSize = TEXT_SIZE) {
  return { tool: "text", color, x: pt.x, y: pt.y, text, fontSize };
}

// Undo removes the last committed stroke; clear drops them all. Kept as pure
// list ops so the overlay's trash button and Cmd+Z are one-liners and testable.
export function undoStrokes(strokes) {
  return strokes.slice(0, -1);
}

export function clearStrokes() {
  return [];
}

// ---- drawing --------------------------------------------------------------

// Ratio from the displayed base size to the export base's pixel size. Same
// viewport on both sides, so this is just the per-axis scale.
export function exportScale(display, target) {
  return {
    sx: display.width ? target.width / display.width : 1,
    sy: display.height ? target.height / display.height : 1,
  };
}

// Replay every stroke onto a 2D context, scaling display coords by (sx, sy).
// Line widths scale by sx too, so a stroke keeps its proportion and stays crisp
// at export resolution rather than being drawn small then upscaled.
export function drawStrokes(ctx, strokes, sx = 1, sy = 1) {
  for (const s of strokes) drawStroke(ctx, s, sx, sy);
}

function drawStroke(ctx, s, sx, sy) {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = (s.width ?? STROKE_WIDTH) * sx;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (s.tool === "pen") {
    const pts = s.points ?? [];
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x * sx, pts[0].y * sy, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x * sx, pts[0].y * sy);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * sx, pts[i].y * sy);
      ctx.stroke();
    }
  } else if (s.tool === "line") {
    ctx.beginPath();
    ctx.moveTo(s.x0 * sx, s.y0 * sy);
    ctx.lineTo(s.x1 * sx, s.y1 * sy);
    ctx.stroke();
  } else if (s.tool === "rect") {
    const x = Math.min(s.x0, s.x1) * sx;
    const y = Math.min(s.y0, s.y1) * sy;
    ctx.strokeRect(x, y, Math.abs(s.x1 - s.x0) * sx, Math.abs(s.y1 - s.y0) * sy);
  } else if (s.tool === "ellipse") {
    const cx = ((s.x0 + s.x1) / 2) * sx;
    const cy = ((s.y0 + s.y1) / 2) * sy;
    ctx.beginPath();
    ctx.ellipse(cx, cy, (Math.abs(s.x1 - s.x0) / 2) * sx, (Math.abs(s.y1 - s.y0) / 2) * sy, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.tool === "text") {
    ctx.font = `${Math.round((s.fontSize ?? TEXT_SIZE) * sy)}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(s.text ?? "", s.x * sx, s.y * sy);
  }
  ctx.restore();
}

// Draw the base then the scaled strokes onto one context — the whole composite,
// factored out so it can be asserted with a recording context in tests.
export function paintComposite(ctx, base, target, strokes, display) {
  ctx.drawImage(base, 0, 0, target.width, target.height);
  const { sx, sy } = exportScale(display, target);
  drawStrokes(ctx, strokes, sx, sy);
}

// ---- export ---------------------------------------------------------------

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(canvas) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas encode failed"))), "image/png");
  });
}

// Reuse the exact path a pasted screenshot takes (POST /fs/paste, octet-stream +
// x-filename, 20 MB cap) rather than inventing a second upload route. The
// snapshot shape { name, bytes } threads the already-encoded bytes straight
// through api.uploadPaste.
export async function uploadAnnotation(blob, name) {
  const r = await api.uploadPaste({ name, bytes: blob.arrayBuffer() });
  if (!r.ok || !r.body?.path) throw new Error(`annotation upload failed (${r.status})`);
  return r.body.path;
}

// Composite base + strokes at the base's native pixel size, encode, upload, and
// return the on-disk path the composer attaches. `base` is an ImageBitmap /
// canvas / image sized target.width×target.height; `display` is the CSS box the
// strokes were drawn in.
export async function exportAnnotation({ base, target, strokes, display, name }) {
  const canvas = makeCanvas(target.width, target.height);
  paintComposite(canvas.getContext("2d"), base, target, strokes, display);
  const blob = await canvasToBlob(canvas);
  return uploadAnnotation(blob, name);
}
