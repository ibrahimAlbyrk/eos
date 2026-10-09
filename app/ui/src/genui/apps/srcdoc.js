// The document an agent-authored app (present_app) runs as: our CSP first,
// then the theme, then the bridge, then the agent's markup. It loads into an
// <iframe srcdoc> sandboxed to allow-scripts + allow-forms — an opaque origin
// with no network (connect-src 'none'), no navigation of the window above it,
// no popups and no storage shared with Eos. Pure string work, so it is
// unit-tested without a DOM.

import { themeCss } from "./theme.js";

// Never add allow-same-origin (the app would share Eos's origin and could reach
// the dashboard's DOM and storage), allow-top-navigation or allow-popups.
export const APP_SANDBOX = "allow-scripts allow-forms";

// Permissions Policy for the frame: an opaque origin already gets none of these
// by default; spelling it out keeps it that way whatever the shell grants.
export const APP_ALLOW = [
  "camera 'none'",
  "microphone 'none'",
  "geolocation 'none'",
  "display-capture 'none'",
  "clipboard-read 'none'",
  "clipboard-write 'none'",
  "payment 'none'",
  "usb 'none'",
  "serial 'none'",
  "hid 'none'",
  "fullscreen 'none'",
].join("; ");

// Inline code and styles run; nothing loads from or talks to the network. Media
// may play from data:/blob: (a timer's chime) — that never leaves the frame.
// Also the frame's csp attribute (CSP Embedded Enforcement): the sandbox still
// lets a frame navigate itself, and the window's frame-src admits loopback, so
// without it an app could load a daemon URL into its own frame. With it, any
// page that hasn't opted into this policy is refused.
export const APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export const APP_PROTOCOL_VERSION = "2026-01-26";

// window.eos inside the app — a thin client over the MCP Apps postMessage
// protocol (JSON-RPC 2.0), so a plain app needs no SDK and an SDK app still
// works: send(text) → ui/message (the user confirms), openLink(url) →
// ui/open-link, resize(h) → ui/notifications/size-changed. Without a declared
// height the bridge reports the content height on its own (measured at
// max-content, so the frame can shrink too, and stopped once the content turns
// out to follow the viewport); resize() turns that off. Must never contain a
// closing script tag.
function bridgeScript(autoResize) {
  return `(() => {
"use strict";
const host = window.parent;
if (!host || host === window) return;
let seq = 0, manual = ${autoResize ? "false" : "true"}, last = 0, queued = false, dirty = true, lastVh = window.innerHeight;
const waiting = new Map();
const post = (m) => { try { host.postMessage(m, "*"); } catch (e) {} };
const request = (method, params) => new Promise((resolve, reject) => {
  const id = "eos:" + (++seq);
  waiting.set(id, { resolve, reject });
  post({ jsonrpc: "2.0", id, method, params });
});
const notify = (method, params) => post({ jsonrpc: "2.0", method, params });
const width = () => document.documentElement.clientWidth;
const measure = () => {
  const de = document.documentElement, prev = de.style.height;
  de.style.height = "max-content";
  const h = Math.ceil(de.getBoundingClientRect().height);
  de.style.height = prev;
  return h;
};
const report = () => {
  queued = false;
  if (manual) return;
  const h = measure(), vh = window.innerHeight;
  // Taller after a frame resize with no DOM change: the content follows the
  // viewport (100vh + more) and would grow the frame to the max — stop here.
  if (!dirty && vh !== lastVh && h > last) { manual = true; return; }
  dirty = false;
  lastVh = vh;
  if (h > 0 && h !== last) { last = h; notify("ui/notifications/size-changed", { width: width(), height: h }); }
};
const schedule = () => { if (!queued && !manual) { queued = true; requestAnimationFrame(report); } };
const changed = (ctx) => window.dispatchEvent(new CustomEvent("eos:hostcontext", { detail: ctx }));
const eos = {
  hostContext: null,
  send(text) { return request("ui/message", { role: "user", content: [{ type: "text", text: String(text) }] }); },
  openLink(url) { return request("ui/open-link", { url: String(url) }); },
  resize(height) {
    manual = true;
    const h = Math.round(Number(height));
    if (h > 0) notify("ui/notifications/size-changed", { width: width(), height: h });
  },
};
window.eos = eos;
window.addEventListener("message", (e) => {
  if (e.source !== host) return;
  const m = e.data;
  if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
  if (!("method" in m) && waiting.has(m.id)) {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.error) w.reject(new Error(String(m.error.message || "request failed")));
    else w.resolve(m.result);
    return;
  }
  if (m.method === "ui/notifications/host-context-changed" && m.params && typeof m.params === "object") {
    eos.hostContext = Object.assign({}, eos.hostContext, m.params);
    changed(eos.hostContext);
  }
});
request("ui/initialize", {
  appInfo: { name: "eos-app", version: "1" },
  appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
  protocolVersion: "${APP_PROTOCOL_VERSION}",
}).then((r) => {
  eos.hostContext = (r && r.hostContext) || null;
  notify("ui/notifications/initialized", {});
  changed(eos.hostContext);
}, () => {});
if (!manual && typeof ResizeObserver === "function") {
  const de = document.documentElement;
  // measure() restyling the root element is not a content change
  new MutationObserver((records) => {
    if (records.some((r) => !(r.target === de && r.attributeName === "style"))) dirty = true;
  }).observe(de, { subtree: true, childList: true, attributes: true, characterData: true });
  const ro = new ResizeObserver(schedule);
  ro.observe(de);
  document.addEventListener("DOMContentLoaded", () => { if (document.body) ro.observe(document.body); schedule(); });
  window.addEventListener("load", schedule);
}
})();`;
}

