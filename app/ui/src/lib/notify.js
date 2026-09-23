// notify — the imperative facade every producer imports. Components (and
// non-React code: api/client.js, SSE handlers, store catch blocks) depend on
// this stable set of verbs, never on the toastStore internals behind it.
//
//   notify.info("Worker spawned");
//   notify.warning("Branch has conflicts");
//   const id = notify.error("Push failed", { title: "Git", duration: 6000 });
//   notify.dismiss(id);   // early, programmatic
//
// Visible toasts were removed from the app (charcoal-aurora redesign). This
// stays a no-op facade so the many existing call sites keep working without a
// visible surface; error/warning still reach the console so dev signal is not
// lost. Restores an on-screen surface later by re-pointing these verbs.

export const notify = {
  info: () => undefined,
  warning: (message) => { console.warn("[notify]", message); return undefined; },
  error: (message) => { console.error("[notify]", message); return undefined; },
  dismiss: () => {},
  clear: () => {},
};
