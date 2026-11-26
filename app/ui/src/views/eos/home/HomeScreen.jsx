import { useEffect, useMemo, useRef, useState } from "react";
import { markSeenSoon, openHomeVisit, refreshHome, useHome, visitSince } from "../../../state/eos/homeStore.js";
import { setHomeDraft } from "../../../state/eos/homeDraftStore.js";
import { ensureInboxLoaded, useInbox } from "../../../state/eos/inboxStore.js";
import { refreshMemorySummary, useNotes } from "../../../state/eos/notesStore.js";
import { ensureRoutinesLoaded, offeredRoutines, useRoutines } from "../../../state/eos/routinesStore.js";
import { LoadingRows } from "../capabilities/parts.jsx";
import { Band, Ways } from "../frame.jsx";
import { HomeInput } from "../input/HomeInput.jsx";
import { HaltBand } from "../nav/HaltBand.jsx";
import { FieldLayer } from "../field/FieldLayer.jsx";
import { closeField, openField, useField } from "../field/fieldStore.js";
import { useInputFlight } from "../field/flight.js";
import { AwayList } from "./AwayList.jsx";
import { Greeting } from "./Greeting.jsx";
import { Horizon } from "./Horizon.jsx";
import { awayLines, comingUp, dayStart, handledLine, hello, needLine } from "./homeWords.js";
import { ComingUp } from "./ComingUp.jsx";
import { LearnedLine } from "./LearnedLine.jsx";
import { MovedShortcuts } from "./MovedShortcuts.jsx";
import { NeedsYouCards } from "./NeedsYouCards.jsx";
import { PinnedTiles } from "./PinnedTiles.jsx";
import { StarterChips } from "./StarterChips.jsx";

const MINUTE_MS = 60 * 1000;

// The clock Home is drawn at: once a minute, so the now dot moves and
// midnight starts a new day.
function useMinute(clock) {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// eos:/ — Horizon (Main.dc.html): the day's arc, the greeting with what was
// handled and what needs the user, the input, starter chips that fill it,
// the first Needs-you cards, the pinned tiles, what runs next, what happened
// while away (or earlier today) and the week's learned line. Empty sections are left
// out; entering Home never focuses anything. Focusing the input turns Home
// into the field (FieldLayer); the rest of Home is inert meanwhile.
// With nothing yet, the way from a sentence to a routine that runs, said once
// under the input so the first page is not half empty.
const FIRST_WAYS = [
  ["Say it", "In your own words, as you would ask a colleague.", "M3 4.5h10v6H7l-3 2.5v-2.5H3z"],
  ["Eos writes a blueprint", "What starts it, what it reads and who it reaches. Change any part.", "M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3M5.5 8.5h5M5.5 11h3.5"],
  ["Try it on past items", "It shows what it would have done before anything runs.", "M5 3.5l7 4.5-7 4.5z"],
  ["Start it", "It runs when it should; its freedom says what may go out without you.", "M8 2.5v5.5l3.5 2M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12z"],
];

export function HomeScreen({ clock = Date.now }) {
  const now = useMinute(clock);
  const inputRef = useRef(null);
  const blockRef = useRef(null);
  const placeRef = useRef(null);
  const { open: fieldOpen, on: fieldOn } = useField();
  useInputFlight(blockRef, placeRef);
  const home = useHome();
  const inbox = useInbox();
  const { list: routines, listFailed } = useRoutines();
  const offered = useMemo(() => offeredRoutines(routines), [routines]);
  const summary = useNotes().summary;
  const lastSeen = visitSince();
  useEffect(() => {
    openHomeVisit();
    ensureInboxLoaded();
    ensureRoutinesLoaded();
    void refreshMemorySummary();
    const stopSeen = markSeenSoon();
    return () => {
      stopSeen?.();
      closeField();
    };
  }, []);

  const names = Object.fromEntries((routines ?? []).map((r) => [r.id, r.name]));
  const icons = Object.fromEntries((routines ?? []).map((r) => [r.id, r.icon]));
  const firstRun = routines !== null && routines.length === 0;
  const runs = home.runs ?? [];
  const today = runs.filter((r) => (r.startedAt ?? r.createdAt) >= dayStart(now));
  const scheduled = home.next.filter((n) => n.nextAt != null).map((n) => ({ routineId: n.routineId, at: n.nextAt }));
  const waiting = (inbox.list?.items ?? []).filter((i) => i.state === "open");
  const away = awayLines(runs, lastSeen ?? dayStart(now));
  const earlier = away.length === 0 ? awayLines(runs, dayStart(now)) : [];
  const needs = {};
  for (const item of waiting) if (item.routineId) needs[item.routineId] = (needs[item.routineId] ?? 0) + 1;
  const next = Object.fromEntries(home.next.filter((n) => n.nextAt != null).map((n) => [n.routineId, n.nextAt]));
  const inert = fieldOpen ? "" : undefined;

  let body;
  if (home.failed) {
    body = (
      <div className="eos-home-part">
        <Band tone="err" role="alert" action={<button type="button" className="eos-btn" onClick={() => void refreshHome()}>Try again</button>}>
          Couldn&apos;t load runs, so what is coming up and what ran today are missing here.
        </Band>
      </div>
    );
  } else if (home.runs === null) body = <div className="eos-home-part"><LoadingRows rows={3} /></div>;
  else body = (
    <>
      {!firstRun && <NeedsYouCards items={waiting} names={names} icons={icons} />}
      {!firstRun && <PinnedTiles />}
      {!firstRun && <ComingUp slots={comingUp(home.next, now)} names={names} now={now} />}
      {!firstRun && (away.length > 0 ? <AwayList runs={away} names={names} /> : <AwayList runs={earlier} names={names} title="Earlier today" />)}
      {!firstRun && <LearnedLine weekly={summary?.weekly ?? 0} />}
      {firstRun && <div className="eos-home-part"><Ways id="eos-home-ways" label="How a routine begins" ways={FIRST_WAYS} /></div>}
    </>
  );

  return (
    <main className={fieldOn ? "eos-screen eos-home is-field" : "eos-screen eos-home"}>
      <div className="pane-head pane-head--topleft eos-home__drag"><span className="pane-head-inset" aria-hidden="true" /></div>
      <HaltBand />
      <MovedShortcuts />
      {home.offline && <p className="eos-home__offline" role="status">Reconnecting…</p>}
      <div className="eos-home__scroll">
        <div className="eos-home__glow" aria-hidden="true" />
        <div className="eos-home__column">
          <div className="eos-home__above" inert={inert}>
            <Horizon runs={today} scheduled={scheduled} names={names} now={now} />
            <p className="eos-home__date">{new Date(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
            <Greeting name={home.name} now={now} lastSeen={lastSeen} handled={home.handled} needs={waiting.length} firstRun={firstRun} />
          </div>
          <div ref={placeRef} className="eos-input-place" />
          <HomeInput inputRef={inputRef} blockRef={blockRef} onFocus={openField} starters={!fieldOn && <StarterChips onPick={setHomeDraft} />} />
          <div className="eos-home__below" inert={inert}>
            {body}
          </div>
        </div>
      </div>
      <FieldLayer
        routines={offered}
        status={routines === null ? (listFailed ? "failed" : "loading") : home.offline ? "offline" : null}
        needs={needs}
        next={next}
        caption={<>{hello(new Date(now).getHours(), home.name)}{needLine(waiting.length) && <> <span className="eos-field__need">{needLine(waiting.length)}</span></>}</>}
        handled={home.handled ? handledLine(home.handled, now, lastSeen) : null}
        inputRef={inputRef}
        now={now}
      />
    </main>
  );
}
