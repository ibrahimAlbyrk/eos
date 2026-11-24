import { useEffect } from "react";
import { ensureInboxLoaded } from "../../../state/eos/inboxStore.js";
import { loadRoutineView, useSurfaces } from "../../../state/eos/surfacesStore.js";
import { loadRoutine, setRoutineState, useRoutines } from "../../../state/eos/routinesStore.js";
import { open as openRunSheet, useRunSheet } from "../../../state/eos/runSheetStore.js";
import { useDevRunSeen } from "../../../state/eos/transport.js";
import { DevRunNote, Loading, LoadFailed } from "../capabilities/parts.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { SurfaceCard } from "../needs/SurfaceCard.jsx";
import { reasonLine } from "../run/words.js";
import { RoutineMenu } from "./RoutineMenu.jsx";
import { RoutineRuns, runLocation } from "./RoutineRuns.jsx";
import { StatusChip } from "./StatusChip.jsx";
import { BlueprintTab, OverviewTab, RoutineTabs, tabOf } from "./tabs.jsx";
import { SignalList } from "./SignalList.jsx";
import { UnconfirmedRecipients } from "./Unconfirmed.jsx";
import { pausedLine } from "./words.js";

// Hand runs start in these states; a draft runs only trials.
const RUNNABLE = new Set(["active", "paused"]);

function RunNow({ routine }) {
  const { hosted } = useRunSheet();
  if (hosted === 0 || !RUNNABLE.has(routine.state)) return null;
  return (
    <button type="button" className="eos-btn eos-btn--primary" onClick={(e) => openRunSheet({ routineId: routine.id, anchor: e.currentTarget })}>
      Run now
    </button>
  );
}

// Pause for an active routine, Resume for a paused or archived one.
function PauseResume({ routine }) {
  if (routine.state === "active") {
    return <button type="button" className="eos-btn" onClick={() => void setRoutineState(routine.id, "paused")}>Pause</button>;
  }
  if (routine.state === "paused" || routine.state === "archived") {
    return <button type="button" className="eos-btn" onClick={() => void setRoutineState(routine.id, "active")}>Resume</button>;
  }
  return null;
}

// A paused routine's band: why, in words, with Resume and its last run; once
// Resume was refused until recipients are confirmed, that refusal in place
// of the reason, and Resume to try again once they are.
function PausedBand({ routine, refusal }) {
  return (
    <div className="eos-band eos-band--warn" role="status">
      {refusal
        ? <UnconfirmedRecipients refusal={refusal} routineId={routine.id} />
        : <span className="eos-band__text">{pausedLine(routine.pausedReason)}</span>}
      <button type="button" className={refusal ? "eos-btn" : "eos-btn eos-btn--primary"} onClick={() => void setRoutineState(routine.id, "active")}>Resume</button>
      {routine.lastRun && <button type="button" className="eos-btn" onClick={() => openLocation(runLocation(routine.lastRun.id))}>Open the last run</button>}
    </div>
  );
}

// A routine whose last run failed: why, and the way to that run.
function FailedBand({ run }) {
  return (
    <div className="eos-band eos-band--err" role="status">
      <span className="eos-band__text">The last run failed. {reasonLine(run)}</span>
      <button type="button" className="eos-btn" onClick={() => openLocation(runLocation(run.id))}>Open the run</button>
    </div>
  );
}

// eos:/routines/<id> — one routine: its state and what can be done with it,
// then its tabs: Overview (with the View it returned last, when it makes
// one), Runs, Signals, Blueprint. eos:/routines/<id>/versions/<n>
// is its Blueprint tab showing that version.
export function RoutinePage({ id, tab, version }) {
  const { details, failed, list, unconfirmed } = useRoutines();
  const view = useSurfaces().byRoutine[id];
  const devRun = useDevRunSeen();
  useEffect(() => {
    ensureInboxLoaded();
    void loadRoutine(id);
    void loadRoutineView(id);
  }, [id]);

  const detail = details[id];
  const routine = detail?.routine ?? list?.find((r) => r.id === id);
  const shown = tabOf(tab);
  const now = Date.now();
  return (
    <main className="eos-screen">
      <EosHeader trail={[{ label: "Routines", location: "eos:/routines" }, { label: routine?.name ?? "Routine" }]}>
        {routine && (
          <>
            <StatusChip routine={routine} />
            <RunNow routine={routine} />
            <PauseResume routine={routine} />
            <button type="button" className="eos-btn" onClick={() => openLocation(buildLocation({ screen: "routine", routineId: id, tab: "blueprint" }))}>Change it</button>
            <RoutineMenu routine={routine} />
          </>
        )}
      </EosHeader>
      <div className="eos-body eos-routine">
        {devRun && <DevRunNote />}
        {!detail && failed[id] === "gone" && <p className="eos-note">This routine is no longer here.</p>}
        {!detail && failed[id] === "error" && <LoadFailed what="this routine" retry={() => void loadRoutine(id)} />}
        {!detail && !failed[id] && <Loading blocks={3} />}
        {detail && (
          <>
            {routine.state === "paused" && <PausedBand routine={routine} refusal={unconfirmed[id]} />}
            {routine.state !== "paused" && routine.lastRun?.state === "failed" && <FailedBand run={routine.lastRun} />}
            <div>
              <p className="eos-routine__summary">{routine.summary}</p>
              {routine.triggerLine && <p className="eos-routine__line">{routine.triggerLine}</p>}
            </div>
            <RoutineTabs routineId={id} tab={shown} />
            <div className="eos-tab-panel" id="eos-tab-panel" role="tabpanel" aria-labelledby={`eos-tab-${shown}`}>
              {shown === "overview" && view && (
                <section className="eos-routine__section" aria-label="What it made last">
                  <SurfaceCard card={view} routineName={routine.name} />
                </section>
              )}
              {shown === "overview" && <OverviewTab detail={detail} now={now} />}
              {shown === "runs" && <RoutineRuns routineId={id} />}
              {shown === "signals" && <SignalList routineId={id} />}
              {shown === "blueprint" && <BlueprintTab detail={detail} version={version} />}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
