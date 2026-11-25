// eosSettingsStore — Settings › Eos (09 §4.5): each area's settings as its own
// route answers them, read when the pane opens, and the pane's writes. Every
// write answers the settings as they are then, which replace what is shown.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { notify } from "../../lib/notify.js";
import { transport } from "./transport.js";

// Each area: the route that reads and writes it, and whether a write sends
// only the changed fields (the others take the whole settings).
const AREAS = {
  routines: { path: ROUTES.routinesSettings, patch: true },
  signals: { path: ROUTES.signalsSettings },
  attention: { path: ROUTES.settingsAttention },
  memory: { path: ROUTES.memorySettings },
  surfaces: { path: ROUTES.settingsSurfaces },
};

// area → its settings, null until read. forgotten: how many notes the last
// "Forget everything" forgot, until undone.
const EMPTY = { routines: null, signals: null, attention: null, memory: null, surfaces: null, forgotten: null };
let state = EMPTY;
const subs = new Set();

function set(patch) {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const snapshot = () => state;

export function useEosSettings() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export async function loadEosSettings() {
  await Promise.all(Object.entries(AREAS).map(async ([area, { path }]) => {
    const r = await transport.get(path).catch(() => null);
    if (r?.ok && r.body) set({ [area]: r.body });
  }));
}

// A write's answer body, or null after telling why it did not go through.
async function write(method, path, body) {
  const r = await transport.send(method, path, body).catch(() => null);
  if (r?.ok) return r.body ?? {};
  notify.error(r?.body?.error ?? "Eos isn't reachable.", { title: "Settings" });
  return null;
}

export async function changeEosSetting(area, patch) {
  const { path, patch: partial } = AREAS[area];
  const next = await write("PUT", path, partial ? patch : { ...state[area], ...patch });
  if (next) set({ [area]: next });
}

// One notification to the paired iPhones → what to say about it, or null.
export async function sendTestPush() {
  const r = await write("POST", ROUTES.remotePushTest, {});
  if (!r) return null;
  if (r.sent > 0) return `Sent to ${r.sent === 1 ? "your iPhone" : `${r.sent} phones`}.`;
  return r.reason ?? "No iPhone takes notifications from this Mac yet.";
}

// Starts tidying memory now instead of tonight → what to say about it, or null.
export async function tidyMemoryNow() {
  const r = await write("POST", ROUTES.memoryTidy, {});
  if (!r) return null;
  return r.started ? "Tidying started. It shows under Jobs while it works." : "Tidying is under way already.";
}

export async function forgetAllLearned() {
  const r = await write("POST", ROUTES.memoryForgetAll, { confirm: true });
  if (r) set({ forgotten: r.forgotten ?? 0 });
}

export async function undoForgetAll() {
  if (await write("POST", ROUTES.memoryForgetAll, { undo: true })) set({ forgotten: null });
}

// Every live note as one JSON file in Downloads (the shell's save bridge), or
// a download in a browser tab.
export async function exportLearned() {
  const r = await transport.get(ROUTES.memoryExport).catch(() => null);
  if (!r?.ok) {
    notify.error("Eos could not export what it learned.", { title: "Settings" });
    return;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(r.body, null, 2));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const base64 = btoa(bin);
  const filename = "eos-memory.json";
  const save = globalThis.window?.webkit?.messageHandlers?.saveFile;
  if (save) {
    if ((await save.postMessage({ filename, base64, mimeType: "application/json" })) === false) {
      notify.error(`${filename} could not be saved in Downloads`, { title: "Settings" });
    }
    return;
  }
  const a = document.createElement("a");
  a.href = `data:application/json;base64,${base64}`;
  a.download = filename;
  a.click();
}

export function _resetEosSettings() {
  state = EMPTY;
}
