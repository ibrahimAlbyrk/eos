import { useEffect } from "react";
import { useDreams, ensureDreamStatusLoaded, dreamNow, stopDream } from "../../state/dreamStore.js";
import { useProfile } from "../../state/profileStore.js";
import { setMemoryPage } from "../../state/memoryViewStore.js";
import { dreamStatusLine, fmtDreamTime, runSummary } from "../../lib/dreamProposals.js";
import { MoonIcon } from "./DreamProposal.jsx";

// While a dream runs: which chat it's reading, what it noticed so far, Stop.
export function DreamingNow() {
  const { status } = useDreams();
  if (!status?.running) return null;
  const p = status.progress;
  const pct = p?.total ? Math.round((p.done / p.total) * 100) : 6;
  return (
    <section className="dr-now" aria-label="Dreaming now" aria-live="polite">
      <div className="dr-now__head">
        <span className="dr-orbit" aria-hidden="true"><span className="dr-orbit__dot" /><span className="dr-orbit__core"><MoonIcon size={15} /></span></span>
        <span className="dr-now__titles">
          <b>Dreaming…</b>
          <span>{p?.chat ? <>Reading chat {Math.min(p.done + 1, p.total)} of {p.total} · <span className="mono">{p.chat}</span></> : "Weighing what it noticed"}</span>
        </span>
        <button type="button" className="mem-btn mem-btn--ghost" onClick={() => void stopDream()}>Stop</button>
      </div>
      <span className="dr-now__bar"><span style={{ width: `${pct}%` }} /></span>
      {p?.noticed?.length > 0 && (
        <ul className="dr-now__noticed">
          {p.noticed.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
      <p className="dr-now__note">It stops if you come back and picks up where it left off. Nothing changes until you review it.</p>
    </section>
  );
}

// The Memory rail's Dreaming card: where it stands, the last night, Dream now.
export function DreamingCard({ onOpenSettings }) {
  const { status, error } = useDreams();
  const { profile } = useProfile();
  useEffect(() => { ensureDreamStatusLoaded(); }, []);
  const s = profile?.dreaming;
  const last = status?.lastRun;
  const canDream = !status?.running && status?.blocked !== "sign-in";

  return (
    <section className="mem-card dr-card">
      <span className="mem-card__title">Dreaming</span>
      <span className="dr-card__line">
        <span className={`dr-card__icon${s?.enabled ? " is-on" : ""}`}><MoonIcon size={15} /></span>
        <span className="dr-card__text">
          <span>{dreamStatusLine(status, s)}</span>
          {last && <span className="dr-card__sub">Last · {fmtDreamTime(last.startedAt)} · {runSummary(last)}</span>}
        </span>
      </span>
      {error && <span className="mem-error">{error}</span>}
      <span className="dr-card__actions">
        {status?.running
          ? <button type="button" className="mem-btn mem-btn--ghost" onClick={() => void stopDream()}>Stop</button>
          : <button type="button" className="mem-btn mem-btn--ghost" disabled={!canDream} onClick={() => void dreamNow()}>Dream now</button>}
        <button type="button" className="prof-link-btn" onClick={() => setMemoryPage("log")}>Dream log</button>
        <button type="button" className="prof-link-btn" onClick={onOpenSettings}>{s?.enabled ? "Settings" : "Turn on"}</button>
      </span>
    </section>
  );
}
