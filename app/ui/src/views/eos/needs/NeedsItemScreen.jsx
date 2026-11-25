import { useEffect, useState } from "react";
import { useKeybinding } from "../../../keymap/useKeymap.js";
import { fmtTimeAgo } from "../../../lib/format.js";
import { shortcutLabel } from "../../../lib/platform.js";
import {
  discardInboxItem, ensureInboxLoaded, keepNextTime, laterInboxItem, loadInboxItem, useInbox,
} from "../../../state/eos/inboxStore.js";
import { loadRun } from "../../../state/eos/runsStore.js";
import { useRoutines } from "../../../state/eos/routinesStore.js";
import { useSurfaces } from "../../../state/eos/surfacesStore.js";
import { DevRunNote, Loading, LoadFailed } from "../capabilities/parts.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { openLocation } from "../nav/eosNav.js";
import { actionsOf, cardOf } from "./cards/index.js";
import { followReplacement } from "./cards/DraftCard.jsx";
import { dropEdit } from "./editDrafts.js";
import { ChecksPanel } from "./ChecksPanel.jsx";
import { StreakLine } from "./StreakLine.jsx";
import { ItemView } from "./ItemView.jsx";
import { ViewAside, ViewSubmit } from "./SurfaceCard.jsx";
import { plainKey, primaryKey } from "./keys.js";
import { inListOrder, itemLocation } from "./NeedsYouList.jsx";
import { closedLine, isShownOnly } from "./words.js";

const WAITING = new Set(["open", "later"]);
const OFFLINE = "Reconnecting…";

// Where to go once this item is answered: the next one, else the one before,
// else the list.
function after(order, at) {
  const next = order[at + 1] ?? order[at - 1];
  return next ? itemLocation(next.id) : "eos:/needs";
}

// Why the item no longer waits, and the newer draft that took its place.
function Closed({ detail, refused }) {
  const line = closedLine(refused ?? { state: detail.item.state, answeredBy: detail.answeredBy });
  return (
    <p className="eos-needs-closed" role="status">
      {line}
      {detail.replacedBy && (
        <> <button type="button" className="eos-link" onClick={() => followReplacement(detail)}>Open the newer draft</button></>
      )}
    </p>
  );
}

