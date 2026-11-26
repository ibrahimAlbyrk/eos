import { openLocation } from "../nav/eosNav.js";
import { Interruptions, RunStations } from "./RunStations.jsx";
import { isShownOnly, originLine, standingLine } from "./words.js";

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

// When the run started, as the label says it: the time today, else the day.
function startedWord(run, now) {
  const at = run.startedAt ?? run.createdAt;
  if (at == null) return null;
  return new Date(at).toDateString() === new Date(now).toDateString() ? clock.format(at) : `${day.format(at)}, ${clock.format(at)}`;
}

// The Needs-you item the run's result waits in, from its timeline.
const heldItem = (events) => events.findLast((e) => e.kind === "held")?.data?.itemId;

// The top of a run, as a routine's page leads: how it started as a label,
// its one sentence, where it stands now in a dimmer line (its tone's mark in
// the margin when it needs the user or broke), the facts about it, the one
// act its state asks for, then its stations on a line that runs on past the
// measure and fades.
export function RunLead({ detail, sentence, now, act }) {
  const { run } = detail;
  const standing = standingLine(detail, now);
  const itemId = run.state === "waiting_for_user" ? heldItem(detail.events) : undefined;
  const started = startedWord(run, now);
  return (
    <header className="eos-rlead eos-run-lead">
      <p className="eos-label">{[originLine(run.origin), started].filter(Boolean).join(" · ")}</p>
      <div>
        <p className="eos-run__sentence">{sentence}</p>
        {standing.text && (
          <p className={standing.tone ? `eos-rlead__now eos-rlead__now--${standing.tone}` : "eos-rlead__now"} role={standing.tone ? "status" : undefined}>
            {standing.text}
          </p>
        )}
      </div>
      {(isShownOnly(detail) || detail.events.some((e) => e.kind === "interrupted")) && (
        <div className="eos-run-lead__facts">
          {isShownOnly(detail) && <p className="eos-fact eos-run__shown">Shown to you only. Nothing will be sent from this run.</p>}
          <Interruptions events={detail.events} />
        </div>
      )}
      {(itemId || act) && (
        <div className="eos-rlead__acts">
          {itemId && <button type="button" className="eos-btn eos-btn--primary" onClick={() => openLocation(`eos:/needs/${encodeURIComponent(itemId)}`)}>Open it in Needs you</button>}
          {act}
        </div>
      )}
      <RunStations run={run} />
    </header>
  );
}

// The lead's ghost while the run is read: its label and two lines as bars,
// and the stations as hollow marks on a dashed line; after 300 ms.
export function RunLeadGhost() {
  return (
    <div className="eos-skeleton eos-rlead eos-rlead--ghost eos-run-lead" aria-busy="true" aria-label="Loading">
      <span className="eos-skeleton__label" />
      <span className="eos-rlead__bar" />
      <span className="eos-rlead__bar eos-rlead__bar--dim" />
      <div className="eos-stations-wrap" aria-hidden="true">
        <ol className="eos-stations">
          {Array.from({ length: 4 }, (_, i) => <li key={i} className="eos-station eos-station--todo"><span className="eos-station__mark" /></li>)}
        </ol>
      </div>
    </div>
  );
}

// A run Eos no longer holds, said as its lead, with the way back to its
// routines.
export function RunGone() {
  return (
    <header className="eos-rlead eos-run-lead">
      <p className="eos-label">Run</p>
      <div>
        <p className="eos-run__sentence">This run is no longer here.</p>
        <p className="eos-rlead__now">Eos keeps no record of it any more.</p>
      </div>
      <div className="eos-rlead__acts">
        <button type="button" className="eos-btn" onClick={() => openLocation("eos:/routines")}>Open Routines</button>
      </div>
    </header>
  );
}
