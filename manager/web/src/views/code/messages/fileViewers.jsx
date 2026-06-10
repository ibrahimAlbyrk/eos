// File-type viewer registry for the file panel. Mirrors toolViews.jsx: a kind
// (from lib/fileKind.js) maps to a Body component; unregistered kinds fall
// back to FileViewer's text/code path.

import { useRef } from "react";
import { api } from "../../../api/client.js";

function PdfBody({ path }) {
  // No sandbox attribute: sandboxing an iframe disables WebKit's PDF plugin
  // entirely (WebKit bug 118859), and the pdf.js viewer needs scripts anyway.
  return <iframe className="fv-frame" title="PDF" src={api.pdfViewerUrl(path)} />;
}

function HtmlBody({ path, frameGen }) {
  const ref = useRef(null);
  // allow-same-origin is safe ONLY because rawUrl points at the dedicated
  // raw-content origin (daemon.rawPort) — see manager/routes/fs-raw.ts.
  return (
    <iframe
      key={frameGen}
      ref={ref}
      className="fv-frame fv-frame--html"
      title="HTML preview"
      src={api.rawUrl(path)}
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-downloads"
      allow="fullscreen; gamepad; autoplay"
      onLoad={() => ref.current?.contentWindow?.focus()}
    />
  );
}

function ImageBody({ path }) {
  return (
    <div className="fv-image-wrap">
      <img src={api.imageUrl(path)} alt={path.split("/").pop()} className="fv-image" />
    </div>
  );
}

function VideoBody({ path }) {
  return (
    <div className="fv-media-wrap">
      <video className="fv-media" controls src={api.rawUrl(path)} />
    </div>
  );
}

function AudioBody({ path }) {
  return (
    <div className="fv-media-wrap">
      <audio controls src={api.rawUrl(path)} />
    </div>
  );
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function BinaryBody({ path, size }) {
  return (
    <div className="fv-binary">
      <span className="fv-binary-name">{path.split("/").pop()}</span>
      <span>{size != null ? `Binary file — ${formatBytes(size)}` : "Binary file"}</span>
      <button className="fv-btn" onClick={() => api.openFile(path)}>Open with default app</button>
    </div>
  );
}

const VIEWERS = new Map([
  ["pdf", { Body: PdfBody }],
  ["html", { Body: HtmlBody }],
  ["image", { Body: ImageBody }],
  ["video", { Body: VideoBody }],
  ["audio", { Body: AudioBody }],
  ["binary", { Body: BinaryBody }],
]);

export function getFileViewer(kind) {
  return VIEWERS.get(kind) ?? null;
}
