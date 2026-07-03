// notify — the imperative facade every producer imports. Components (and
// non-React code: api/client.js, SSE handlers, store catch blocks) depend on
// this stable set of verbs, never on the toastStore internals behind it.
//
//   notify.info("Worker spawned");
//   notify.warning("Branch has conflicts");
//   const id = notify.error("Push failed", { title: "Git", duration: 6000 });
//   notify.dismiss(id);   // early, programmatic
//
// opts (all optional): { title, duration, dismissible }. push() returns the new
// toast id so a caller can dismiss/replace it later.

import { push, dismiss, clear } from "../state/toastStore.js";

export const notify = {
  info: (message, opts) => push({ severity: "info", message, ...opts }),
  warning: (message, opts) => push({ severity: "warning", message, ...opts }),
  error: (message, opts) => push({ severity: "error", message, ...opts }),
  dismiss,
  clear,
};
