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

// A view of a router whose routes answer only while `isOn()` holds — otherwise
// `refuse` answers. Routes still register in the parent, in order; a feature
// that can be switched off at runtime registers through one of these.
export class GuardedRouter extends Router {
  private readonly parent: Router;
  private readonly isOn: () => boolean;
  private readonly refuse: RouteHandler;

  constructor(parent: Router, isOn: () => boolean, refuse: RouteHandler) {
    super();
    this.parent = parent;
    this.isOn = isOn;
    this.refuse = refuse;
  }

  override on(method: string, pattern: string | RegExp, handler: RouteHandler): this {
    this.parent.on(method, pattern, (ctx) => (this.isOn() ? handler(ctx) : this.refuse(ctx)));
    return this;
  }
}
