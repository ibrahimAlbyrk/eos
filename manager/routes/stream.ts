import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";

export function registerStreamRoutes(r: Router, c: Container): void {
  r.get("/stream", ({ req, res, url }) => {
    const handle = c.sse.attach(res);
    // The Files tab passes ?clientId so its directory watches are released when
    // this connection drops (tab close/reload/crash) even if DELETE never fires.
    const clientId = url.searchParams.get("clientId");
    req.on("close", () => {
      handle.detach();
      if (clientId) c.fsWatchRegistry.dropClient(clientId);
    });
  });
}
