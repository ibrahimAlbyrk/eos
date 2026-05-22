import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";

export function registerStreamRoutes(r: Router, c: Container): void {
  r.get("/stream", ({ req, res }) => {
    const handle = c.sse.attach(res);
    req.on("close", () => handle.detach());
  });
}
