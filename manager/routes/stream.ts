import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";

export function registerStreamRoutes(r: Router, c: Container): void {
  r.get("/stream", ({ req, res, url }) => {
    // Resume point: our own reconnect passes ?since; the browser's native
    // EventSource retry sends Last-Event-ID.
    const lastEventId = req.headers["last-event-id"];
    const since = url.searchParams.get("since") ?? (typeof lastEventId === "string" ? lastEventId : null);
    const topics = url.searchParams.get("topics")?.split(",").map((t) => t.trim()).filter(Boolean) ?? null;
    const handle = c.sse.attach(res, { since, topics });
    // The Files tab passes ?clientId so its directory watches are released when
    // this connection drops (tab close/reload/crash) even if DELETE never fires.
    const clientId = url.searchParams.get("clientId");
    req.on("close", () => {
      handle.detach();
      if (clientId) c.fsWatchRegistry.dropClient(clientId);
    });
  });
}
