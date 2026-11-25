import { BlueprintEditor } from "../blueprint/BlueprintEditor.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { RightNow } from "./RightNow.jsx";
import { RunRow } from "./RoutineRuns.jsx";
import { Triggers } from "./Triggers.jsx";
import { WhatItLearned } from "./WhatItLearned.jsx";

export const TABS = [
  { key: "overview", label: "Overview" },
  { key: "runs", label: "Runs" },
  { key: "signals", label: "Signals" },
  { key: "blueprint", label: "Blueprint" },
  { key: "learned", label: "Learned" },
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
    <section className="eos-routine__section eos-routine__better" aria-label="Getting better">
      <h2 className="eos-label">Getting better</h2>
      <p className="eos-better__share"><span className="eos-better__pct">{pct(stats.sentUnedited7d)}</span> sent without a single edit this week</p>
      {stats.baselineFirstWeek != null && (
        <div className="eos-better__bars" role="img" aria-label={`First week ${pct(stats.baselineFirstWeek)}, this week ${pct(stats.sentUnedited7d)}`}>
          <span className="eos-better__bar" style={{ height: pct(Math.max(stats.baselineFirstWeek, 0.04)) }} />
          <span className="eos-better__bar eos-better__bar--now" style={{ height: pct(Math.max(stats.sentUnedited7d, 0.04)) }} />
          <span className="eos-better__axis" aria-hidden="true"><span>first week, {pct(stats.baselineFirstWeek)}</span><span>this week</span></span>
        </div>
      )}
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
            <ul className="eos-runs eos-runs--flat">{detail.runs.map((r) => <RunRow key={r.id} run={r} now={now} />)}</ul>
          )}
        </section>
      </div>
      <div>
        <GettingBetter stats={detail.routine.stats} />
        <WhatItLearned routineId={detail.routine.id} />
        <Triggers detail={detail} now={now} />
      </div>
    </div>
  );
}

// The blueprint editor with its architect (views/eos/blueprint), or one of
// the routine's versions read-only.
export function BlueprintTab({ detail, version }) {
  return <BlueprintEditor key={version ?? "in-use"} detail={detail} versionNumber={version} />;
}
