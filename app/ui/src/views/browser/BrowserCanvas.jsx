import { useEffect, useRef } from "react";
import { makeFramePump, canvasToPage } from "./paintFrame.js";

// BrowserCanvas — paints the binary frame stream and forwards human input back
// through the same socket. Paint path per plan §3.3: createImageBitmap →
// drawImage → close, latest-frame-wins (an older undecoded frame is dropped
// when a newer one lands mid-paint; the max-seq ack covers the skipped one).
// Every dequeued frame is acked EVEN IF PAINT FAILS — the daemon stops sending
// after 3 unacked frames, so a skipped ack wedges the stream permanently
// (makeFramePump owns that contract). Coordinate translation: page coords are
// viewport CSS px (canvasToPage).

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
function modifiersOf(e) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const MOUSE_BUTTONS = ["left", "middle", "right"];

export function BrowserCanvas({ ws, viewport, fill }) {
  const canvasRef = useRef(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  // Frame pump: paint the newest frame, ack every frame we dequeue. If frames
  // arrive faster than decode+paint, only the latest queued one is painted —
  // the daemon's unacked-window drop rule then throttles the stream to our pace.
  useEffect(() => {
    if (!ws) return;
    const pump = makeFramePump({
      getCanvas: () => canvasRef.current,
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
    });
    const onMessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) pump.push(ev.data);
    };
    ws.addEventListener("message", onMessage);
    return () => {
      pump.dispose();
      ws.removeEventListener("message", onMessage);
    };
  }, [ws]);

  const send = (event) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", event }));
  };

  const pagePoint = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return canvasToPage(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, viewportRef.current);
  };

  const mouse = (e, type) => {
    const { x, y } = pagePoint(e);
    send({
      kind: "mouse",
      type,
      x,
      y,
      button: MOUSE_BUTTONS[e.button] ?? "none",
      buttons: e.buttons,
      clickCount: type === "mouseMoved" ? 0 : e.detail,
      modifiers: modifiersOf(e),
    });
  };

  // Native non-passive wheel listener: React's synthetic onWheel is passive,
  // so preventDefault (needed to stop the panel itself scrolling) must be
  // attached by hand.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const { x, y } = canvasToPage(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, viewportRef.current);
      // CDP mouseWheel follows the DOM sign convention (positive deltaY
      // scrolls down); Chromium's input handler converts to Blink's sign.
      send({ kind: "mouse", type: "mouseWheel", x, y, button: "none", buttons: 0, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiersOf(e) });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const key = (e, type) => {
    // Meta chords stay with the app (Cmd+W, Cmd+C…); everything else goes to
    // the page. Full app-reserved-chord capture is a later panel phase.
    if (e.metaKey) return;
    e.preventDefault();
    const printable = e.key.length === 1 && !e.ctrlKey;
    send({
      kind: "key",
      type,
      key: e.key,
      code: e.code,
      text: type === "keyDown" && printable ? e.key : "",
      windowsVirtualKeyCode: e.keyCode,
      modifiers: modifiersOf(e),
    });
  };

  // Responsive fills the panel (the frame now matches the panel aspect, so no
  // fixed aspect ratio is pinned — that is what caused the letterbox). Mobile/
  // Tablet keep the viewport aspect and letterbox inside the DeviceFrame.
  const aspect = viewport ? `${viewport.width} / ${viewport.height}` : "16 / 10";

  return (
    <canvas
      ref={canvasRef}
      className={fill ? "browser-canvas is-fill" : "browser-canvas"}
      style={fill ? undefined : { aspectRatio: aspect }}
      tabIndex={0}
      onMouseDown={(e) => { canvasRef.current.focus(); mouse(e, "mousePressed"); }}
      onMouseUp={(e) => mouse(e, "mouseReleased")}
      onMouseMove={(e) => mouse(e, "mouseMoved")}
      onKeyDown={(e) => key(e, "keyDown")}
      onKeyUp={(e) => key(e, "keyUp")}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
