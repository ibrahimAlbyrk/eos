import { useEffect, useState } from "react";
import { fmtUsd } from "../../../lib/format.js";
import { ensureRunsLoaded, loadMoreRuns, loadRuns, useRuns } from "../../../state/eos/runsStore.js";
import { Loading, LoadFailed } from "../capabilities/parts.jsx";
import { openLocation } from "../nav/eosNav.js";
import { ORIGIN_FILTERS, originLine, stateChip } from "../run/words.js";

export const runLocation = (id) => `eos:/runs/${encodeURIComponent(id)}`;

// An item title that starts with its number ("#470 Fix the login") split
// into the number and the rest, so the number can stand in its own column.
export function splitItemNumber(title) {
  const m = /^(#\d+)\s+(.+)$/.exec(title ?? "");
  return m ? { number: m[1], title: m[2] } : { number: null, title: title ?? "Run" };
}

const shortDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

// One run as a row (SystemDetail.dc.html's Recent runs): the item's number,
// its title, its headline, its state in its tone and its cost. A run with no
// numbered item stands its day in the number's column, and one with no item
// at all is named by how it started, so no row has a hole. Item titles come
// from outside: React text only.
export function RunRow({ run, now }) {
  const { number, title } = splitItemNumber(run.itemTitle);
  const chip = stateChip(run, now);
  const at = run.startedAt ?? run.createdAt;
  return (
    <li className="eos-run-row">
      <button type="button" className="eos-run-row__open" onClick={() => openLocation(runLocation(run.id))}>
        <span className="eos-run-row__num">{number ?? (at ? shortDay.format(at) : "")}</span>
        <span className="eos-run-row__title">{run.itemTitle ? title : originLine(run.origin)}</span>
        <span className="eos-run-row__line">{run.headline ?? ""}</span>
        <span className={"eos-run-row__state" + (chip.tone ? ` eos-run-row__state--${chip.tone}` : "")}>{chip.text}</span>
        <span className="eos-run-row__cost">{fmtUsd(run.costUsd)}</span>
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
        <ul className="eos-runs">{shown.map((r) => <RunRow key={r.id} run={r} now={now} />)}</ul>
      )}
      {page.failed && <LoadFailed what="more runs" retry={() => void loadMoreRuns(routineId)} />}
      {page.nextBefore != null && !page.failed && (
        <div className="eos-actions"><button type="button" className="eos-btn" onClick={() => void loadMoreRuns(routineId)}>Show more</button></div>
      )}
    </div>
  );
}
