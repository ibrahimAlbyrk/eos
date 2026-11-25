// Where a run is: its stations Brief → Work → Check → Gate → To you as an
// ordered list, the one it is at marked `aria-current="step"`; a run that
// ended shows its end there (G28). Each station says its state in words.

export const STATIONS = [
  { key: "brief", label: "Brief" },
  { key: "work", label: "Work" },
  { key: "check", label: "Check" },
  { key: "gate", label: "Gate" },
  { key: "deliver", label: "To you" },
];

// The state of the station the run is at.
const AT = { paused: "paused", failed: "failed", cancelled: "stopped" };

const WORDS = {
  done: "done",
  current: "now",
  paused: "paused here",
  failed: "failed here",
  stopped: "stopped here",
  todo: "not yet",
};

// Each station's state: `done`, `current`, `paused`, `failed`, `stopped` or
// `todo`. A queued or skipped run has not reached any, nor has one stopped
// before it started; a done one passed them all.
export function stationStates(run) {
  if (run.state === "done") return STATIONS.map((s) => ({ ...s, state: "done" }));
  const notStarted = run.state === "cancelled" && !run.station;
  if (run.state === "queued" || run.state === "skipped" || notStarted) return STATIONS.map((s) => ({ ...s, state: "todo" }));
  const at = Math.max(0, STATIONS.findIndex((s) => s.key === run.station));
  const here = AT[run.state] ?? "current";
  return STATIONS.map((s, i) => ({ ...s, state: i < at ? "done" : i === at ? here : "todo" }));
}

function Mark({ state }) {
  if (state === "done") {
    return <svg className="eos-station__mark" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>;
  }
  return <span className="eos-station__mark" aria-hidden="true" />;
}

export function RunStations({ run }) {
  return (
    <ol className="eos-stations" aria-label="Stations">
      {stationStates(run).map((s) => (
        <li key={s.key} className={`eos-station eos-station--${s.state}`} aria-current={s.state === "todo" || s.state === "done" ? undefined : "step"}>
          <Mark state={s.state} />
          {s.label}
          <span className="eos-sr">, {WORDS[s.state]}</span>
        </li>
      ))}
    </ol>
  );
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// Each time Eos stopped while the run worked, and when it carried on (01 G4):
// "Interrupted at 14:02, resumed 09:10".
export function interruptionLines(events) {
  const lines = [];
  events.forEach((e, i) => {
    if (e.kind !== "interrupted") return;
    const resumed = events.slice(i + 1).find((later) => later.kind === "resumed" || later.kind === "interrupted");
    const stoppedAt = clock.format(e.data?.at ?? e.at);
    lines.push(resumed?.kind === "resumed"
      ? `Interrupted at ${stoppedAt}, resumed ${clock.format(resumed.data?.at ?? resumed.at)}`
      : `Interrupted at ${stoppedAt}`);
  });
  return lines;
}

export function Interruptions({ events }) {
  const lines = interruptionLines(events);
  if (lines.length === 0) return null;
  return (
    <ul className="eos-run__interruptions">
      {lines.map((line, i) => <li key={i}>{line}</li>)}
    </ul>
  );
}