// A start tag's attribute run, quoted values allowed to hold ">".
const ATTRS = String.raw`((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?)*)\s*/?>`;
const LEAD_RE = /^\uFEFF?(?:\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?/i;
const HTML_OPEN_RE = new RegExp(String.raw`<html${ATTRS}`, "i");
const HEAD_RE = new RegExp(String.raw`<head${ATTRS}([\s\S]*?)</head\s*>`, "i");
const BODY_OPEN_RE = new RegExp(String.raw`<body${ATTRS}`, "i");
const HTML_CLOSE_RE = /<\/html\s*>/gi;
const BODY_CLOSE_RE = /<\/body\s*>/gi;
// Every http-equiv attribute in the app's markup — its own CSP (it could only
// narrow ours, but ours stays the one policy), a refresh that would navigate
// the frame. Matched as a bare token (after whitespace, "/" or a quote, before
// "=") rather than per <meta> tag: linear, and the parser accepts all three
// separators. Script can still build one; the sandbox and the window's CSP are
// the real walls, this only keeps the static markup honest.
const HTTP_EQUIV_RE = /(?<=[\s/"'])http-equiv(?=\s*=)/gi;

const defuse = (s) => s.replace(HTTP_EQUIV_RE, "data-eos-dropped-http-equiv");

// Split the agent's markup into its <html> attributes, head content, <body>
// attributes and body content. A fragment is all body. Anything this misses
// still lands inside our <body>, where the HTML parser's own recovery merges a
// stray <html>/<body> tag's attributes and ignores a stray <head> — the CSP is
// already in force by then either way.
export function splitDocument(html) {
  let rest = String(html ?? "").replace(LEAD_RE, "");
  let htmlAttrs = "";
  let head = "";
  let bodyAttrs = "";

  const htmlOpen = HTML_OPEN_RE.exec(rest);
  if (htmlOpen) {
    htmlAttrs = htmlOpen[1] ?? "";
    rest = rest.slice(0, htmlOpen.index) + rest.slice(htmlOpen.index + htmlOpen[0].length);
  }
  const headMatch = HEAD_RE.exec(rest);
  if (headMatch) {
    head = headMatch[2] ?? "";
    rest = rest.slice(0, headMatch.index) + rest.slice(headMatch.index + headMatch[0].length);
  }
  const bodyOpen = BODY_OPEN_RE.exec(rest);
  if (bodyOpen) {
    bodyAttrs = bodyOpen[1] ?? "";
    rest = rest.slice(0, bodyOpen.index) + rest.slice(bodyOpen.index + bodyOpen[0].length);
  }
  const body = rest.replace(BODY_CLOSE_RE, "").replace(HTML_CLOSE_RE, "").trim();
  return { htmlAttrs, head: head.trim(), bodyAttrs, body };
}

// The full srcdoc. `autoResize` = the app declared no height, so the bridge
// sizes the frame to the content.
export function buildSrcdoc(html, { autoResize = true } = {}) {
  const doc = splitDocument(html);
  return [
    "<!doctype html>",
    `<html${doc.htmlAttrs}>`,
    "<head>",
    `<meta http-equiv="Content-Security-Policy" content="${APP_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style data-eos-theme>${themeCss()}</style>`,
    `<script data-eos-bridge>${bridgeScript(autoResize)}</script>`,
    defuse(doc.head),
    "</head>",
    `<body${doc.bodyAttrs}>`,
    defuse(doc.body),
    "</body>",
    "</html>",
  ].join("\n");
}
