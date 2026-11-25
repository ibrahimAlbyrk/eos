import { useEffect, useState } from "react";
import { ensureRoutinesLoaded, useRoutines } from "../../../state/eos/routinesStore.js";
import { release, retain, useRunLines } from "../../../state/eos/runLiveStore.js";
import { loadRun, loadRunResult, pauseRun, resumeRun, stopRun, useRuns } from "../../../state/eos/runsStore.js";
import { open as openRunSheet, useRunSheet } from "../../../state/eos/runSheetStore.js";
import { useDevRunSeen } from "../../../state/eos/transport.js";
import { DevRunNote, Loading, LoadFailed } from "../capabilities/parts.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { openLocation } from "../nav/eosNav.js";
import { DocView } from "../needs/results/ResultView.jsx";
import { RoutinePage } from "../routine/RoutinePage.jsx";
import { splitItemNumber } from "../routine/RoutineRuns.jsx";
import { RunCost } from "./RunCost.jsx";
import { RunMemory } from "./RunMemory.jsx";
import { Interruptions, RunStations } from "./RunStations.jsx";
import { RunTook } from "./RunTook.jsx";
import { TeamCard } from "./TeamCard.jsx";
import { TellTeam } from "./TellTeam.jsx";
import { hasEnded, isShownOnly, itemLine, originLine, reasonLine, stateChip } from "./words.js";

// The user may tell the team something while it works, checks or waits for
// them (01 G18); a run is stopped in any state but delivering and the ended ones.
const TELLABLE = new Set(["running", "checking", "waiting_for_user"]);
const STOPPABLE = new Set(["queued", "running", "checking", "waiting_for_user", "paused"]);
const PAUSABLE = new Set(["running", "checking"]);
const TICK_MS = 30_000;

// Now, again every half minute while the run is live, for its elapsed time.
function useNow(live) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

// The run's one sentence: what it does now, or how it ended.
export function runSentence({ run, input }) {
  const item = itemLine(input);
  switch (run.state) {
    case "queued": return item ? `Waiting to start on ${item}.` : "Waiting to start.";
    case "running": return item ? `Working on ${item}.` : "Working.";
    case "checking": return item ? `Checking the result for ${item}.` : "Checking the result.";
    case "waiting_for_user": return "The result waits for you in Needs you.";
    case "delivering": return "Sending the result.";
    case "paused": return `Paused. ${reasonLine(run)}`;
    case "done": return run.headline ?? "Done.";
    case "skipped": return `Skipped. ${reasonLine(run)}`;
    case "cancelled": return run.reason === "user" ? "You stopped this run." : `Stopped. ${reasonLine(run)}`;
    case "failed": return "This run failed.";
    default: return "";
  }
}

// A run's result as parts: as the lead wrote it when it is one, else its body
// as one text part (as the core reads it for the check).
export function resultDoc(result) {
  if (Array.isArray(result.body?.parts)) return result.body;
  const text = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
  return { kind: result.kind, parts: [{ key: "body", role: "text", text }] };
}

// The Needs-you item the run's result waits in, from its timeline.
const heldItem = (events) => events.findLast((e) => e.kind === "held")?.data?.itemId;

function RunAgain({ detail, primary = false }) {
  const { hosted } = useRunSheet();
  if (hosted === 0) return null;
  const { run, input } = detail;
  return (
    <button
      type="button"
      className={primary ? "eos-btn eos-btn--primary" : "eos-btn"}
      onClick={(e) => openRunSheet({ routineId: run.routineId, anchor: e.currentTarget, input, againOf: run.id })}
    >
      Run again
    </button>
  );
}

function WhatWentWrong({ detail }) {
  const failedChecks = detail.verdict?.checks.filter((c) => !c.ok) ?? [];
  return (
    <section className="eos-card eos-run-wrong" aria-label="What went wrong">
      <h2 className="eos-label">What went wrong</h2>
      <p className="eos-run-wrong__reason">{reasonLine(detail.run)}</p>
      {failedChecks.length > 0 && (
        <ul className="eos-run-wrong__checks">
          {failedChecks.map((c) => <li key={c.key}>{c.note}</li>)}
        </ul>
      )}
      <div className="eos-actions"><RunAgain detail={detail} primary /></div>
    </section>
  );
}

// A finished run that only showed its result: the result, read-only.
function ShownResult({ detail, result }) {
  const trial = detail.run.origin === "trial";
  return (
    <section className="eos-run-result" aria-label="Result">
      <h2 className="eos-label">{trial ? "Trial, nothing was sent" : "What it made"}</h2>
      {result ? <DocView doc={resultDoc(result)} /> : <Loading blocks={1} />}
    </section>
  );
}

const teamCount = (n) => (n === 1 ? "one agent" : `${n} agents`);

