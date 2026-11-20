import { BlueprintEditor } from "../blueprint/BlueprintEditor.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { RightNow } from "./RightNow.jsx";
import { RunRow } from "./RoutineRuns.jsx";
import { Triggers } from "./Triggers.jsx";

// The tabs this version has; Learned waits for Memory (P4) and shows Overview.
export const TABS = [
  { key: "overview", label: "Overview" },
  { key: "runs", label: "Runs" },
  { key: "signals", label: "Signals" },
  { key: "blueprint", label: "Blueprint" },
];

export const tabOf = (tab) => (TABS.some((t) => t.key === tab) ? tab : "overview");

// Each tab is a location of its own (`?tab=`), so back and forward move between them.
export function RoutineTabs({ routineId, tab }) {
  return (
    <nav className="eos-tabs" role="tablist" aria-label="Routine">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          id={`eos-tab-${t.key}`}
          aria-selected={tab === t.key}
          aria-controls="eos-tab-panel"
          className="eos-tab"
          onClick={() => openLocation(buildLocation({ screen: "routine", routineId, tab: t.key === "overview" ? undefined : t.key }))}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

// Getting better: the share of this week's results sent without an edit,
// against the first week. Only when the routine's row carries its stats.
function GettingBetter({ stats }) {
  if (stats?.sentUnedited7d == null) return null;
  const pct = (share) => `${Math.round(share * 100)}%`;
  return (
    <section className="eos-routine__section" aria-label="Getting better">
      <h2 className="eos-label">Getting better</h2>
      <p className="eos-better__share">{pct(stats.sentUnedited7d)} sent without a single edit this week</p>
      {stats.baselineFirstWeek != null && <p className="eos-better__base">First week, {pct(stats.baselineFirstWeek)}</p>}
    </section>
  );
}

export function OverviewTab({ detail, now }) {
  return (
    <div className="eos-routine__columns">
      <div>
        <RightNow runs={detail.runs} now={now} />
        <section className="eos-routine__section" aria-label="Recent runs">
          <h2 className="eos-label">Recent runs</h2>
          {detail.runs.length === 0 ? (
            <p className="eos-note">No runs yet.</p>
          ) : (
            <ul className="eos-card eos-runs">{detail.runs.map((r) => <RunRow key={r.id} run={r} now={now} />)}</ul>
          )}
        </section>
      </div>
      <div>
        <Triggers detail={detail} now={now} />
        <GettingBetter stats={detail.routine.stats} />
      </div>
    </div>
  );
}

// The blueprint editor with its architect (views/eos/blueprint), or one of
// the routine's versions read-only.
export function BlueprintTab({ detail, version }) {
  return <BlueprintEditor key={version ?? "in-use"} detail={detail} versionNumber={version} />;
}
