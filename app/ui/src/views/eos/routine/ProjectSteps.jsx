import { useEffect } from "react";
import { release, retain, useRunLines } from "../../../state/eos/runLiveStore.js";
import { hasEnded } from "../run/words.js";
import { TellTeam } from "../run/TellTeam.jsx";
import { ProjectPanel } from "./ProjectPanel.jsx";

// A project routine's milestones, from the blueprint it shows.
export function milestonesOf(detail) {
  const blueprint = detail?.head?.blueprint;
  return blueprint?.kind === "project" ? blueprint.project?.milestones ?? [] : null;
}

// How far its run got: every milestone once the run is done.
export function doneCount(run, total) {
  if (!run) return 0;
  if (run.state === "done") return total;
  return Math.min(run.milestonesDone ?? 0, total);
}

// "Step 4 of 7": the milestone at work, or the last once all are done.
export function stepLabel(done, total) {
  return `Step ${Math.min(done + 1, total)} of ${total}`;
}

function Mark({ kind }) {
  if (kind === "done") {
    return (
      <svg aria-hidden="true" className="eos-step__mark eos-step__mark--done" width="13" height="13" viewBox="0 0 16 16">
        <path d="M3.5 8.5l3 3 6-7" />
      </svg>
    );
  }
  return <span aria-hidden="true" className={`eos-step__mark eos-step__mark--${kind}`} />;
}

// The latest line any of the run's agents showed.
function latestLine(lines) {
  const all = Object.values(lines).map((kept) => kept[kept.length - 1]).filter(Boolean);
  return all[all.length - 1] ?? null;
}

// The steps list (01 G10, 08 SurfaceApp): done, the one at work with what
// its team does now, and those still to come.
export function StepsList({ milestones, done, working, line }) {
  return (
    <ol className="eos-steps" aria-label="Steps">
      {milestones.map((m, n) => {
        const kind = n < done ? "done" : n === done && working ? "now" : "next";
        return (
          <li key={m.key} className={`eos-step eos-step--${kind}`} aria-current={kind === "now" ? "step" : undefined}>
            <Mark kind={kind} />
            <span className="eos-step__title">{m.title}</span>
            {kind === "now" && line && <span className="eos-step__line">{line}</span>}
          </li>
        );
      })}
    </ol>
  );
}

// The project's page body: the steps of its run, the latest word from its
// team, Tell the team while it works, and the side panel in the project's
// folder.
export function ProjectSteps({ detail, run }) {
  const milestones = milestonesOf(detail) ?? [];
  const runId = run?.id;
  useEffect(() => {
    if (!runId) return undefined;
    retain(runId);
    return () => release(runId);
  }, [runId]);
  const lines = useRunLines(runId);
  const working = Boolean(run) && !hasEnded(run);
  const done = doneCount(run, milestones.length);
  const line = latestLine(lines);
  return (
    <div className="eos-project">
      <section className="eos-project__main" aria-label="The project">
        <StepsList milestones={milestones} done={done} working={working} line={line} />
        {line && (
          <div className="eos-card eos-project__said">
            <p className="eos-project__said-text">{line}</p>
          </div>
        )}
        {working && <TellTeam runId={runId} />}
      </section>
      <aside className="eos-project__aside" aria-label="Side panel">
        <ProjectPanel routineId={detail.routine.id} repo={detail.head?.blueprint?.project?.repo ?? null} />
      </aside>
    </div>
  );
}
