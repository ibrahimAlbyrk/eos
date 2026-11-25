import { useEffect, useState } from "react";
import { fmtUsd } from "../../../lib/format.js";
import { ensureRunsLoaded, loadMoreRuns, loadRuns, useRuns } from "../../../state/eos/runsStore.js";
import { Loading, LoadFailed } from "../capabilities/parts.jsx";
import { EmptyState } from "../frame.jsx";
import { openLocation } from "../nav/eosNav.js";
import { duration, ORIGIN_FILTERS, originLine, stateChip } from "../run/words.js";

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
    <section className="eos-routine__section" aria-label="Every run">
      <div className="eos-routine__head">
        <h2 className="eos-label">Every run</h2>
        {shown.length > 0 && <span className="eos-section__aside">{shown.length}{page.nextBefore != null ? "+" : ""}</span>}
      </div>
      {origins.length > 1 && <OriginFilter origins={origins} origin={origin} onChange={setOrigin} />}
      {shown.length === 0 ? (
        <EmptyState title="No runs yet.">Each run shows here with what it was about, how it went and what it cost.</EmptyState>
      ) : (
        <ul className="eos-runs">{shown.map((r) => <RunRow key={r.id} run={r} now={now} />)}</ul>
      )}
      {page.failed && <LoadFailed what="more runs" retry={() => void loadMoreRuns(routineId)} />}
      {page.nextBefore != null && !page.failed && (
        <div className="eos-actions"><button type="button" className="eos-btn" onClick={() => void loadMoreRuns(routineId)}>Show more</button></div>
      )}
    </section>
  );
}

// Beside every run: what this week cost and what a usual run takes, as the
// routine's row carries them. Nothing when it carries neither.
export function RunsWeek({ routine }) {
  const { stats, usual } = routine;
  const rows = [
    stats?.runs7d != null && ["Runs this week", String(stats.runs7d)],
    stats?.cost7d != null && ["Spent this week", fmtUsd(stats.cost7d)],
    (usual?.usd != null || usual?.ms != null) && ["A usual run", [usual.usd != null && fmtUsd(usual.usd), usual.ms != null && duration(usual.ms)].filter(Boolean).join(", ")],
  ].filter(Boolean);
  if (rows.length === 0) return null;
  return (
    <section className="eos-routine__section" aria-label="This week">
      <h2 className="eos-label">This week</h2>
      <dl className="eos-facts eos-routine__week">
        {rows.map(([label, value]) => <div key={label} className="eos-facts__row"><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
    </section>
  );
}
