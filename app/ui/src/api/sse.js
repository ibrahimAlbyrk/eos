// SSE wrapper with reconnect-on-error. The native EventSource auto-retries
// for transport drops, but if the daemon restarts mid-session it can fail
// to recover cleanly. We watch onerror and explicitly tear down + recreate
// after a backoff window.

import { api } from "./client.js";

const MAX_BACKOFF_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 50;

export function createReconnectingStream(handlers) {
  let es = null;
  let reconnectTimer = null;
  let closed = false;
  let backoffMs = 1000;
  let attempts = 0;

  function attach() {
    if (closed) return;
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(`[SSE] max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
      handlers.onClose?.();
      return;
    }
    try {
      es = api.newEventStream();
    } catch {
      schedule();
      return;
    }
    es.onopen = () => {
      backoffMs = 1000;
      attempts = 0;
      handlers.onOpen?.();
    };
    es.addEventListener("change", (e) => handlers.onChange?.(e));
    es.onmessage = (e) => handlers.onMessage?.(e);
    es.onerror = () => {
      handlers.onClose?.();
      try { es?.close(); } catch {}
      es = null;
      // EventSource sets its own backoff via `retry:` but on hard daemon
      // restarts the native retry sometimes doesn't fire — schedule an
      // explicit reconnect as a safety net.
      schedule();
    };
  }

  function schedule() {
    if (closed || reconnectTimer) return;
    attempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      attach();
    }, backoffMs);
  }

  attach();

  return {
    close() {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { es?.close(); } catch {}
      es = null;
    },
  };
}
