// One-off scaffold for eos-contracts' route table: ROUTES of contracts/src/http.ts
// (names, path templates, which parameters the dashboard percent-encodes) joined
// with the methods the Node daemon really registers (the wire recorder's routes.json).
//
//   node rust/tools/zod-port/routes.mjs <repo> <recorder routes.json> <out .rs>

import { readFileSync, writeFileSync } from "node:fs";

const [repo, recorded, out] = process.argv.slice(2);
const { ROUTES } = await import(`${repo}/contracts/src/http.ts`);
const registered = JSON.parse(readFileSync(recorded, "utf8")).routes;

const norm = (t) => t.replace(/:[A-Za-z0-9_]+/g, ":");
const methodsOf = new Map();
for (const r of registered) {
  const k = norm(r.template);
  if (!methodsOf.has(k)) methodsOf.set(k, new Set());
  methodsOf.get(k).add(r.method);
}
// Keys that name a prefix or a family of routes rather than one registered pattern.
const FAMILY = {
  fsRaw: ["/fs/raw/*"], pdfjs: ["/pdfjs/*"], genuiMap: ["/api/genui/map/style.json", "/api/genui/map/t/:"], hostProxyPrefix: ["/h/:/*"],
  transferPause: ["/api/transfers/:/:"], transferResume: ["/api/transfers/:/:"], transferCancel: ["/api/transfers/:/:"], transferDecide: ["/api/transfers/:/:"],
};
// Served by the peer listener, not the daemon's router (manager/peer/PeerHostService.ts).
const PEER = { peerPair: ["POST"], peerReverse: ["POST"] };
const PREFIX = new Set(["fsRaw", "pdfjs", "genuiMap", "hostProxyPrefix"]);
const ORDER = ["GET", "POST", "PUT", "DELETE", "HEAD"];
const VARIANT = { GET: "Get", POST: "Post", PUT: "Put", DELETE: "Delete", HEAD: "Head" };
const screaming = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

const consts = [];
const names = [];
for (const [name, v] of Object.entries(ROUTES)) {
  let path = v, encoded = [];
  if (typeof v === "function") {
    const src = v.toString();
    const params = /^\(([^)]*)\)/.exec(src)[1].split(",").map((p) => p.trim().split(/[:\s]/)[0]).filter(Boolean);
    path = v(...params.map((p) => `:${p}`)).replace(/%3A/g, ":");
    encoded = params.filter((p) => src.includes(`encodeURIComponent(${p})`));
  }
  let methods = PEER[name] ?? [...(FAMILY[name] ?? [norm(path)]).flatMap((t) => [...(methodsOf.get(t) ?? [])])];
  methods = ORDER.filter((m) => methods.includes(m));
  if (!methods.length) throw new Error(`no method for ${name} ${path}`);
  const c = screaming(name);
  names.push(c);
  consts.push(
    `pub const ${c}: Route = Route::new(${JSON.stringify(name)}, ${JSON.stringify(path)}, &[${methods.map((m) => VARIANT[m]).join(", ")}])` +
      (encoded.length ? `.encoding(&[${encoded.map((e) => JSON.stringify(e)).join(", ")}])` : "") + (PREFIX.has(name) ? ".as_prefix()" : "") + ";",
  );
}
writeFileSync(out, `//! The route table: \`ROUTES\` of \`contracts/src/http.ts\`, with the methods each path answers.

use super::Method::{Delete, Get, Head, Post, Put};
use super::Route;

${consts.join("\n")}

/// Every route, in the order of \`ROUTES\`.
pub const ROUTES: &[Route] = &[\n${names.map((n) => `    ${n},`).join("\n")}\n];
`);
console.log(`routes: ${names.length}`);
