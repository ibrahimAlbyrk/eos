import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api/client.js";

// Active-try banner — shown while a worker's changes are applied as unstaged
// edits in the user's checkout. State is daemon-persisted (survives app
// reopen and worker deletion), so we always restore from /try/state rather
// than trusting the event window.
export function TryBanner({ live, selected }) {
  const selectedId = selected?.id ?? null;
  const [activeTry, setActiveTry] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!selectedId) { setActiveTry(null); return; }
    const r = await api.getTryState(selectedId);
    setActiveTry(r.activeTry ?? null);
  }, [selectedId]);

  useEffect(() => { setError(null); refresh(); }, [refresh]);

  // try_applied / try_kept / try_discarded ride worker:change → eventSignal —
  // but a hub Apply stamps the CHILD's worker id while the orchestrator is
  // selected, so don't filter on the selected id; refresh (debounced) on any
  // tick. /try/state is a trivial file read.
  useEffect(() => {
    if (!selectedId) return;
    const t = setTimeout(refresh, 300);
    return () => clearTimeout(t);
  }, [live.eventSignal.tick, selectedId, refresh]);

  if (!selected || !activeTry) return null;

  const ownerName = live.workers.find((w) => w.id === activeTry.workerId)?.name ?? activeTry.workerId;
  const n = activeTry.files.length;

  const act = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn(selected.id);
      if (!r.ok) {
        const b = r.body ?? {};
        setError(
          b.reason === "user-edited"
            ? `You edited ${b.files?.length ?? "some"} of the tried files (${(b.files ?? []).slice(0, 3).join(", ")}${(b.files?.length ?? 0) > 3 ? "…" : ""}). Commit, stash, or revert your edits, then retry.`
            : b.error ?? b.reason ?? `failed (${r.status})`,
        );
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="try-banner">
      <div className="try-banner-row">
        <span className="try-dot" />
        <span className="try-text">
          Trying <b>{ownerName}</b>’s changes — {activeTry.branch} · {n} file{n === 1 ? "" : "s"} in your checkout
          {activeTry.lockfileChanged && <span className="try-hint"> · lockfile changed, run npm install</span>}
        </span>
        <span className="try-grow" />
        <button className="try-btn try-keep" disabled={busy} onClick={() => act(api.tryKeep)}>
          Keep
        </button>
        <button className="try-btn try-discard" disabled={busy} onClick={() => act(api.tryDiscard)}>
          Discard
        </button>
      </div>
      {error && <div className="try-banner-err">{error}</div>}
    </div>
  );
}
