// Eos's fake host around an App under test (05 Q7). It runs in the probe's
// document, outside the App's frame: it answers the App's bridge as the
// dashboard would, records each call, refuses and reports any name the
// manifest does not declare, and resolves window.__eosAppTests with what
// the frame's harness reported, or with a finding when the App never got
// that far. Must never contain a closing script tag.
(() => {
"use strict";
const DECLARED = __DECLARED__;
const LOAD_MS = 5000;
const TESTS_MS = 20000;
// Looked up at each message: this script runs before the frame exists.
const frame = () => document.getElementById("eos-app");
const findings = [];
const refused = new Set();
let loaded = false, settle;
window.__eosAppTests = new Promise((resolve) => { settle = resolve; });
const finish = () => { if (settle) { settle({ findings }); settle = null; } };
const allowed = (name) => {
  if (name === "state.get" || name === "state.set") return true;
  if (name === "files.list" || name === "files.read") return DECLARED.filesRead || DECLARED.filesWrite;
  if (name === "files.write") return DECLARED.filesWrite;
  if (name.startsWith("query.")) return DECLARED.queries.includes(name.slice(6));
  return DECLARED.uses.includes(name);
};
const fake = (name) => {
  if (name === "state.get") return {};
  if (name === "files.list") return [];
  if (name === "files.read") return { path: "", text: "" };
  if (name.startsWith("query.")) return null;
  return { status: "done" };
};
const answer = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
window.addEventListener("message", (event) => {
  const app = frame();
  if (!app || event.source !== app.contentWindow) return;
  const m = event.data;
  if (!m || typeof m !== "object") return;
  const to = app.contentWindow;
  if (m.eosTest === "loaded") { loaded = true; return; }
  if (m.eosTest === "report") {
    if (Array.isArray(m.findings)) findings.push(...m.findings.filter((f) => f && typeof f.check === "string"));
    finish();
    return;
  }
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return;
  const asks = "id" in m && m.id !== undefined;
  const reply = (body) => { if (asks) to.postMessage(Object.assign({ jsonrpc: "2.0", id: m.id }, body), "*"); };
  const params = m.params && typeof m.params === "object" ? m.params : {};
  switch (m.method) {
    case "ui/initialize":
      reply({ result: { protocolVersion: "2026-01-26", hostContext: { theme: "dark", displayMode: "inline" } } });
      return;
    case "ui/notifications/initialized":
    case "ui/notifications/size-changed":
      return;
    case "ping":
    case "ui/open-link":
    case "ui/message":
    case "ui/request-display-mode":
      reply({ result: {} });
      return;
    case "tools/call": {
      const name = String(params.name || "");
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      if (!allowed(name)) {
        if (!refused.has(name)) {
          refused.add(name);
          findings.push({ check: "undeclared", detail: "calls `" + name + "`, which its manifest does not declare" });
        }
        reply({ error: { code: -32000, message: "not declared" } });
        return;
      }
      to.postMessage({ eosTest: "call", name, arguments: args }, "*");
      reply({ result: answer(fake(name)) });
      return;
    }
    default:
      reply({ error: { code: -32601, message: "method not found" } });
  }
});
setTimeout(() => {
  if (!loaded) { findings.push({ check: "load", detail: "did not load within 5 seconds" }); finish(); }
}, LOAD_MS);
setTimeout(() => {
  findings.push({ check: "load", detail: "its tests did not finish within 20 seconds" });
  finish();
}, LOAD_MS + TESTS_MS);
})();
