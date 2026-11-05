// Every plugin the daemon knows (GET /api/plugins), kept fresh from
// plugins:change. The runtime loads what this says; Settings › Plugins shows it.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { onResync, onTopic } from "../lib/liveTopics.js";

let plugins = [];
let installs = {};
let loaded = false;
const subs = new Set();
let seq = 0;

function emit() {
  for (const cb of subs) cb();
}

export function subscribePlugins(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getPlugins() {
  return plugins;
}

export function getPlugin(id) {
  return plugins.find((p) => p.id === id) ?? null;
}

export async function refreshPlugins() {
  const mine = ++seq;
  try {
    const body = await api.listPlugins();
    if (mine !== seq) return;
    plugins = body.plugins;
    installs = body.installs;
    loaded = true;
    emit();
  } catch {}
}

let started = false;
// Loads the list once and follows every change after.
export function ensurePluginsLoaded() {
  if (started) return;
  started = true;
  onTopic("plugins:change", () => void refreshPlugins());
  onResync(() => void refreshPlugins());
  void refreshPlugins();
}

export function usePlugins() {
  return useSyncExternalStore(subscribePlugins, getPlugins, getPlugins);
}

// Where an installed plugin came from (npm, git, a folder), or null for one
// made on this Mac.
export function usePluginInstall(id) {
  const get = () => installs[id] ?? null;
  return useSyncExternalStore(subscribePlugins, get, get);
}

export const pluginsLoaded = () => loaded;

// Settings › Plugins writes; the list itself refreshes from plugins:change.
export async function setPluginEnabled(id, enabled) {
  const r = await api.setPluginEnabled(id, enabled);
  if (!r.ok) throw new Error(r.body?.error ?? `couldn't turn ${id} ${enabled ? "on" : "off"}`);
  await refreshPlugins();
}

export async function setPluginSettings(id, values) {
  const r = await api.setPluginSettings(id, values);
  if (!r.ok) throw new Error(r.body?.error ?? `couldn't save ${id}'s settings`);
  await refreshPlugins();
}

// Whether a built-in plugin is on — true until the daemon says otherwise.
export function useBuiltinOn(id) {
  const get = () => getPlugin(id)?.enabled ?? true;
  return useSyncExternalStore(subscribePlugins, get, get);
}

export const isBuiltinOn = (id) => getPlugin(id)?.enabled ?? true;
