// POST /api/ui-reload — ask every connected page to location.reload(). Used
// by `eos build` after a web-dist rebuild so the running app refreshes in
// place instead of being quit/reopened. The subscriber count in the response
// is the caller's delivery proof: 0 ⇒ nobody heard it, fall back to relaunch.

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";

export function registerUiReloadRoutes(r: Router, c: Container): void {
  r.post("/api/ui-reload", ({ res }) => {
    const subscribers = c.sse.size();
    c.bus.publish("ui:reload", {});
    writeJson(res, 200, { ok: true, subscribers });
  });
}
