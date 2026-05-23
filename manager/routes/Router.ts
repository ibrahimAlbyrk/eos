// Tiny router. Each route is `{method, pattern, handler}`. Patterns are
// either a literal path string or a RegExp with named groups (returned in
// `params`). First match wins; order of registration matters.

import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteContext {
  method: string;
  path: string;
  url: URL;
  params: Record<string, string>;
  req: IncomingMessage;
  res: ServerResponse;
  requestId: string;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

interface Route {
  method: string;
  pattern: string | RegExp;
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, pattern: string | RegExp, handler: RouteHandler): this {
    this.routes.push({ method, pattern, handler });
    return this;
  }

  get(pattern: string | RegExp, handler: RouteHandler): this { return this.on("GET", pattern, handler); }
  post(pattern: string | RegExp, handler: RouteHandler): this { return this.on("POST", pattern, handler); }
  put(pattern: string | RegExp, handler: RouteHandler): this { return this.on("PUT", pattern, handler); }
  del(pattern: string | RegExp, handler: RouteHandler): this { return this.on("DELETE", pattern, handler); }

  /**
   * Resolve the first matching route for (method, path). Returns the handler
   * + extracted params, or null if nothing matched. Path matching:
   *  - literal string → exact equality
   *  - RegExp → match.groups → params
   */
  match(method: string, path: string): { handler: RouteHandler; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      if (typeof r.pattern === "string") {
        if (r.pattern === path) return { handler: r.handler, params: {} };
        continue;
      }
      const m = path.match(r.pattern);
      if (m) return { handler: r.handler, params: { ...(m.groups ?? {}) } };
    }
    return null;
  }
}
