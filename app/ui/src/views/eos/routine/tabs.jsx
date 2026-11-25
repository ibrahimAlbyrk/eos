import { EmptyState } from "../frame.jsx";
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
// against the first week and the weeks between, drawn as a line of weekly
// marks as Home draws the day: the first and the weeks between dim, this
// week lit. A week the user judged nothing in keeps its place as a hollow
// mark on the floor. Only when the routine's row carries its stats.
const pct = (share) => `${Math.round(share * 100)}%`;
// Shares sit between 12% and 88% of the plot's height so marks never touch its edges.
const heightOf = (share) => Math.round((12 + share * 76) * 100) / 100;

function BetterPlot({ stats }) {
  const between = stats.weeksBetween ?? [];
  const weeks = [stats.baselineFirstWeek, ...between, stats.sentUnedited7d];
  const said = [
    `First week ${pct(stats.baselineFirstWeek)}`,
    ...between.map((share, i) => {
      const back = between.length - i;
      return `${back === 1 ? "last week" : `${back} weeks ago`} ${share == null ? "none judged" : pct(share)}`;
    }),
    `this week ${pct(stats.sentUnedited7d)}`,
  ];
  const at = (i) => (weeks.length === 1 ? 50 : (i / (weeks.length - 1)) * 100);
  const points = weeks.map((share, i) => (share == null ? null : `${at(i)},${Math.round((100 - heightOf(share)) * 100) / 100}`)).filter(Boolean).join(" ");
  return (
    <div className="eos-better__plot" role="img" aria-label={said.join(", ")}>
      <div className="eos-better__field">
        <svg className="eos-better__path" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={points} vectorEffect="non-scaling-stroke" />
        </svg>
        {weeks.map((share, i) => (
          <span
            key={i}
            className={["eos-better__week", share == null && "eos-better__week--none", i === weeks.length - 1 && "eos-better__week--now"].filter(Boolean).join(" ")}
            style={{ left: `${at(i)}%`, bottom: `${share == null ? 0 : heightOf(share)}%` }}
          />
        ))}
      </div>
      <span className="eos-better__axis" aria-hidden="true"><span>first week, {pct(stats.baselineFirstWeek)}</span><span>this week</span></span>
    </div>
  );
}

function GettingBetter({ stats }) {
  if (stats?.sentUnedited7d == null) return null;
  return (
    <section className="eos-routine__section eos-routine__better" aria-label="Getting better">
      <h2 className="eos-label">Getting better</h2>
      <p className="eos-better__share"><span className="eos-better__pct">{pct(stats.sentUnedited7d)}</span> sent without a single edit this week</p>
      {stats.baselineFirstWeek != null && <BetterPlot stats={stats} />}
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
            <EmptyState title="No runs yet.">Each run shows here with what it was about, how it went and what it cost.</EmptyState>
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
