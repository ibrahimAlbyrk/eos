import { useEffect, useState } from "react";
import { ensureHomeLoaded, lastSeenAt, markSeenSoon, refreshHome, useHome } from "../../../state/eos/homeStore.js";
import { setHomeDraft } from "../../../state/eos/homeDraftStore.js";
import { ensureInboxLoaded, useInbox } from "../../../state/eos/inboxStore.js";
import { refreshMemorySummary, useNotes } from "../../../state/eos/notesStore.js";
import { ensureRoutinesLoaded, useRoutines } from "../../../state/eos/routinesStore.js";
import { LoadFailed, Loading } from "../capabilities/parts.jsx";
import { HomeInput } from "../input/HomeInput.jsx";
import { HaltBand } from "../nav/HaltBand.jsx";
import { AwayList } from "./AwayList.jsx";
import { Greeting } from "./Greeting.jsx";
import { Horizon } from "./Horizon.jsx";
import { awayLines, dayStart } from "./homeWords.js";
import { LearnedLine } from "./LearnedLine.jsx";
import { NeedsYouCards } from "./NeedsYouCards.jsx";
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
// handled and what needs the user, the input (`input`, the Home input by
// default), starter chips that fill it, the first Needs-you cards, what
// happened while away and the week's learned line. Empty sections are left
// out; entering Home never focuses anything.
export function HomeScreen({ input = <HomeInput />, clock = Date.now }) {
  const now = useMinute(clock);
  const home = useHome();
  const inbox = useInbox();
  const routines = useRoutines().list;
  const summary = useNotes().summary;
  const [lastSeen] = useState(lastSeenAt);
  useEffect(() => {
    ensureHomeLoaded();
    ensureInboxLoaded();
    ensureRoutinesLoaded();
    void refreshMemorySummary();
    return markSeenSoon();
  }, []);

  const names = Object.fromEntries((routines ?? []).map((r) => [r.id, r.name]));
  const firstRun = routines !== null && routines.length === 0;
  const runs = home.runs ?? [];
  const today = runs.filter((r) => (r.startedAt ?? r.createdAt) >= dayStart(now));
  const scheduled = home.next.filter((n) => n.nextAt != null).map((n) => ({ routineId: n.routineId, at: n.nextAt }));
  const waiting = (inbox.list?.items ?? []).filter((i) => i.state === "open");
  const away = awayLines(runs, lastSeen ?? dayStart(now));

  let body;
  if (home.failed) body = <LoadFailed what="runs" retry={() => void refreshHome()} />;
  else if (home.runs === null) body = <Loading blocks={3} />;
  else body = (
    <>
      {!firstRun && <NeedsYouCards items={waiting} names={names} />}
      {!firstRun && <AwayList runs={away} names={names} />}
      {!firstRun && <LearnedLine weekly={summary?.weekly ?? 0} />}
    </>
  );

  return (
    <main className="eos-screen eos-home">
      <div className="pane-head pane-head--topleft eos-home__drag"><span className="pane-head-inset" aria-hidden="true" /></div>
      <HaltBand />
      {home.offline && <p className="eos-home__offline" role="status">Reconnecting…</p>}
      <div className="eos-home__scroll">
        <div className="eos-home__glow" aria-hidden="true" />
        <div className="eos-home__column">
          <Horizon runs={today} scheduled={scheduled} names={names} now={now} />
          <p className="eos-home__date">{new Date(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
          <Greeting name={home.name} now={now} lastSeen={lastSeen} handled={home.handled ?? 0} needs={waiting.length} firstRun={firstRun} />
          {input}
          <StarterChips onPick={setHomeDraft} />
          {body}
        </div>
      </div>
    </main>
  );
}