// eos:/needs/<id> — one item: its content by kind, its actions, Later and
// Discard, and what the run that made it did. J and K page through the list.
export function NeedsItemScreen({ id }) {
  const { list, details, failed, refused, devRun, offline } = useInbox();
  const [values, setValues] = useState({});
  // A View's form send, which this screen draws first among its actions.
  const [viewSubmit, setViewSubmit] = useState(null);
  // "Next time": sent with the answer, or alone after Discard.
  const [nextTime, setNextTime] = useState("");
  const routines = useRoutines().list;
  const nameOf = (routineId) => routines?.find((r) => r.id === routineId)?.name;
  const detail = details[id];
  const runId = detail?.item.runId;
  const viewBody = useSurfaces().byIssue[detail?.item.view?.issueId]?.body;
  useEffect(() => {
    ensureInboxLoaded();
    void loadInboxItem(id);
  }, [id]);
  useEffect(() => { if (runId) void loadRun(runId); }, [runId]);
  useEffect(() => { setNextTime(""); }, [id]);

  const order = list ? inListOrder(list.items) : [];
  const at = order.findIndex((i) => i.id === id);
  const page = (by) => {
    const to = order[at + by];
    if (to) openLocation(itemLocation(to.id));
  };
  const open = Boolean(detail) && WAITING.has(detail.item.state) && !refused[id];
  const stored = !isShownOnly(id);
  const asksNextTime = open && stored && detail.item.kind === "draft";
  // A View answers through its own buttons, or its form's send drawn here;
  // Later and Discard sit beside it.
  const actions = open && !detail.item.view ? actionsOf(detail, values) : [];
  const setValue = (key, value) => setValues((v) => ({ ...v, [key]: value }));
  const doing = async (action) => {
    if (!(await action.run(detail, values, setValue))) return;
    if (asksNextTime) void keepNextTime(nextTime);
    openLocation(after(order, at));
  };
  // A send refused because a newer draft took this one's place opens it.
  const replacedBy = refused[id]?.state === "replaced" ? detail?.replacedBy : undefined;
  useEffect(() => { if (replacedBy) followReplacement(detail); }, [replacedBy]); // eslint-disable-line react-hooks/exhaustive-deps
  const blocked = (action) => (action.write && offline) || (action.ready && !action.ready(detail, values));
  const primary = actions.find((a) => a.primary);
  const discarding = async () => {
    const done = await discardInboxItem(id);
    if (done) dropEdit(id);
    return done;
  };

  const neighbours = order.map((i) => i.id).join(" ");
  useKeybinding({ match: plainKey("j"), run: (ctx, e) => { e.preventDefault(); page(1); } }, [neighbours, at]);
  useKeybinding({ match: plainKey("k"), run: (ctx, e) => { e.preventDefault(); page(-1); } }, [neighbours, at]);
  useKeybinding({
    match: primaryKey,
    run: (ctx, e) => {
      if (!primary && open && viewSubmit?.ready && !offline) {
        e.preventDefault();
        viewSubmit.submit();
        return;
      }
      if (!primary || blocked(primary)) return;
      e.preventDefault();
      void doing(primary);
    },
  }, [detail, values, offline, neighbours, at, viewSubmit]);

  const title = detail?.item.title ?? "Item";
  const { Body } = cardOf(detail?.item.kind);
  return (
    <main className="eos-screen eos-screen--wide">
      <EosHeader trail={[{ label: "Needs you", location: "eos:/needs" }, { label: title }]}>
        {at >= 0 && (
          <nav className="eos-needs-pager" aria-label="Items">
            <span>{at + 1} of {order.length}</span>
            <button type="button" className="eos-icon-btn" aria-label="Previous" title="Previous (K)" disabled={at === 0} onClick={() => page(-1)}>
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16"><path d="M10 4L6 8l4 4" /></svg>
            </button>
            <button type="button" className="eos-icon-btn" aria-label="Next" title="Next (J)" disabled={at === order.length - 1} onClick={() => page(1)}>
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg>
            </button>
          </nav>
        )}
      </EosHeader>
      {offline && <p className="eos-needs-offline" role="status">{OFFLINE}</p>}
      <div className="eos-body eos-needs-item">
        {devRun && <DevRunNote />}
        {!detail && failed[id] === "gone" && <p className="eos-note">This is no longer in Needs you.</p>}
        {!detail && failed[id] === "error" && <LoadFailed what="this item" retry={() => void loadInboxItem(id)} />}
        {!detail && !failed[id] && <Loading blocks={2} />}
        {detail && (
          <div className="eos-needs-item__columns">
            <div className="eos-needs-item__main">
              <header className="eos-needs-item__head">
                <p className="eos-label">{nameOf(detail.item.routineId) ?? "Eos"}<span className="eos-needs-item__when">{fmtTimeAgo(detail.item.createdAt)}</span></p>
                <h2 className="eos-lead">{title}</h2>
              </header>
              {!open && <Closed detail={detail} refused={refused[id]} />}
              {detail.item.view
                ? <ItemView item={detail.item} routineName={nameOf(detail.item.routineId)} onSubmitOffer={setViewSubmit} />
                : <article className="eos-needs-item__card"><Body detail={detail} values={values} setValue={setValue} routineName={nameOf(detail.item.routineId)} /></article>}
              {open && (
                <div className="eos-actions eos-needs-item__actions">
                  {detail.item.view && viewSubmit && <ViewSubmit offer={viewSubmit} shortcut={shortcutLabel("mod+return")} disabled={offline} />}
                  {actions.map((a) => (
                    <button
                      key={a.label}
                      type="button"
                      className={a.primary ? "eos-btn eos-btn--primary" : "eos-btn"}
                      disabled={blocked(a)}
                      title={a.write && offline ? OFFLINE : undefined}
                      onClick={() => void doing(a)}
                    >
                      {a.label}{a.primary && <span className="eos-needs-key"> {shortcutLabel("mod+return")}</span>}
                    </button>
                  ))}
                  {stored && detail.item.state === "open" && (
                    <button type="button" className="eos-btn eos-btn--quiet" disabled={offline} onClick={() => { void laterInboxItem(id); openLocation(after(order, at)); }}>Later</button>
                  )}
                  {stored && (
                    <button type="button" className="eos-btn eos-btn--quiet" disabled={offline} onClick={() => void doing({ run: discarding })}>Discard</button>
                  )}
                  {asksNextTime && detail.item.routineId && <StreakLine routineId={detail.item.routineId} />}
                </div>
              )}
              {asksNextTime && (
                <div className="eos-needs-next">
                  <label htmlFor="eos-needs-next">Next time</label>
                  <input
                    id="eos-needs-next"
                    type="text"
                    value={nextTime}
                    placeholder="Tell Eos what to do differently, if anything"
                    onChange={(e) => setNextTime(e.target.value)}
                  />
                </div>
              )}
            </div>
            {(runId || viewBody?.aside?.length > 0) && (
              <ChecksPanel runId={runId} lead={viewBody?.aside?.length > 0 ? <ViewAside notes={viewBody.aside} /> : null} />
            )}
          </div>
        )}
      </div>
    </main>
  );
}
