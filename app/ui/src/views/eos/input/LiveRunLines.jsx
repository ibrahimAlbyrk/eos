import { useEffect, useState } from "react";
import { dropHomeRun, LINGER_MS, useHomeRuns } from "../../../state/eos/homeRunsStore.js";
import { useInbox } from "../../../state/eos/inboxStore.js";
import { release, retain, useRunLines } from "../../../state/eos/runLiveStore.js";
import { loadRun, stopRun, useRuns } from "../../../state/eos/runsStore.js";
import { NeedsCard } from "../home/NeedsYouCards.jsx";
import { openLocation } from "../nav/eosNav.js";
import { runLocation } from "../routine/RoutineRuns.jsx";
import { chipLabel } from "../runform/runFormModel.js";
import { hasEnded, reasonLine } from "../run/words.js";

export const LINES_SHOWN = 3;

const lastActivity = (byWorker) => Object.values(byWorker).map((l) => l[l.length - 1]).filter(Boolean).pop() ?? null;

// The line has said its last: the run ended, or it waits for the user,
// whose card opens under the input.
export const lineEnded = (run) => hasEnded(run) || run.state === "waiting_for_user";

// One live line's words, from the run's detail (08 G16): what it works on
// and what it is doing, then once it ended, its outcome.
export function liveWords(name, detail, activity) {
  if (!detail) return `${name} is starting.`;
  const { run, input } = detail;
  const item = input?.item ? ` on ${chipLabel(input.item)}` : "";
  if (run.state === "waiting_for_user") return `${name}${item}. It waits for you in Needs you.`;
  if (run.state === "done") return `Done. ${run.headline ?? ""}`.trim();
  if (run.state === "failed") return `${name} failed. ${reasonLine(run) ?? ""}`.trim();
  if (run.state === "cancelled") return `${name} was stopped.`;
  if (run.state === "skipped") return `${name} was skipped.`;
  const doing = run.needsUser ? "It needs you." : activity ?? run.headline ?? (run.state === "queued" ? "Waiting its turn." : "At work.");
  return `${name}${item}. ${doing}`;
}

function Line({ line, name, now }) {
  const detail = useRuns().details[line.runId];
  const activity = lastActivity(useRunLines(line.runId));
  const ended = detail ? lineEnded(detail.run) : false;
  useEffect(() => {
    void loadRun(line.runId);
    retain(line.runId);
    return () => release(line.runId);
  }, [line.runId]);
  useEffect(() => {
    if (!ended) return undefined;
    const timer = setTimeout(() => dropHomeRun(line.runId), LINGER_MS);
    return () => clearTimeout(timer);
  }, [ended, line.runId]);
  const stoppable = !ended && line.stopUntil != null && now < line.stopUntil;
  const tone = lineTone(detail?.run);
  return (
    <li className={ended ? "eos-live__line eos-live__line--ended" : "eos-live__line"}>
      <span className={`eos-live__dot eos-live__dot--${tone}`} aria-hidden="true" />
      <span className="eos-live__text">{liveWords(name, detail, activity)}</span>
      <span className="eos-live__acts">
        {stoppable && <button type="button" className="eos-btn eos-btn--quiet" onClick={() => void stopRun(line.runId)}>Stop</button>}
        <button type="button" className="eos-live__open" onClick={() => openLocation(runLocation(line.runId))}>Open the run</button>
      </span>
    </li>
  );
}

// The mark's tone: hollow while it waits its turn, breathing while it works,
// lit when it waits for the user, then how it ended.
export function lineTone(run) {
  if (!run || run.state === "queued") return "queued";
  if (run.state === "waiting_for_user") return "you";
  if (run.state === "done") return "ok";
  if (run.state === "failed") return "err";
  if (hasEnded(run)) return "ended";
  return "working";
}

// Re-draws once a second while a Stop may still show.
function useSecond(active) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

// The live lines under the input (RunInput.dc.html, "running"): three at
// most, the rest as "+N more running"; a run that needs the user opens its
// card here as well as in Needs you.
export function LiveRunLines({ byId }) {
  const lines = useHomeRuns();
  const inbox = useInbox();
  const now = useSecond(lines.some((l) => l.stopUntil != null));
  if (lines.length === 0) return null;
  const shown = lines.slice(0, LINES_SHOWN);
  const runIds = new Set(shown.map((l) => l.runId));
  const cards = (inbox.list?.items ?? []).filter((i) => i.state === "open" && runIds.has(i.runId));
  return (
    <section className="eos-live" aria-label="Started here">
      <p className="eos-live__head">
        <span className="eos-label">Started here</span>
        {lines.length > LINES_SHOWN && <span className="eos-live__more">+{lines.length - LINES_SHOWN} more running</span>}
      </p>
      <ul className="eos-live__lines" role="status">
        {shown.map((line) => <Line key={line.runId} line={line} name={byId.get(line.routineId)?.name ?? "The routine"} now={now} />)}
      </ul>
      {cards.length > 0 && <div className="eos-live__cards">{cards.map((item) => <NeedsCard key={item.id} item={item} routineName={byId.get(item.routineId)?.name} routineIcon={byId.get(item.routineId)?.icon} />)}</div>}
    </section>
  );
}
