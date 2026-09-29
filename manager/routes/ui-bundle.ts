// GET /ui/* — this daemon's own dashboard bundle. A computer controlling this
// Mac loads the UI from here (through its host facade), so the dashboard always
// matches the daemon it drives, whatever version the controlling Mac runs.
// Hashed assets are immutable; text is gzipped because it may cross a WAN.

import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import { createGzip } from "node:zlib";

import type { Router } from "./Router.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { resolveWithinRoot } from "./fs-shared.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

export function registerUiBundleRoutes(r: Router, deps: { root: () => string }): void {
  r.get(/^\/ui(?<rest>\/.*)?$/, ({ req, res, params }) => {
    const rel = !params.rest || params.rest === "/" ? "index.html" : decodeURIComponent(params.rest.slice(1));
    const file = resolveWithinRoot(deps.root(), rel);
    let size = 0;
    try {
      if (!file) throw new Error("outside root");
      const st = statSync(file);
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      writeJson(res, 404, { error: "not found", path: `/ui/${rel}` });
      return;
    }
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const gzip = /^(text\/|application\/(json|wasm)|image\/svg)/.test(type) && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    res.setHeader("content-type", type);
    // Vite fingerprints everything under assets/; index.html must always revalidate.
    res.setHeader("cache-control", rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    if (gzip) {
      res.setHeader("content-encoding", "gzip");
      res.writeHead(200);
      createReadStream(file!).pipe(createGzip({ level: 6 })).pipe(res);
    } else {
      res.setHeader("content-length", String(size));
      res.writeHead(200);
      createReadStream(file!).pipe(res);
    }
  });
}