function RunBody({ detail, options, result, lines, devRun }) {
  const { run } = detail;
  const shownOnly = isShownOnly(detail);
  const itemId = run.state === "waiting_for_user" ? heldItem(detail.events) : undefined;
  return (
    <div className="eos-body eos-run">
      {devRun && <DevRunNote />}
      <div className="eos-run__columns">
        <section className="eos-run__main" aria-label="The run">
          <div>
            <p className="eos-run__sentence">
              {runSentence(detail)}
              {itemId && <> <button type="button" className="eos-link" onClick={() => openLocation(`eos:/needs/${encodeURIComponent(itemId)}`)}>Open it</button></>}
            </p>
            {shownOnly && <p className="eos-run__shown">Shown to you only. Nothing will be sent from this run.</p>}
          </div>
          <RunStations run={run} />
          <Interruptions events={detail.events} />
          {run.state === "failed" && <WhatWentWrong detail={detail} />}
          {run.state === "done" && shownOnly && <ShownResult detail={detail} result={result} />}
          {detail.agents.length > 0 && (
            <section className="eos-team" aria-label="The team">
              <header className="eos-section__head">
                <h2 className="eos-label">The team</h2>
                <span className="eos-section__aside">{teamCount(detail.agents.length)}</span>
              </header>
              <div className="eos-team__cards">
                {detail.agents.map((a) => <TeamCard key={a.workerId} agent={a} lines={lines[a.workerId]} />)}
              </div>
            </section>
          )}
          {TELLABLE.has(run.state) && <TellTeam runId={run.id} />}
        </section>
        <aside className="eos-run-aside" aria-label="About this run">
          <RunTook input={detail.input} options={options} />
          <RunCost run={run} usual={detail.usual} />
          <RunMemory runId={run.id} />
        </aside>
      </div>
    </div>
  );
}

// eos:/runs/<id> — one run in any state: where it is, its team at work, what
// it took and cost. The run is in the stream focus while it shows, so its
// agents' lines arrive. A project routine's run is its routine's page (G27).
export function RunView({ id }) {
  const { details, failed, results, stopping } = useRuns();
  const routines = useRoutines();
  const lines = useRunLines(id);
  const devRun = useDevRunSeen();
  const detail = details[id];
  const run = detail?.run;
  const now = useNow(Boolean(run) && !hasEnded(run));
  const showsResult = run?.state === "done" && isShownOnly(detail);

  useEffect(() => {
    ensureRoutinesLoaded();
    void loadRun(id);
    retain(id);
    return () => release(id);
  }, [id]);
  useEffect(() => { if (showsResult) void loadRunResult(id); }, [id, showsResult]);

  if (run?.kind === "project") return <RoutinePage id={run.routineId} />;

  const routine = run && (routines.details[run.routineId]?.routine ?? routines.list?.find((r) => r.id === run.routineId));
  const item = detail && itemLine(detail.input);
  const trail = [
    run ? { label: routine?.name ?? "Routine", location: `eos:/routines/${encodeURIComponent(run.routineId)}` } : { label: "Eos", location: "eos:/" },
    { label: item ? `Run on ${splitItemNumber(item).number ?? item}` : "Run" },
  ];
  const chip = run && stateChip(run, now);
  return (
    <main className="eos-screen eos-screen--wide">
      <EosHeader
        trail={trail}
        mark={run && (
          <>
            <span className="eos-chip">{originLine(run.origin)}</span>
            <span className={chip.tone ? `eos-status eos-status--${chip.tone}` : "eos-status"}>{chip.text}</span>
          </>
        )}
      >
        {run && (
          <>
            {PAUSABLE.has(run.state) && <button type="button" className="eos-btn eos-btn--ghost" onClick={() => void pauseRun(id)}>Pause</button>}
            {run.state === "paused" && run.reason === "user" && (
              <button type="button" className="eos-btn eos-btn--primary" onClick={() => void resumeRun(id)}>Resume</button>
            )}
            {STOPPABLE.has(run.state) && (
              <button type="button" className="eos-btn eos-btn--ghost eos-btn--stop" disabled={Boolean(stopping[id])} onClick={() => void stopRun(id)}>
                {stopping[id] ? "Stopping…" : "Stop"}
              </button>
            )}
            {/* A failed run offers Run again beside what went wrong. */}
            {run.state !== "failed" && <RunAgain detail={detail} />}
          </>
        )}
      </EosHeader>
      {!detail && failed[id] === "gone" && <div className="eos-body"><p className="eos-note">This run is no longer here.</p></div>}
      {!detail && failed[id] === "error" && <div className="eos-body"><LoadFailed what="this run" retry={() => void loadRun(id)} /></div>}
      {!detail && !failed[id] && <div className="eos-body"><Loading blocks={3} /></div>}
      {detail && (
        <RunBody
          detail={detail}
          options={routine?.options}
          result={showsResult ? results[id] : null}
          lines={lines}
          devRun={devRun}
        />
      )}
    </main>
  );
}
