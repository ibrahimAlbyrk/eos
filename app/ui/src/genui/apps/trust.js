// "Always for this app": the views whose messages go to the agent without the
// confirmation chip. Per viewer and per view id — a new present_app call is a
// new app and asks again. Browser storage can be missing or throw (private
// window, blocked site data), so every access is guarded and a failure means
// "ask".

const KEY = "eos:genui:appsAlwaysSend";
const MAX_ENTRIES = 500;

function readList() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function isAlwaysSend(viewId) {
  return typeof viewId === "string" && viewId !== "" && readList().includes(viewId);
}

export function setAlwaysSend(viewId, on) {
  if (typeof viewId !== "string" || !viewId) return;
  try {
    const list = readList().filter((id) => id !== viewId);
    if (on) list.push(viewId);
    globalThis.localStorage?.setItem(KEY, JSON.stringify(list.slice(-MAX_ENTRIES)));
  } catch {
    // storage unavailable — the choice lasts for this frame only
  }
}
