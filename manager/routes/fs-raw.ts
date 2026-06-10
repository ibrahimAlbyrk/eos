import { createReadStream, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { isSafeAbsPath } from "./fs-shared.ts";
import { contentTypeFor } from "../shared/mime.ts";
import { parseByteRange } from "../shared/byte-range.ts";

// These routes are mounted on the dedicated raw-content listener
// (config.daemon.rawPort), never on the main API server: the HTML viewer runs
// untrusted files in an `allow-scripts allow-same-origin` iframe, which is
// only safe when that content cannot share an origin with the uiToken-bearing
// app/API.

function serveFile(path: string, req: IncomingMessage, res: ServerResponse): void {
  let st: Stats;
  try {
    st = statSync(path);
  } catch {
    writeJson(res, 404, { error: "not found" });
    return;
  }
  if (!st.isFile()) {
    writeJson(res, 404, { error: "not a file" });
    return;
  }
  const type = contentTypeFor(path);
  const range = parseByteRange(req.headers.range, st.size);
  const head: Record<string, string | number> = {
    "content-type": type,
    "accept-ranges": "bytes",
  };
  let stream;
  if (range) {
    head["content-range"] = `bytes ${range.start}-${range.end}/${st.size}`;
    head["content-length"] = range.end - range.start + 1;
    res.writeHead(206, head);
    stream = createReadStream(path, range);
  } else {
    head["content-length"] = st.size;
    res.writeHead(200, head);
    stream = createReadStream(path);
  }
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

export function registerFsRawRoutes(r: Router, c: Container): void {
  // Path-style (`/fs/raw/Users/…`, not `?path=`) so relative subresources of
  // served HTML (./game.js, ./img/x.png) resolve to sibling files.
  r.get(/^\/fs\/raw(?<rest>\/.+)$/, ({ params, req, res }) => {
    let qPath: string;
    try {
      qPath = decodeURIComponent(params.rest);
    } catch {
      writeJson(res, 400, { error: "bad path encoding" });
      return;
    }
    if (!isSafeAbsPath(qPath)) {
      writeJson(res, 400, { error: "absolute path required" });
      return;
    }
    serveFile(qPath, req, res);
  });

  // Vendored pdf.js prebuilt viewer. Must share the raw origin — viewer.js
  // only accepts ?file= URLs from its own origin.
  const pdfjsRoot = join(c.config.paths.repoRoot, "manager", "vendor", "pdfjs");
  r.get(/^\/pdfjs(?<rest>\/.*)?$/, ({ params, req, res }) => {
    const rest = params.rest && params.rest !== "/" ? params.rest : "/web/viewer.html";
    const full = join(pdfjsRoot, rest);
    if (!full.startsWith(pdfjsRoot + "/")) {
      writeJson(res, 404, { error: "not found" });
      return;
    }
    serveFile(full, req, res);
  });
}
