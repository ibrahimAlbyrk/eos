import { useEffect, useState } from "react";
import { useDreams, refreshDreamLog, setDreamExclusion } from "../../state/dreamStore.js";
import { useUserMemories } from "../../state/userMemoryStore.js";
import { CONTROLS } from "../../settings/controls.jsx";
import { DROPPED_LABELS, droppedTotal, fmtDreamTime, isDreamProposal, modelLabel, runSummary } from "../../lib/dreamProposals.js";
import { projectLabel } from "../../lib/memoryGroups.js";

const Toggle = CONTROLS.toggle;
const TRIGGER = { nightly: "Every night", away: "While you were away", manual: "Dream now" };

function RunDetail({ run, excluded, waiting }) {
  return (
    <div className="dr-log__detail">
      <header className="dr-log__head">
        <h2>{fmtDreamTime(run.startedAt)}</h2>
        <span>{[TRIGGER[run.trigger], modelLabel(run.model), run.tokens ? `~${Math.round(run.tokens / 1000)}k tokens` : null].filter(Boolean).join(" · ")}</span>
      </header>
      {run.reason && <p className={`dr-log__reason${run.status === "failed" ? " is-err" : ""}`}>{run.reason}</p>}
      {run.status !== "skipped" && (
        <div className="dr-log__stats">
          <span><b>{run.chatsRead}</b>chats read</span>
          <span><b>{run.observations}</b>things noticed</span>
          <span><b>{run.candidates ?? 0}</b>gathering support</span>
          <span><b className="dr-violet">{run.proposed}</b>proposed{waiting ? ` · ${waiting} waiting` : ""}</span>
        </div>
      )}
      {run.chats.length > 0 && (
        <section className="mem-card dr-log__chats">
          <span className="dr-log__section">
            <b>Chats it read</b>
            <span>Turn a chat off and no dream reads it again</span>
          </span>
          {run.chats.map((c) => {
            const on = !excluded.includes(c.workerId);
            return (
              <div key={c.workerId} className="dr-log__chat">
                <span className={`mono dr-log__chatname${on ? "" : " is-off"}`}>{c.name}</span>
                <span className="dr-log__chatmeta">{c.project ? projectLabel(c.project) : "No folder"} · {c.userTurns} turns · {on ? `${c.observations} noticed` : "won't be read"}</span>
                <Toggle value={on} onChange={(v) => void setDreamExclusion(c.workerId, !v)} />
              </div>
            );
          })}
        </section>
      )}
      {droppedTotal(run) > 0 && (
        <section className="mem-card">
          <span className="dr-log__section"><b>Didn’t pass the bar · {droppedTotal(run)}</b></span>
          {DROPPED_LABELS.filter(([k]) => run.dropped[k] > 0).map(([k, label]) => (
            <span key={k} className={`dr-log__dropped${k === "secret" ? " is-warn" : ""}`}><span>{label}</span><span className="mono">{run.dropped[k]}</span></span>
          ))}
        </section>
      )}
      {run.rejected?.length > 0 && (
        <section className="mem-card">
          <span className="dr-log__section"><b>Turned down before your review · {run.rejected.length}</b></span>
          {run.rejected.map((r, i) => (
            <span key={i} className="dr-log__rejected"><span>{r.text}</span><span>{r.reason}</span></span>
          ))}
        </section>
      )}
    </div>
  );
}

// The dream log (a Memory page): every night, what it read, what it found, why
// things were dropped — and a switch to keep a chat out of every future dream.
export function DreamLog() {
  const { runs, excluded } = useDreams();
  const { memories } = useUserMemories();
  const [selected, setSelected] = useState(null);
  useEffect(() => { void refreshDreamLog(); }, []);

  if (!runs) return <div className="stg-empty">Loading the dream log…</div>;
  if (!runs.length) {
    return (
      <div className="mem-empty">
        <b>No dreams yet.</b>
        <span>Turn Dreaming on in Settings › Profile, or press Dream now. Each night shows up here.</span>
      </div>
    );
  }
  const run = runs.find((r) => r.id === selected) ?? runs[0];
  const waiting = (memories ?? []).filter((m) => isDreamProposal(m) && m.source.dreamId === run.id).length;

  return (
    <div className="dr-log">
      <nav className="dr-log__runs" aria-label="Dreams">
        {runs.map((r) => (
          <button key={r.id} type="button" className={`dr-log__run${r.id === run.id ? " is-on" : ""}`} aria-current={r.id === run.id} onClick={() => setSelected(r.id)}>
            <span className="dr-log__runtop">
              <span>{fmtDreamTime(r.startedAt)}</span>
              <span className={`dr-log__badge dr-log__badge--${r.status}`}>{r.status === "done" ? `${r.proposed} proposed` : r.status === "skipped" ? "Skipped" : r.status === "stopped" ? "Stopped" : r.status === "failed" ? "Failed" : "Running"}</span>
            </span>
            <span className="dr-log__runsub">{runSummary(r)}</span>
          </button>
        ))}
      </nav>
      <RunDetail run={run} excluded={excluded} waiting={waiting} />
    </div>
  );
}
