import { useEffect, useState } from "react";
import { fmtUsd } from "../../../lib/format.js";
import { ensureRunsLoaded, loadMoreRuns, loadRuns, useRuns } from "../../../state/eos/runsStore.js";
import { Loading, LoadFailed } from "../capabilities/parts.jsx";
import { openLocation } from "../nav/eosNav.js";
import { ORIGIN_FILTERS, stateChip } from "../run/words.js";

export const runLocation = (id) => `eos:/runs/${encodeURIComponent(id)}`;

// One run as a row: its item, its headline, its state in words and its cost.
// Item titles come from outside: React text only.
export function RunRow({ run, now }) {
  return (
    <li className="eos-run-row">
      <button type="button" className="eos-run-row__open" onClick={() => openLocation(runLocation(run.id))}>
        <span className="eos-run-row__title">{run.itemTitle ?? "Run"}</span>
        <span className="eos-run-row__line">{run.headline ?? ""}</span>
        <span className="eos-run-row__side">{stateChip(run, now).text}</span>
        <span className="eos-run-row__side">{fmtUsd(run.costUsd)}</span>
      </button>
    </li>
  );
}

function OriginFilter({ origins, origin, onChange }) {
  return (
    <div className="eos-seg" role="radiogroup" aria-label="Show runs">
      {[["all", "All"], ...origins.map((o) => [o, ORIGIN_FILTERS[o] ?? o])].map(([key, label]) => (
        <button key={key} type="button" role="radio" aria-checked={origin === key} className="eos-seg__opt" onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

// The Runs tab: every run of the routine, newest first, 50 a page, filtered
// by where they came from.
export function RoutineRuns({ routineId }) {
  const page = useRuns().pages[routineId];
  const [origin, setOrigin] = useState("all");
  useEffect(() => { ensureRunsLoaded(routineId); }, [routineId]);

  const runs = page?.runs;
  if (!runs) return page?.failed ? <LoadFailed what="runs" retry={() => void loadRuns(routineId)} /> : <Loading />;
  const origins = [...new Set(runs.map((r) => r.origin))];
  const shown = origin === "all" ? runs : runs.filter((r) => r.origin === origin);
  const now = Date.now();
  return (
    <div className="eos-routine__section">
      {origins.length > 1 && <OriginFilter origins={origins} origin={origin} onChange={setOrigin} />}
      {shown.length === 0 ? (
        <p className="eos-note">No runs yet.</p>
      ) : (
        <ul className="eos-card eos-runs">{shown.map((r) => <RunRow key={r.id} run={r} now={now} />)}</ul>
      )}
      {page.failed && <LoadFailed what="more runs" retry={() => void loadMoreRuns(routineId)} />}
      {page.nextBefore != null && !page.failed && (
        <div className="eos-actions"><button type="button" className="eos-btn" onClick={() => void loadMoreRuns(routineId)}>Show more</button></div>
      )}
    </div>
  );
}
