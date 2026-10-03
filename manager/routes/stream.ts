import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { StreamFocusRequestSchema, type StreamFocusResponse } from "../../contracts/src/http.ts";
import type { StreamFocus } from "../sse/SseBroadcaster.ts";

const list = (raw: string | null): string[] => raw?.split(",").map((t) => t.trim()).filter(Boolean) ?? [];

export function registerStreamRoutes(r: Router, c: Container): void {
  r.get("/stream", ({ req, res, url }) => {
    // Resume point: our own reconnect passes ?since; the browser's native
    // EventSource retry sends Last-Event-ID.
    const lastEventId = req.headers["last-event-id"];
    const since = url.searchParams.get("since") ?? (typeof lastEventId === "string" ? lastEventId : null);
    const topics = url.searchParams.get("topics")?.split(",").map((t) => t.trim()).filter(Boolean) ?? null;
    // The Files tab passes ?clientId so its directory watches are released when
    // this connection drops (tab close/reload/crash) even if DELETE never fires.
    const clientId = url.searchParams.get("clientId");
    // ?focus= (even empty) = the tab says what it has on screen; POST
    // /stream/focus keeps it current.
    const focus: StreamFocus | null = url.searchParams.has("focus")
      ? { workers: list(url.searchParams.get("focus")), ptys: list(url.searchParams.get("ptys")) }
      : null;
    const handle = c.sse.attach(res, { since, topics, clientId, focus });
    req.on("close", () => {
      handle.detach();
      if (clientId) c.fsWatchRegistry.dropClient(clientId);
    });
  });

  // What a tab has on screen changed. The answer seeds the panes that just came
  // into view with the text their workers already streamed.
  r.post("/stream/focus", async ({ req, res }) => {
    const body = validate(StreamFocusRequestSchema, await readBody(req));
    c.sse.setFocus(body.clientId, body);
    const out: StreamFocusResponse = { live: body.workers.flatMap((id) => c.liveText.blocksFor(id)) };
    writeJson(res, 200, out);
  });
}
