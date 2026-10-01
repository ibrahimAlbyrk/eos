// notify — the imperative facade every producer imports. Components (and
// non-React code: api/client.js, SSE handlers, store catch blocks) depend on
// this stable set of verbs, never on the toastStore internals behind it.
//
//   notify.info("Worker spawned");
//   notify.warning("Branch has conflicts");
//   const id = notify.error("Push failed", { title: "Git", duration: 6000 });
//   notify.dismiss(id);   // early, programmatic
//
// There is no in-app surface (visible toasts were removed in the charcoal-aurora
// redesign). Errors and warnings go to macOS as native notifications through the
// desktop shell's eosNotify bridge — shown only while Eos is in the background —
// and to the console. Info stays silent so routine feedback ("Path copied") never
// lands in Notification Center. Without the bridge (plain browser, a controlled
// computer's view) only the console sees them.

function toMac(title, message) {
  globalThis.eosNotify?.show({ title, body: String(message) });
}

export const notify = {
  info: () => undefined,
  warning: (message, opts) => {
    console.warn("[notify]", message);
    toMac(opts?.title ?? "Warning", message);
    return undefined;
  },
  error: (message, opts) => {
    console.error("[notify]", message);
    toMac(opts?.title ?? "Error", message);
    return undefined;
  },
  dismiss: () => {},
  clear: () => {},
};
