import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Exact MIME map ported from BundledUISchemeHandler (doc 10 §c). Unknown
// extensions fall through to application/octet-stream.
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
};

function mimeFor(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

function notFound(): Response {
  return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
}

// Registered ONCE before app.ready (doc 30 Claim 2.2). standard+secure gives a
// stable real origin (eos://app) with working localStorage + secure context;
// supportFetchAPI/stream/codeCache per §C2.
export function registerEosSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "eos",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

// Replicates BundledUISchemeHandler (doc 10 §c): default-to-index, a normalized
// path-containment guard, the fixed MIME map, whole-file responses. Daemon
// SSE/HTTP/WS deliberately stay on direct loopback and never touch this handler.
export function installEosProtocol(uiRoot: string, csp: string | null): void {
  const root = path.resolve(uiRoot);
  protocol.handle("eos", async (request) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return notFound();
    }
    if (pathname === "" || pathname === "/") pathname = "/index.html";

    const resolved = path.resolve(root, "." + pathname);
    // Containment: serve only the root itself or paths beneath it.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return notFound();

    try {
      const data = await readFile(resolved);
      const headers: Record<string, string> = { "content-type": mimeFor(resolved) };
      // CSP as a header on the entry document (defense-in-depth, zero UI change).
      if (csp && path.basename(resolved) === "index.html") {
        headers["content-security-policy"] = csp;
      }
      // Copy into an exactly-sized view so a pooled Buffer can't over-read.
      return new Response(new Uint8Array(data), { status: 200, headers });
    } catch {
      return notFound();
    }
  });
}
