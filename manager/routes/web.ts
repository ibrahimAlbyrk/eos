import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  map: "application/json; charset=utf-8",
  woff2: "font/woff2",
  woff: "font/woff",
};

export function registerWebRoutes(r: Router, c: Container): void {
  r.get(/^\/web(?<rest>\/.*)?$/, ({ params, res }) => {
    const rest = params.rest && params.rest !== "/" ? params.rest : "/index.html";
    const webRoot = join(c.config.paths.repoRoot, "manager", "web", "dist");
    const full = join(webRoot, rest);
    if (!full.startsWith(webRoot) || !existsSync(full)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found — run `npm run build` in manager/web");
      return;
    }
    const ext = rest.split(".").pop() || "";
    const mime = MIME[ext] ?? "application/octet-stream";
    const cache = ext === "html" ? "no-store" : "public, max-age=31536000, immutable";
    res.writeHead(200, { "content-type": mime, "cache-control": cache });
    res.end(readFileSync(full));
  });

  r.get("/", ({ res }) => {
    res.writeHead(302, { location: "/web/" });
    res.end();
  });
}
