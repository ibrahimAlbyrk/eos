// SSE wrapper with reconnect-on-error. The native EventSource auto-retries
// for transport drops, but if the daemon restarts mid-session it can fail
// to recover cleanly. We watch onerror and explicitly tear down + recreate
// after a backoff window. It never gives up, and the backoff stays short, so
// the dashboard is live again within a few seconds of a daemon restart.
//
// Every reconnect resumes from the last event id seen: the daemon replays what
// was missed, or sends `resync` when it can't (restarted, or the gap outgrew its
// buffer) — then onResync tells the caller to refetch its state.

import { api } from "./client.js";

// First retry fast: a restarted daemon is listening again in well under a second.
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5_000;

export function createReconnectingStream(handlers) {
  let es = null;
  let reconnectTimer = null;
  let closed = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let lastEventId = null;

  const track = (e) => { if (e.lastEventId) lastEventId = e.lastEventId; };

  function attach() {
    if (closed) return;
    try {
      es = api.newEventStream(lastEventId);
    } catch {
      schedule();
      return;
    }
    es.onopen = () => {
      backoffMs = INITIAL_BACKOFF_MS;
      handlers.onOpen?.();
    };
    es.addEventListener("hello", track);
    es.addEventListener("resync", (e) => { track(e); handlers.onResync?.(); });
    es.addEventListener("change", (e) => { track(e); handlers.onChange?.(e); });
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
