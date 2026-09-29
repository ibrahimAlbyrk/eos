// Which daemon routes may be driven from another computer.
//
// The daemon serves two planes on one router: the UI plane (everything the
// dashboard calls) and a local plane that only processes on this Mac use —
// workers posting events, MCP servers polling, the permission hook, and
// pickers that open a native dialog on this screen. A paired device gets the
// UI plane; the local plane is never forwarded. Peering management is local
// too, so a paired device can neither mint invites nor chain onward to hosts
// this Mac controls.

export type RouteRule = readonly [method: string, template: string];

// `:name` matches one path segment; a trailing `/*` matches the prefix and anything below it.
export const LOCAL_ONLY_ROUTES: readonly RouteRule[] = [
  ["POST", "/workers/:id/events"],
  ["POST", "/policy/decide"],
  ["POST", "/workers/:id/question"],
  ["GET", "/workers/:id/question/:qId"],
  ["POST", "/workers/:id/peer-request"],
  ["GET", "/workers/:id/peer-request/:rId"],
  ["POST", "/workers/:id/peer-response"],
  ["POST", "/workers/:id/report"],
  ["GET", "/pick-directory"],
  ["GET", "/pick-file"],
  ["*", "/api/peer/*"],
  ["*", "/api/hosts/*"],
  ["*", "/api/remote/*"],
  ["*", "/h/*"],
  ["*", "/peer/pair"],
];

function templateRegex(template: string): RegExp {
  const prefix = template.endsWith("/*");
  const base = (prefix ? template.slice(0, -2) : template)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:[A-Za-z0-9_]+/g, "[^/]+");
  return new RegExp(prefix ? `^${base}(?:/.*)?$` : `^${base}$`);
}

export function compileRouteRules(rules: readonly RouteRule[]): (method: string, path: string) => boolean {
  const compiled = rules.map(([m, t]) => ({ method: m, re: templateRegex(t) }));
  return (method, path) => {
    const pathOnly = path.split("?", 1)[0];
    return compiled.some((r) => (r.method === "*" || r.method === method) && r.re.test(pathOnly));
  };
}

export const isLocalOnlyRoute = compileRouteRules(LOCAL_ONLY_ROUTES);
