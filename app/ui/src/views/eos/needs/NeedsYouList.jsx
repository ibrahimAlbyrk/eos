import { useEffect, useSyncExternalStore } from "react";
import { fmtTimeAgo } from "../../../lib/format.js";
import { useKeybinding } from "../../../keymap/useKeymap.js";
import { ensureInboxLoaded, laterInboxItem, loadLastAnswered, refreshInbox, useInbox } from "../../../state/eos/inboxStore.js";
import { ensureRoutinesLoaded, useRoutines } from "../../../state/eos/routinesStore.js";
import { DevRunNote, LoadingRows } from "../capabilities/parts.jsx";
import { Fact, FailedLead, Ring, Section } from "../frame.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { openLocation } from "../nav/eosNav.js";
import { AgentsWaitingLine } from "./AgentsWaitingLine.jsx";
import { onControl, plainKey } from "./keys.js";
import { ItemView } from "./ItemView.jsx";
import { GROUPS, groupOf, isShownOnly, itemTone, kindGlyph, needsLead, needsLine, primaryAction } from "./words.js";

export const itemLocation = (id) => `eos:/needs/${encodeURIComponent(id)}`;

// The waiting items as the list shows them: by group, each group in the
// core's order.
export function inListOrder(items) {
  return GROUPS.flatMap((g) => items.filter((i) => groupOf(i) === g.id));
}

// The row J and K have moved to; null until they move. Kept outside the
// screen so it survives the list being drawn again.
let cursor = null;
const cursorSubs = new Set();

function setCursor(id) {
  cursor = id;
  for (const cb of cursorSubs) cb();
}

function subscribeCursor(cb) {
  cursorSubs.add(cb);
  return () => cursorSubs.delete(cb);
}

const cursorSnapshot = () => cursor;

export function _resetNeedsCursor() {
  cursor = null;
}

function Row({ item, routineName, current }) {
  const open = () => openLocation(itemLocation(item.id));
  return (
    <li className={current ? "eos-needs-row on" : "eos-needs-row"} aria-current={current ? "true" : undefined}>
      <Ring d={kindGlyph(item.kind)} tone={itemTone(item)} />
      <button type="button" className="eos-needs-row__main" onClick={open}>
        <span className="eos-needs-row__title">{item.title}</span>
        <span className="eos-needs-row__line">
          <span className="eos-needs-row__routine">{routineName ?? "Eos"}</span>
          {item.summary && <span className="eos-needs-row__summary">{item.summary}</span>}
        </span>
      </button>
      <span className="eos-needs-row__time">{fmtTimeAgo(item.createdAt)}</span>
      <span className="eos-actions">
        <button type="button" className="eos-btn" onClick={open}>{primaryAction(item.kind)}</button>
        {item.state === "open" && !isShownOnly(item.id) && (
          <button type="button" className="eos-btn eos-btn--quiet" onClick={() => void laterInboxItem(item.id)}>Later</button>
        )}
      </span>
    </li>
  );
}

// A group's label, with how many it holds at the right.
function GroupHead({ label, count }) {
  return (
    <div className="eos-section__head">
      <h2 className="eos-label">{label}</h2>
      <span className="eos-section__aside">{count}</span>
    </div>
  );
}

function ViewItem({ item, routineName }) {
  return (
    <div className="eos-needs-view">
      <ItemView item={item} routineName={routineName} />
      <span className="eos-actions eos-needs-view__aside">
        <button type="button" className="eos-btn eos-btn--quiet" onClick={() => void laterInboxItem(item.id)}>Later</button>
      </span>
    </div>
  );
}

// What waits here, group by group, for a list with nothing in it.
const WHAT_WAITS = [
  ["draft", "To check and send", "What your routines made for other people, until you let it go."],
  ["question", "Questions", "What a run needs from you before it can go on."],
  ["delivery_problem", "Problems", "A routine that paused, a send that failed, a capability that stopped working."],
  ["freedom_offer", "Offers", "More freedom a routine has earned, or a capability Eos built for one."],
];

