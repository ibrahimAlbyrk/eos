// Preloaded into the Node daemon (`node --import route-probe.mjs manager/daemon.ts`)
// to write the route table it really registers: every (method, pattern) in
// registration order, the ROUTES keys as path templates, and who may reach each
// route from outside this Mac. Read-only: it wraps Router.on and changes nothing.
//
// EOS_WIRE_REPO  the checkout the daemon runs from
// EOS_WIRE_ROUTES_OUT  where to write the JSON

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.env.EOS_WIRE_REPO;
const out = process.env.EOS_WIRE_ROUTES_OUT;

if (repo && out) {
  const load = (rel) => import(pathToFileURL(join(repo, rel)).href);
  const { Router, GuardedRouter } = await load("manager/routes/Router.ts");
  const { ROUTES } = await load("contracts/src/http.ts");
  const { composeRouteAccess } = await load("manager/routes/route-access.ts");
  const { PEER_OPEN_ROUTES, compileRouteRules } = await load("contracts/src/route-planes.ts");

  // Each feature module declares its own access rules next to its routes.
  const moduleAccess = [];
  const missing = [];
  for (const [file, name] of [
    ["manager/modules/artifacts/routes.ts", "ARTIFACT_ROUTE_ACCESS"],
    ["manager/modules/transfer/routes.ts", "TRANSFER_ROUTE_ACCESS"],
    ["manager/modules/workflow-runs/routes.ts", "WORKFLOW_RUN_ROUTE_ACCESS"],
    ["manager/modules/updates/routes.ts", "UPDATE_ROUTE_ACCESS"],
    ["manager/modules/genui/location-routes.ts", "LOCATION_ROUTE_ACCESS"],
    ["manager/modules/sync/routes.ts", "SYNC_ROUTE_ACCESS"],
  ]) {
    try {
      const rules = (await load(file))[name];
      if (rules) moduleAccess.push(rules);
      else missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  const access = composeRouteAccess(moduleAccess);
  const peerOpen = compileRouteRules(PEER_OPEN_ROUTES);

  // One string a parameter's own pattern accepts (`[0-9a-f]{64}`, `v_[A-Za-z0-9]{12}`, `a|b`).
  const sampleOf = (body) => {
    if (/^[\w-]+(\|[\w-]+)+$/.test(body)) return body.split("|")[0];
    let out = "";
    const re = /(\\d|\\\/|\\\.|\[[^\]]+\]|\.|[^\\])(\{(\d+)\}|[+*])?/g;
    for (const m of body.matchAll(re)) {
      const atom = m[1];
      const ch = atom === "\\d" ? "1" : atom === "\\/" ? "/" : atom === "\\." ? "." : atom === "." ? "x"
        : atom.startsWith("[") ? (atom.startsWith("[^") ? "x" : atom[1]) : atom;
      out += ch.repeat(m[3] ? Number(m[3]) : m[2] === "*" ? 0 : 1);
    }
    return out;
  };
  const GROUP = /\(\?<([A-Za-z0-9_]+)>((?:[^()\[\]]|\[[^\]]*\])*)\)(\?)?/g;
  const literal = (source) => source.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/").replace(/\\([.\-])/g, "$1");
  // A path the pattern matches.
  const sample = (pattern) => {
    if (typeof pattern === "string") return pattern;
    const guess = literal(pattern.source.replace(GROUP, (_, _name, body, optional) => (optional ? "" : sampleOf(body))));
    return pattern.test(guess) ? guess : null;
  };
  // The pattern with `:name` for each parameter (`/*` for a trailing rest).
  const template = (pattern) => {
    if (typeof pattern === "string") return pattern;
    return literal(pattern.source.replace(GROUP, (_, name, body) => (body.startsWith("\\/") ? "/*" : `:${name}`)));
  };

  const routers = [];
  const routes = [];
  const on = Router.prototype.on;
  const guardedOn = GuardedRouter.prototype.on;
  let guarded = false;
  let timer = null;
  // A guarded router (a built-in plugin's routes) registers into its parent.
  GuardedRouter.prototype.on = function (method, pattern, handler) {
    guarded = true;
    try {
      return guardedOn.call(this, method, pattern, handler);
    } finally {
      guarded = false;
    }
  };
  Router.prototype.on = function (method, pattern, handler) {
    const path = sample(pattern);
    const remote = path ? access.classifyRemote(method, path) : null;
    if (!routers.includes(this)) routers.push(this);
    routes.push({
      // 0 = the API router, 1 = the raw-content router (separate port).
      router: routers.indexOf(this),
      // Answers 404 plugin_off while its built-in plugin is switched off.
      pluginGuarded: guarded,
      method,
      pattern: typeof pattern === "string" ? pattern : pattern.source,
      regex: typeof pattern !== "string",
      template: template(pattern),
      sample: path,
      localOnly: path ? access.isLocalOnly(method, path) : null,
      peerOpen: path ? peerOpen(method, path) : null,
      phoneTier: remote?.tier ?? null,
      phoneUiToken: remote?.uiToken ?? null,
    });
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
    return on.call(this, method, pattern, handler);
  };

  const keyTemplate = (value) => {
    if (typeof value === "string") return value;
    const args = Array.from({ length: value.length }, (_, i) => `__p${i}__`);
    return String(value(...args)).replace(/__p(\d)__/g, ":p$1");
  };

  const flush = () => {
    const body = {
      note: "Written by rust/tools/wire-recorder/node/route-probe.mjs from the running Node daemon.",
      missingModuleAccess: missing,
      routeKeys: Object.fromEntries(Object.entries(ROUTES).map(([k, v]) => [k, keyTemplate(v)])),
      routes,
    };
    writeFileSync(out, JSON.stringify(body, null, 1) + "\n");
  };
}
