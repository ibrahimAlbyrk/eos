import { useEffect } from "react";
import { ensureInboxLoaded, useInbox } from "../../../state/eos/inboxStore.js";
import { loadRoutineView, useSurfaces } from "../../../state/eos/surfacesStore.js";
import { loadRoutine, setRoutineState, useRoutines } from "../../../state/eos/routinesStore.js";
import { open as openRunSheet, useRunSheet } from "../../../state/eos/runSheetStore.js";
import { useDevRunSeen } from "../../../state/eos/transport.js";
import { DevRunNote, LoadFailed } from "../capabilities/parts.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { SurfaceCard } from "../needs/SurfaceCard.jsx";
import { RoutinePageLink } from "../surface/RoutinePageLink.jsx";
import { HolderLine } from "./Holder.jsx";
import { RoutineMenu } from "./RoutineMenu.jsx";
import { RoutineRuns } from "./RoutineRuns.jsx";
import { StatusChip } from "./StatusChip.jsx";
import { BlueprintTab, OverviewTab, RoutineTabs, tabOf } from "./tabs.jsx";
import { LearnedFromWork } from "../memory/LearnedFromWork.jsx";
import { SignalList } from "./SignalList.jsx";
import { Triggers } from "./Triggers.jsx";
import { HowItLearns } from "./WhatItLearned.jsx";
import { RoutineLead, RoutineLeadGhost } from "./RoutineLead.jsx";
import { ProjectSteps, doneCount, milestonesOf, stepLabel } from "./ProjectSteps.jsx";

// Hand runs start in these states; a draft runs only trials.
const RUNNABLE = new Set(["active", "paused"]);

function RunNow({ routine }) {
  const { hosted } = useRunSheet();
  if (hosted === 0 || !RUNNABLE.has(routine.state)) return null;
  return (
    <button type="button" className="eos-btn eos-btn--ghost" onClick={(e) => openRunSheet({ routineId: routine.id, anchor: e.currentTarget })}>
      Run now
    </button>
  );
}

// Pause for an active routine. Resume is in the lead, beside the words that
// say why a routine is paused or archived.
function Pause({ routine }) {
  if (routine.state !== "active") return null;
  return <button type="button" className="eos-btn eos-btn--ghost" onClick={() => void setRoutineState(routine.id, "paused")}>Pause</button>;
}

// eos:/routines/<id> — one routine: its state and what can be done with it,
// then its tabs: Overview (with the View it returned last, when it makes
// one), Runs, Signals, Blueprint, Learned (Memory's notes of this routine). eos:/routines/<id>/versions/<n>
// is its Blueprint tab showing that version.
export function RoutinePage({ id, tab, version }) {
  const { details, failed, list, unconfirmed } = useRoutines();
  const waiting = useInbox().list?.counts.byRoutine[id] ?? 0;
  const view = useSurfaces().byRoutine[id];
  const devRun = useDevRunSeen();
  useEffect(() => {
    ensureInboxLoaded();
    void loadRoutine(id);
    void loadRoutineView(id);
  }, [id]);

  const detail = details[id];
  const routine = detail?.routine ?? list?.find((r) => r.id === id);
  // A routine being made is its blueprint and its architect: it has no runs,
  // signals or notes yet to show in tabs.
  const making = routine?.state === "draft";
  const shown = making ? "blueprint" : tabOf(tab);
  const now = Date.now();
  const milestones = milestonesOf(detail);
  // A project's run is its page (08 G27): its newest run.
  const projectRun = milestones && routine?.lastRun?.kind === "project" ? routine.lastRun : null;
  return (
    <main className="eos-screen eos-screen--wide">
      <EosHeader
        trail={[{ label: "Routines", location: "eos:/routines" }, { label: routine?.name ?? "Routine" }]}
        mark={routine && (
          <>
            <StatusChip routine={routine} />
            {milestones?.length > 0 && projectRun && (
              <span className="eos-chip">{stepLabel(doneCount(projectRun, milestones.length), milestones.length)}</span>
            )}
          </>
        )}
      >
        {routine && (
          <>
            <RunNow routine={routine} />
            <Pause routine={routine} />
            {!making && <button type="button" className="eos-btn" onClick={() => openLocation(buildLocation({ screen: "routine", routineId: id, tab: "blueprint" }))}>Change it</button>}
            <RoutineMenu routine={routine} />
          </>
        )}
      </EosHeader>
      <div className="eos-body eos-routine">
        {devRun && <DevRunNote />}
        {!detail && failed[id] === "gone" && <p className="eos-note">This routine is no longer here.</p>}
        {!detail && failed[id] === "error" && <LoadFailed what="this routine" retry={() => void loadRoutine(id)} />}
        {!detail && !failed[id] && <RoutineLeadGhost />}
        {detail && (
          <>
            <HolderLine routine={routine} />
            {making && <BlueprintTab detail={detail} version={version} />}
            {!making && <RoutineLead routine={routine} runs={detail.runs} waiting={waiting} refusal={unconfirmed[id]} now={now} />}
            {!making && <RoutineTabs routineId={id} tab={shown} />}
            {!making && <div className="eos-tab-panel" id="eos-tab-panel" role="tabpanel" aria-labelledby={`eos-tab-${shown}`}>
              {shown === "overview" && view && (
                <section className="eos-routine__section" aria-label="What it made last">
                  <SurfaceCard card={view} routineName={routine.name} />
                </section>
              )}
              {shown === "overview" && milestones && <ProjectSteps detail={detail} run={projectRun} />}
              {shown === "overview" && <RoutinePageLink routineId={id} />}
              {shown === "overview" && <OverviewTab detail={detail} now={now} />}
              {shown === "runs" && <RoutineRuns routineId={id} />}
              {shown === "signals" && (
                <div className="eos-routine__columns">
                  <div><SignalList routineId={id} /></div>
                  <div><Triggers detail={detail} now={now} /></div>
                </div>
              )}
              {shown === "blueprint" && <BlueprintTab detail={detail} version={version} />}
              {shown === "learned" && (
                <div className="eos-routine__columns">
                  <div><LearnedFromWork routineId={id} /></div>
                  <div><HowItLearns /></div>
                </div>
              )}
            </div>}
          </>
        )}
      </div>
    </main>
  );
}
