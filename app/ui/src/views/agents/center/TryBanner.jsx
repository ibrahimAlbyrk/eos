import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { AgentName } from "../../../lib/agentName.js";

// Active-try deck — one card per worker whose changes are applied as unstaged
// edits in the user's checkout, stacked newest-on-top. Keep/Discard act on the
// front card; resolving it brings the card behind forward. State is
// daemon-persisted (survives app reopen and worker deletion), so we always
// restore from /try/state rather than trusting the event window.
export function TryDeck({ live, selected }) {
  const selectedId = selected?.id ?? null;
  const changeTick = live.eventSignal.changeTick;
  const [tries, setTries] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // try_applied / try_kept / try_discarded ride worker:change → changeTick —
  // but a hub Apply stamps the CHILD's worker id while the orchestrator is
  // selected, so any worker change voids every answer kept here, and the shown
  // one is asked again (debounced). Until then showing an agent again reuses
  // its answer.
  const tickRef = useRef(changeTick);
  tickRef.current = changeTick;
  const answers = useRef({ tick: changeTick, byId: new Map() });

  const refresh = useCallback(async ({ cached = false } = {}) => {
    if (!selectedId) { setTries([]); return; }
    if (answers.current.tick !== tickRef.current) answers.current = { tick: tickRef.current, byId: new Map() };
    const kept = answers.current.byId;
    if (cached && kept.has(selectedId)) { setTries(kept.get(selectedId)); return; }
    const r = await api.getTryState(selectedId);
    kept.set(selectedId, r.activeTries ?? []);
    setTries(r.activeTries ?? []);
  }, [selectedId]);

  useEffect(() => { setError(null); refresh({ cached: true }); }, [refresh]);

  const seenTick = useRef(changeTick);
  useEffect(() => {
    if (!selectedId || changeTick === seenTick.current) return;
    seenTick.current = changeTick;
    const t = setTimeout(refresh, 300);
    return () => clearTimeout(t);
  }, [changeTick, selectedId, refresh]);

  if (!selected || tries.length === 0) return null;

  // Newest layer = front of the deck; only it can be discarded safely, so it
  // alone carries the buttons.
  const front = tries[tries.length - 1];
  const back = tries.slice(0, -1);
  const owner = live.workers.find((w) => w.id === front.workerId) ?? { name: front.workerId };
  const n = front.files.length;

  const act = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn(selected.id, front.workerId);
      if (!r.ok) {
        const b = r.body ?? {};
        setError(
          b.reason === "user-edited"
            ? `You edited ${b.files?.length ?? "some"} of the tried files (${(b.files ?? []).slice(0, 3).join(", ")}${(b.files?.length ?? 0) > 3 ? "…" : ""}). Commit, stash, or revert your edits, then retry.`
            : b.reason === "blocked-by-overlay"
              ? `Another try on top touches the same files (${(b.files ?? []).slice(0, 3).join(", ")}). Resolve it first.`
              : b.error ?? b.reason ?? `failed (${r.status})`,
        );
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="try-deck">
      {back.map((t, i) => {
        const depth = back.length - i;
        return (
          <div
            key={t.workerId}
            className="try-banner try-card-back"
            style={{ transform: `translateY(${-6 * depth}px) scale(${Math.max(0.86, 1 - 0.025 * depth)})`, zIndex: 1 - depth }}
            aria-hidden
          />
        );
      })}
      <div className="try-banner try-card-front">
        <div className="try-banner-row">
          <span className="try-dot" />
          <span className="try-text">
            Trying <b><AgentName worker={owner} /></b>’s changes — {front.branch} · {n} file{n === 1 ? "" : "s"} in your checkout
            {front.lockfileChanged && <span className="try-hint"> · lockfile changed, run npm install</span>}
          </span>
          <span className="try-grow" />
          {back.length > 0 && <span className="try-count">+{back.length} more</span>}
          <button className="try-btn try-keep" disabled={busy} onClick={() => act(api.tryKeep)}>
            Keep
          </button>
          <button className="try-btn try-discard" disabled={busy} onClick={() => act(api.tryDiscard)}>
            Discard
          </button>
        </div>
        {error && <div className="try-banner-err">{error}</div>}
      </div>
    </div>
  );
}