// Nothing waits: the screen says what it is for, as Home greets, when the
// last answer was given, and what comes here.
function NothingWaits({ lastAnswered, agentsWaiting }) {
  return (
    <div className="eos-first eos-needs-none">
      <header className="eos-first__head">
        <p className="eos-label">Needs you</p>
        <p className="eos-first__ask">Nothing needs you.</p>
        <p className="eos-first__dim">What your routines need from you waits here until you answer it.</p>
      </header>
      <div className="eos-needs-none__facts">
        {lastAnswered && <Fact tone="done" className="eos-needs-last">Last answered: {lastAnswered.title}, {fmtTimeAgo(lastAnswered.updatedAt)}.</Fact>}
        <AgentsWaitingLine count={agentsWaiting} />
      </div>
      <Section id="eos-needs-what" label="What waits here">
        <ul className="eos-needs-what">
          {WHAT_WAITS.map(([kind, name, line]) => (
            <li key={kind}>
              <Ring d={kindGlyph(kind)} />
              <span className="eos-needs-what__words">
                <span className="eos-needs-what__name">{name}</span>
                <span className="eos-needs-what__line">{line}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

// The list still coming: the lead's shape, then its rows.
function ListGhost() {
  return (
    <>
      <div className="eos-rlead eos-rlead--ghost eos-needs-head" aria-hidden="true">
        <span className="eos-skeleton__label" />
        <span className="eos-rlead__bar" />
        <span className="eos-rlead__bar eos-rlead__bar--dim" />
      </div>
      <LoadingRows />
    </>
  );
}

// An open item that shows a routine's View is drawn as that View.
const drawnAsView = (item) => Boolean(item.view) && item.state === "open";

// eos:/needs — everything that waits for the user, grouped; J and K move,
// Enter opens.
export function NeedsYouList() {
  const { list, listFailed, devRun, lastAnswered } = useInbox();
  const routines = useRoutines().list;
  const current = useSyncExternalStore(subscribeCursor, cursorSnapshot, cursorSnapshot);
  useEffect(() => {
    ensureInboxLoaded();
    ensureRoutinesLoaded();
  }, []);

  const all = list ? inListOrder(list.items) : [];
  const views = all.filter(drawnAsView);
  const items = all.filter((i) => !drawnAsView(i));
  const empty = list !== null && all.length === 0;
  useEffect(() => { if (empty) void loadLastAnswered(); }, [empty]);
  const at = Math.max(0, items.findIndex((i) => i.id === current));
  const move = (by) => {
    if (items.length) setCursor(items[Math.min(items.length - 1, Math.max(0, at + by))].id);
  };
  const ids = items.map((i) => i.id).join(" ");
  useKeybinding({ match: plainKey("j"), run: (ctx, e) => { e.preventDefault(); move(1); } }, [ids, at]);
  useKeybinding({ match: plainKey("k"), run: (ctx, e) => { e.preventDefault(); move(-1); } }, [ids, at]);
  useKeybinding({
    match: (e) => plainKey("enter")(e) && !onControl(e),
    run: (ctx, e) => {
      if (!items[at]) return;
      e.preventDefault();
      openLocation(itemLocation(items[at].id));
    },
  }, [ids, at]);

  const nameOf = (id) => routines?.find((r) => r.id === id)?.name;
  return (
    <main className="eos-screen eos-screen--read">
      <EosHeader trail={[{ label: "Needs you" }]} />
      <div className="eos-body eos-needs">
        {devRun && <DevRunNote />}
        {list === null && (listFailed ? <FailedLead what="what needs you" retry={() => void refreshInbox()} /> : <ListGhost />)}
        {list && !empty && (
          <header className="eos-rlead eos-needs-head">
            <p className="eos-lead">{needsLead(all)}</p>
            {needsLine(all) && <p className="eos-rlead__now">{needsLine(all)}</p>}
            <AgentsWaitingLine count={list.agentsWaiting} />
          </header>
        )}
        {empty && <NothingWaits lastAnswered={lastAnswered} agentsWaiting={list.agentsWaiting} />}
        {views.length > 0 && (
          <section className="eos-needs-group" aria-label="From your routines">
            <GroupHead label="From your routines" count={views.length} />
            {views.map((item) => <ViewItem key={item.id} item={item} routineName={nameOf(item.routineId)} />)}
          </section>
        )}
        {GROUPS.map((g) => {
          const inGroup = items.filter((i) => groupOf(i) === g.id);
          if (inGroup.length === 0) return null;
          return (
            <section key={g.id} className="eos-needs-group" aria-label={g.label}>
              <GroupHead label={g.label} count={inGroup.length} />
              <ul className="eos-rows eos-needs-rows">
                {inGroup.map((item) => (
                  <Row key={item.id} item={item} routineName={nameOf(item.routineId)} current={current !== null && item.id === items[at].id} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </main>
  );
}
