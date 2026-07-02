// Syntactic symbol intelligence routes (tree-sitter tags). Un-gated GETs, the
// same sandbox model as the /fs read handlers: `root` must be a safe absolute
// path (it drives daemon-side file listing + reads), `fromPath` must resolve
// within that root. One lookup handler serves go-to-def (want=definitions) and
// find-refs (want=references); search serves the symbol search box.

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { isSafeAbsPath, resolveWithinRoot } from "./fs-shared.ts";
import { errMsg } from "../../contracts/src/util.ts";

export function registerSymbolRoutes(r: Router, c: Container): void {
  r.get("/symbols/lookup", async ({ url, res }) => {
    const root = url.searchParams.get("root");
    const name = url.searchParams.get("name");
    if (!isSafeAbsPath(root)) { writeJson(res, 400, { error: "root must be absolute" }); return; }
    if (!name) { writeJson(res, 400, { error: "name required" }); return; }
    const want = url.searchParams.get("want") === "references" ? "references" : "definitions";
    // fromPath is a ranking hint only; keep it if it sandboxes cleanly, else drop.
    const fromPathRaw = url.searchParams.get("fromPath");
    const fromPath = fromPathRaw && resolveWithinRoot(root, fromPathRaw) ? fromPathRaw : undefined;
    try {
      await c.symbolIndex.ensureIndexed(root);
      const occurrences = want === "references"
        ? await c.symbolIndex.references(root, name)
        : await c.symbolIndex.definitions(root, name, fromPath);
      writeJson(res, 200, { occurrences });
    } catch (e) {
      writeJson(res, 500, { error: errMsg(e) });
    }
  });

  r.get("/symbols/search", async ({ url, res }) => {
    const root = url.searchParams.get("root");
    if (!isSafeAbsPath(root)) { writeJson(res, 400, { error: "root must be absolute" }); return; }
    const query = (url.searchParams.get("query") ?? "").trim();
    if (!query) { writeJson(res, 200, { symbols: [] }); return; }
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    try {
      await c.symbolIndex.ensureIndexed(root);
      const symbols = await c.symbolIndex.searchSymbols(root, query, limit);
      writeJson(res, 200, { symbols });
    } catch (e) {
      writeJson(res, 500, { error: errMsg(e) });
    }
  });
}
