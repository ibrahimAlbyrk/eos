import { useEffect, useSyncExternalStore } from "react";
import { fmtTimeAgo } from "../../../lib/format.js";
import { useKeybinding } from "../../../keymap/useKeymap.js";
import { ensureInboxLoaded, laterInboxItem, loadLastAnswered, refreshInbox, useInbox } from "../../../state/eos/inboxStore.js";
import { ensureRoutinesLoaded, useRoutines } from "../../../state/eos/routinesStore.js";
import { DevRunNote, Loading, LoadFailed } from "../capabilities/parts.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { openLocation } from "../nav/eosNav.js";
import { AgentsWaitingLine } from "./AgentsWaitingLine.jsx";
import { plainKey } from "./keys.js";
import { GROUPS, groupOf, isShownOnly, primaryAction } from "./words.js";

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

// A routine's glyph: the first letter of its name.
function Glyph({ name }) {
  return <span className="eos-needs-glyph" aria-hidden="true">{(name ?? "Eos").slice(0, 1).toUpperCase()}</span>;
}

function Row({ item, routineName, current }) {
  const open = () => openLocation(itemLocation(item.id));
  return (
    <li className={current ? "eos-needs-row on" : "eos-needs-row"} aria-current={current ? "true" : undefined}>
      <Glyph name={routineName} />
      <button type="button" className="eos-needs-row__main" onClick={open}>
        <span className="eos-needs-row__routine">{routineName ?? "Eos"}</span>
        <span className="eos-needs-row__title">{item.title}</span>
        {item.summary && <span className="eos-needs-row__summary">{item.summary}</span>}
      </button>
      <span className="eos-needs-row__time">{fmtTimeAgo(item.createdAt)}</span>
      <span className="eos-actions">
        <button type="button" className="eos-btn eos-btn--primary" onClick={open}>{primaryAction(item.kind)}</button>
        {item.state === "open" && !isShownOnly(item.id) && (
          <button type="button" className="eos-btn" onClick={() => void laterInboxItem(item.id)}>Later</button>
        )}
      </span>
    </li>
  );
}

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

  const items = list ? inListOrder(list.items) : [];
  const empty = list !== null && items.length === 0;
  useEffect(() => { if (empty) void loadLastAnswered(); }, [empty]);
  const at = Math.max(0, items.findIndex((i) => i.id === current));
  const move = (by) => {
    if (items.length) setCursor(items[Math.min(items.length - 1, Math.max(0, at + by))].id);
  };
  const ids = items.map((i) => i.id).join(" ");
  useKeybinding({ match: plainKey("j"), run: (ctx, e) => { e.preventDefault(); move(1); } }, [ids, at]);
  useKeybinding({ match: plainKey("k"), run: (ctx, e) => { e.preventDefault(); move(-1); } }, [ids, at]);
  useKeybinding({
    match: plainKey("enter"),
    run: (ctx, e) => {
      if (!items[at]) return;
      e.preventDefault();
      openLocation(itemLocation(items[at].id));
    },
  }, [ids, at]);

  const nameOf = (id) => routines?.find((r) => r.id === id)?.name;
  return (
    <main className="eos-screen">
      <EosHeader trail={[{ label: "Needs you" }]} />
      <div className="eos-body eos-needs">
        {devRun && <DevRunNote />}
        {list === null && (listFailed ? <LoadFailed what="what needs you" retry={() => void refreshInbox()} /> : <Loading />)}
        {list && <AgentsWaitingLine count={list.agentsWaiting} />}
        {empty && (
          <div className="eos-needs-empty">
            <p className="eos-note">Nothing needs you.</p>
            {lastAnswered && <p className="eos-needs-last">Last: {lastAnswered.title}, {fmtTimeAgo(lastAnswered.updatedAt)}.</p>}
          </div>
        )}
        {GROUPS.map((g) => {
          const inGroup = items.filter((i) => groupOf(i) === g.id);
          if (inGroup.length === 0) return null;
          return (
            <section key={g.id} className="eos-needs-group" aria-label={g.label}>
              <h2 className="eos-label">{g.label}</h2>
              <ul className="eos-card eos-needs-rows">
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
