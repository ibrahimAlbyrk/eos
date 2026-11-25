import { useEffect } from "react";
import { fmtTimeAgo } from "../../../lib/format.js";
import { saveBlueprint } from "../../../state/eos/blueprintStore.js";
import { ensureCapabilitiesLoaded, useCapabilities } from "../../../state/eos/capabilitiesStore.js";
import { useRoutines } from "../../../state/eos/routinesStore.js";
import { addSourcePush, loadTriggerStatus, useSignals } from "../../../state/eos/signalsStore.js";
import { LoadFailed } from "../capabilities/parts.jsx";
import { SLOTS, slotText } from "../blueprint/slots/index.js";
import { localZone } from "../blueprint/slots/when.js";
import { duration } from "../run/words.js";
import { catchUpLine, sourceName, sourceReason, sourceStateWord, timeAt, zoneName } from "./words.js";

const WHEN = SLOTS.find((s) => s.key === "when");

// A schedule only shows late once it fired a minute or more after its slot.
const LATE_FROM_MS = 60_000;

// The blueprint with schedule `slot` moved to this Mac's zone.
export function onLocalZone(blueprint, slot) {
  const on = blueprint.when.on.map((t, n) => (n === slot ? { ...t, schedule: { ...t.schedule, zone: localZone() } } : t));
  return { ...blueprint, when: { ...blueprint.when, on } };
}

// "05:00 Istanbul time; you are on London time", with the edit that moves it.
function ZoneHint({ status, trigger, routineId, head }) {
  const here = localZone();
  const at = trigger?.schedule?.daily ?? trigger?.schedule?.at;
  return (
    <p className="eos-trigger__hint">
      <span>{at ? `${at} ` : ""}{zoneName(status.zone)} time; you are on {zoneName(here)} time</span>
      {head && trigger?.schedule && (
        <button type="button" className="eos-btn" onClick={() => void saveBlueprint(routineId, head.id, onLocalZone(head.blueprint, status.slot))}>
          Use {zoneName(here)} time
        </button>
      )}
    </p>
  );
}

function ScheduleLine({ status, head, routineId, routines }) {
  const trigger = head?.blueprint?.when?.on?.[status.slot];
  const words = trigger ? slotText(WHEN, { when: { on: [trigger] } }, { routines }) : "A schedule";
  const facts = [
    status.nextAt != null && `Next ${timeAt(status.nextAt)}`,
    status.lastAt != null && `last ${timeAt(status.lastAt)}`,
    status.lateByMs >= LATE_FROM_MS && `ran ${duration(status.lateByMs)} late`,
    status.missed > 0 && `${status.missed} missed while the Mac slept or Eos was closed, run as one`,
  ].filter(Boolean);
  return (
    <li className="eos-trigger">
      <span className="eos-trigger__name">{words}</span>
      {facts.length > 0 && <span className="eos-trigger__facts">{facts.join(" · ")}</span>}
      {status.zoneDiffers && zoneName(status.zone) !== zoneName(localZone()) && <ZoneHint status={status} trigger={trigger} routineId={routineId} head={head} />}
    </li>
  );
}

// Why a webhook was not added, in plain words.
const PUSH_REFUSED = {
  "dev-run": "Not added: this is a dev run.",
  admin: "Not added: a webhook needs admin rights on the repository. Eos keeps looking for changes on its own schedule.",
};

// A source whose service could push: the button that adds its webhook, and
// why the last try did not.
function PushControl({ source, routineId }) {
  const tried = useSignals().pushes[source.sourceId];
  const refused = tried && tried !== "adding" ? (PUSH_REFUSED[tried] ?? `Not added: ${tried}`) : null;
  return (
    <p className="eos-trigger__hint">
      <button type="button" className="eos-btn" disabled={tried === "adding"} onClick={() => void addSourcePush(routineId, source.sourceId)}>
        {tried === "adding" ? "Adding the webhook…" : "Hear about changes at once"}
      </button>
      {refused && <span className="eos-trigger__refused" role="alert">{refused}</span>}
    </p>
  );
}

function SourceLine({ source, now, routineId }) {
  const capabilities = useCapabilities().list ?? [];
  useEffect(() => ensureCapabilitiesLoaded(), []);
  const reason = sourceReason(source);
  const polls = [
    source.push === "on" && "Told at once by a webhook",
    source.lastPollAt != null && `Last looked ${fmtTimeAgo(source.lastPollAt, now)}`,
    source.nextPollAt != null && `next ${timeAt(source.nextPollAt)}`,
  ].filter(Boolean);
  return (
    <li className="eos-trigger">
      <span className="eos-trigger__name">{sourceName(source, capabilities)}</span>
      <span className={`eos-trigger__state eos-trigger__state--${source.state === "active" ? "ok" : "warn"}`}>
        {sourceStateWord(source.state)}{reason && `: ${reason}`}
      </span>
      {polls.length > 0 && <span className="eos-trigger__facts">{polls.join(" · ")}</span>}
      {source.catchUp && <span className="eos-trigger__facts">{catchUpLine(source.catchUp)}</span>}
      {source.push === "off" && <PushControl source={source} routineId={routineId} />}
    </li>
  );
}

// What starts the routine's runs (02 §8): each schedule with its next and
// last time, how late and how many missed, and a zone hint; each source with
// its state and why, its polls and its last catch-up, and its webhook; the
// batch that waits.
export function TriggerLines({ status, head, routineId, now }) {
  const { list } = useRoutines();
  const { schedules, sources, batch } = status;
  if (schedules.length === 0 && sources.length === 0 && !batch) return null;
  return (
    <section className="eos-routine__section" aria-label="What starts it">
      <h2 className="eos-label">What starts it</h2>
      <ul className="eos-triggers">
        {schedules.map((s) => <ScheduleLine key={`slot-${s.slot}`} status={s} head={head} routineId={routineId} routines={list} />)}
        {sources.map((s) => <SourceLine key={s.sourceId} source={s} now={now} routineId={routineId} />)}
        {batch && (
          <li className="eos-trigger">
            <span className="eos-trigger__name">
              {batch.items} {batch.items === 1 ? "item waits" : "items wait"} to run together, until {timeAt(batch.closesAt)}
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}

// The routine's trigger status, read when the Overview opens and again on
// signals:change.
export function Triggers({ detail, now }) {
  const id = detail.routine.id;
  const status = useSignals().status[id];
  useEffect(() => { void loadTriggerStatus(id); }, [id]);
  if (status === "error") return <LoadFailed what="what starts this routine" retry={() => void loadTriggerStatus(id)} />;
  if (!status || status === "gone") return null;
  return <TriggerLines status={status} head={detail.head} routineId={id} now={now} />;
}
