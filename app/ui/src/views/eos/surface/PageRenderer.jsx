import { useEffect, useRef, useState } from "react";

// Kinds of message a page frame sends (05 §8). Anything else is dropped.
const FROM_PAGE = new Set(["eos-page/ready", "eos-page/size", "eos-page/act", "eos-page/open", "eos-page/part", "eos-page/read", "eos-page/mode"]);

// Height before the page has measured itself.
const FIRST_HEIGHT = 640;

// Only http and https links leave for the browser; anything else a page
// names (eos-action: for the phone, javascript:, data:) opens nothing here.
export function openableLink(href) {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// A message from the page, when it came from this frame and is one the page
// may send; null otherwise.
export function pageMessage(event, frame) {
  if (!frame || event.source !== frame) return null;
  const data = event.data;
  return data && typeof data === "object" && FROM_PAGE.has(data.type) ? data : null;
}

// 05's page in its sandboxed frame on the raw origin (`allow-scripts`, no
// same origin): its fonts and colours stay inside, and it reaches nothing.
// Pressing, opening, pointing and reading come back as messages from that
// frame only; the parent tells it the mode (read or point).
export function PageRenderer({ src, title, mode = "read", onAct, onPart, onRead, onModeEnd }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(FIRST_HEIGHT);
  const [ready, setReady] = useState(false);
  const handlers = useRef({});
  handlers.current = { onAct, onPart, onRead, onModeEnd };

  useEffect(() => {
    setReady(false);
  }, [src]);

  useEffect(() => {
    const listen = (event) => {
      const message = pageMessage(event, ref.current?.contentWindow);
      if (!message) return;
      const h = handlers.current;
      switch (message.type) {
        case "eos-page/ready": setReady(true); break;
        case "eos-page/size":
          if (Number.isFinite(message.height) && message.height > 0) setHeight(Math.ceil(message.height));
          break;
        case "eos-page/act": h.onAct?.(message); break;
        case "eos-page/open": {
          const href = openableLink(message.href);
          if (href) window.open(href, "_blank", "noopener,noreferrer");
          break;
        }
        case "eos-page/part": h.onPart?.(message); break;
        case "eos-page/read": h.onRead?.(message); break;
        case "eos-page/mode": h.onModeEnd?.(message.mode); break;
        default: break;
      }
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, []);

  useEffect(() => {
    if (ready) ref.current?.contentWindow?.postMessage({ type: "eos-page/mode", mode }, "*");
  }, [mode, ready]);

  return (
    <iframe
      ref={ref}
      className={mode === "point" ? "eos-page-frame is-pointing" : "eos-page-frame"}
      title={title}
      src={src}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ height }}
    />
  );
}
