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

function parseData(e) {
  try { return JSON.parse(e.data); } catch { return null; }
}

export function createReconnectingStream(handlers) {
  let es = null;
  let reconnectTimer = null;
  let closed = false;
  let paused = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let lastEventId = null;

  const track = (e) => { if (e.lastEventId) lastEventId = e.lastEventId; };

  function attach() {
    if (closed || paused) return;
    try {
      es = api.newEventStream(lastEventId, handlers.query?.() ?? "");
    } catch {
      schedule();
      return;
    }
    es.onopen = () => {
      backoffMs = INITIAL_BACKOFF_MS;
      handlers.onOpen?.();
    };
    es.addEventListener("hello", (e) => { track(e); handlers.onHello?.(parseData(e)); });
    es.addEventListener("resync", (e) => { track(e); handlers.onResync?.(parseData(e)); });
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
    if (closed || paused || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      attach();
    }, backoffMs);
  }

  attach();

  return {
    // Off screen: drop the connection but keep the resume point — resume()
    // reconnects from it, so the daemon replays (or resyncs) what was missed.
    pause() {
      if (closed || paused) return;
      paused = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { es?.close(); } catch {}
      es = null;
      handlers.onPause?.();
    },
    resume() {
      if (closed || !paused) return;
      paused = false;
      backoffMs = INITIAL_BACKOFF_MS;
      attach();
    },
    close() {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { es?.close(); } catch {}
      es = null;
    },
  };
}
