// notify — the imperative facade every producer imports. Components (and
// non-React code: api/client.js, SSE handlers, store catch blocks) depend on
// this stable set of verbs, never on the toastStore internals behind it.
//
//   notify.info("Worker spawned");
//   notify.warning("Branch has conflicts");
//   const id = notify.error("Push failed", { title: "Git", duration: 6000 });
//   notify.dismiss(id);   // early, programmatic
//
// The Agents mode has no in-app surface (visible toasts were removed in the
// charcoal-aurora redesign); while an Eos screen shows, it says every notice in
// place (views/eos/nav/Notices.jsx, through `listen`). Errors and warnings go to macOS as native notifications through the
// desktop shell's eosNotify bridge — shown only while Eos is in the background —
// and to the console. Info stays silent so routine feedback ("Path copied") never
// lands in Notification Center. Without the bridge (plain browser, a controlled
// computer's view) only the console sees them.

const listeners = new Set();

// Tells whoever listens (an Eos screen) about a notice: its tone, its words
// and the title it was given.
function tell(tone, message, opts) {
  for (const listener of listeners) listener({ tone, message: String(message), title: opts?.title ?? null });
}

function toMac(title, message) {
  globalThis.eosNotify?.show({ title, body: String(message) });
}

export const notify = {
  info: (message, opts) => {
    tell("info", message, opts);
    return undefined;
  },
  warning: (message, opts) => {
    console.warn("[notify]", message);
    tell("warning", message, opts);
    toMac(opts?.title ?? "Warning", message);
    return undefined;
  },
  error: (message, opts) => {
    console.error("[notify]", message);
    tell("error", message, opts);
    toMac(opts?.title ?? "Error", message);
    return undefined;
  },
  dismiss: () => {},
  // Hears every notice from now on; the answer stops hearing.
  listen: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  clear: () => {},
};
