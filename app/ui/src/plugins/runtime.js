// Loads every active plugin's UI into this window and keeps it in step with the
// daemon: a new build (a file changed) unloads the old version — everything it
// added to the UI goes with it — and activates the new one, in place, with no
// reload. A plugin's UI is an ES module whose default export is
// `activate(eos)`; `eos` (pluginApi.js) is how it adds to the UI.
//
// React is shared: plugin builds import the dashboard's own copy through
// globalThis.__eosShared (see infra EsbuildPluginBuilder), so hooks and context
// work across the boundary.

import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import { ensurePluginsLoaded, getPlugins, subscribePlugins } from "./pluginsStore.js";
import { createPluginApi } from "./pluginApi.js";
import { reportPlugin } from "./report.js";

globalThis.__eosShared = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react/jsx-dev-runtime": jsxRuntime,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
};

// id → { rev, dispose } for what's loaded, and the latest problem per plugin
// (shown in Settings › Plugins).
const loaded = new Map();
const loading = new Map(); // id → rev being loaded
const faults = new Map(); // id → { rev, message }
const faultSubs = new Set();

export function pluginFault(id) {
  return faults.get(id) ?? null;
}

export function subscribePluginFaults(cb) {
  faultSubs.add(cb);
  return () => faultSubs.delete(cb);
}

function setFault(id, fault) {
  if (fault) faults.set(id, fault);
  else if (!faults.delete(id)) return;
  for (const cb of faultSubs) cb();
}

const buildUrl = (id, rev, ext) => new URL(`plugins/${encodeURIComponent(id)}/${rev}.${ext}`, document.baseURI).href;

function unload(id) {
  const cur = loaded.get(id);
  if (!cur) return;
  loaded.delete(id);
  cur.dispose();
}

async function load(plugin) {
  const { id, rev } = plugin;
  loading.set(id, rev);
  const disposers = [];
  const dispose = () => {
    for (const fn of disposers.splice(0).reverse()) {
      try { fn(); } catch (e) { console.error(`Plugin "${id}" cleanup failed:`, e); }
    }
  };
  try {
    if (plugin.hasCss) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = buildUrl(id, rev, "css");
      link.dataset.plugin = id;
      document.head.appendChild(link);
      disposers.push(() => link.remove());
    }
    const mod = await import(/* @vite-ignore */ buildUrl(id, rev, "js"));
    // A newer build arrived while this one loaded — it takes over.
    if (loading.get(id) !== rev) { dispose(); return; }
    const activate = mod.default;
    if (typeof activate !== "function") throw new Error("the UI entry must `export default function activate(eos) { … }`");
    const cleanup = await activate(createPluginApi(plugin, disposers));
    if (typeof cleanup === "function") disposers.push(cleanup);
    if (loading.get(id) !== rev) { dispose(); return; }
    unload(id);
    loaded.set(id, { rev, dispose });
    setFault(id, null);
    reportPlugin(id, { rev, ok: true });
  } catch (e) {
    dispose();
    console.error(`Plugin "${id}" failed to load:`, e);
    const message = e instanceof Error ? e.message : String(e);
    setFault(id, { rev, message });
    reportPlugin(id, { rev, ok: false, error: describeError(e) });
  } finally {
    if (loading.get(id) === rev) loading.delete(id);
  }
}

function describeError(e) {
  if (!(e instanceof Error)) return String(e);
  return e.stack && e.stack.includes(e.message) ? e.stack.split("\n").slice(0, 6).join("\n") : `${e.message}\n${e.stack ?? ""}`.trim();
}

function reconcile() {
  const want = new Map(getPlugins().filter((p) => p.hasUi && p.rev > 0).map((p) => [p.id, p]));
  for (const id of [...loaded.keys()]) if (!want.has(id)) unload(id);
  for (const id of [...faults.keys()]) if (!want.has(id)) setFault(id, null);
  for (const [id, p] of want) {
    if (loaded.get(id)?.rev === p.rev || loading.get(id) === p.rev) continue;
    // The last good version stays up until the new one is ready.
    void load(p);
  }
}

let started = false;
export function startPlugins() {
  if (started) return;
  started = true;
  subscribePlugins(reconcile);
  ensurePluginsLoaded();
}
