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

// A station is a mark on one line, as Home's day is: the way behind solid,
// the way ahead dashed, the station the run is at lit in its state's tone
// and saying so under its name. The line runs on into the gutter and fades.
const Mark = () => <span className="eos-station__mark" aria-hidden="true" />;
const SAID = new Set(["current", "paused", "failed", "stopped"]);
// What the station it is at says under its name, by the run's state.
const NOW_WORDS = { waiting_for_user: "waits for you", delivering: "sending" };

export function RunStations({ run }) {
  const working = run.state === "running" || run.state === "checking";
  return (
    <div className="eos-stations-wrap">
      <ol className={working ? "eos-stations eos-stations--working" : "eos-stations"} aria-label="Stations">
        {stationStates(run).map((s) => (
          <li key={s.key} className={`eos-station eos-station--${s.state}`} aria-current={s.state === "todo" || s.state === "done" ? undefined : "step"}>
            <Mark />
            <span className="eos-station__name">{s.label}</span>
            {SAID.has(s.state)
              ? <span className="eos-station__word"><span className="eos-sr">, </span>{s.state === "current" ? NOW_WORDS[run.state] ?? WORDS.current : WORDS[s.state]}</span>
              : <span className="eos-sr">, {WORDS[s.state]}</span>}
          </li>
        ))}
      </ol>
    </div>
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

// Each as a hollow fact under the lead: Eos stopping is no fault of the run.
export function Interruptions({ events }) {
  const lines = interruptionLines(events);
  if (lines.length === 0) return null;
  return (
    <ul className="eos-run__interruptions">
      {lines.map((line, i) => <li key={i} className="eos-fact">{line}</li>)}
    </ul>
  );
}
