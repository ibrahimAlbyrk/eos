import { useEffect, useState } from "react";
import { useKeybinding } from "../../../keymap/useKeymap.js";
import { shortcutLabel } from "../../../lib/platform.js";
import {
  discardInboxItem, ensureInboxLoaded, keepNextTime, laterInboxItem, loadInboxItem, useInbox,
} from "../../../state/eos/inboxStore.js";
import { loadRun, useRuns } from "../../../state/eos/runsStore.js";
import { useRoutines } from "../../../state/eos/routinesStore.js";
import { useSurfaces } from "../../../state/eos/surfacesStore.js";
import { loadRecalled, recalledKey, useNotes } from "../../../state/eos/notesStore.js";
import { DevRunNote } from "../capabilities/parts.jsx";
import { Fact, FailedLead } from "../frame.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { openLocation } from "../nav/eosNav.js";
import { actionsOf, cardOf } from "./cards/index.js";
import { followReplacement, isStale } from "./cards/DraftCard.jsx";
import { dropEdit } from "./editDrafts.js";
import { ChecksPanel } from "./ChecksPanel.jsx";
import { StreakLine } from "./StreakLine.jsx";
import { ItemView } from "./ItemView.jsx";
import { ViewAside, ViewSubmit } from "./SurfaceCard.jsx";
import { plainKey, primaryKey } from "./keys.js";
import { inListOrder, itemLocation } from "./NeedsYouList.jsx";
import { AnswerBar, ItemGhost, ItemLead } from "./ItemParts.jsx";
import { SendState } from "./SendState.jsx";
import { ItemFoot } from "./ItemFoot.jsx";
import { closedLine, isShownOnly, staleLine } from "./words.js";

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
    <Fact tone="done" role="status" className="eos-needs-closed">
      {line}
      {detail.replacedBy && (
        <> <button type="button" className="eos-link" onClick={() => followReplacement(detail)}>Open the newer draft</button></>
      )}
    </Fact>
  );
}

// A draft the user sent here is said by its sends, not as answered.
const saidBySends = (detail, refusal) => !refusal && detail.answeredBy === "dashboard" && detail.deliveries?.length > 0;

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
  const run = useRuns().details[runId];
  // The aside holds what the run did, or what a View's run wrote beside it,
  // for a thing the run made; a question or a permission keeps only the
  // notes that shaped it, and no aside when there are none.
  const made = Boolean(detail?.payload?.doc || detail?.item.view);
  const recalled = useNotes().recalled[recalledKey({ runId })];
  const hasAside = made ? Boolean(run) || viewBody?.aside?.length > 0 : Boolean(run) && recalled?.length > 0;
  useEffect(() => {
    ensureInboxLoaded();
    void loadInboxItem(id);
  }, [id]);
  useEffect(() => {
    if (!runId) return;
    void loadRun(runId);
    void loadRecalled({ runId });
  }, [runId]);
  useEffect(() => { setNextTime(""); }, [id]);

  // The pager steps through what waits now, so its count is the badge's; an
  // item put aside steps through Later instead.
  const listed = list ? inListOrder(list.items) : [];
  const aside = listed.find((i) => i.id === id)?.state === "later";
  const order = listed.filter((i) => (i.state === "later") === aside);
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
  // While a send is held or waits its turn, its Stop is the one act; Send,
  // Edit and the rest come back once it is stopped.
  const inFlight = (detail?.deliveries ?? []).some((d) => d.state === "holding" || d.state === "queued");
  const actions = open && !detail.item.view && !inFlight ? actionsOf(detail, values) : [];
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

  const title = detail?.item.title ?? (failed[id] ? "An item" : "Loading…");
  const { Body } = cardOf(detail?.item.kind);
  const routineName = nameOf(detail?.item.routineId);
  const isDraft = detail?.item.kind === "draft";
  const setAside = stored && (
    <>
      {/* A paused routine's Keep paused already puts it off; Later would say it twice. */}
      {detail?.item.state === "open" && detail.item.kind !== "routine_alert" && (
        <button type="button" className="eos-btn eos-btn--quiet" disabled={offline} onClick={() => { void laterInboxItem(id); openLocation(after(order, at)); }}>Later</button>
      )}
      <button type="button" className="eos-btn eos-btn--quiet" disabled={offline} onClick={() => void doing({ run: discarding })}>Discard</button>
    </>
  );
  return (
    <main className="eos-screen eos-screen--wide">
      <EosHeader trail={[{ label: "Needs you", location: "eos:/needs" }, { label: title }]}>
        {at >= 0 && (
          <nav className="eos-needs-pager" aria-label="Items">
            <span>{at + 1} of {order.length}{aside ? " in Later" : ""}</span>
            <button type="button" className="eos-icon-btn" aria-label="Previous" title="Previous (K)" disabled={at === 0} onClick={() => page(-1)}>
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16"><path d="M10 4L6 8l4 4" /></svg>
            </button>
            <button type="button" className="eos-icon-btn" aria-label="Next" title="Next (J)" disabled={at === order.length - 1} onClick={() => page(1)}>
              <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg>
            </button>
          </nav>
        )}
      </EosHeader>
      <div className="eos-body eos-needs-item">
        {devRun && <DevRunNote />}
        {!detail && failed[id] === "gone" && (
          <header className="eos-rlead eos-failed">
            <p className="eos-lead">This is no longer in Needs you.</p>
            <p className="eos-rlead__now">It was answered, or what asked for it no longer needs it.</p>
            <div className="eos-rlead__acts"><button type="button" className="eos-btn" onClick={() => openLocation("eos:/needs")}>Back to Needs you</button></div>
          </header>
        )}
        {!detail && failed[id] === "error" && <FailedLead what="this item" retry={() => void loadInboxItem(id)} back={{ label: "Back to Needs you", location: "eos:/needs" }} />}
        {!detail && !failed[id] && <ItemGhost />}
        {detail && (
          <div className="eos-needs-item__columns">
            <div className="eos-needs-item__main">
              <ItemLead detail={detail} routineName={routineName}>
                {offline && <Fact key="offline" tone="warn" role="status" className="eos-needs-offline">{OFFLINE}</Fact>}
                {!open && !saidBySends(detail, refused[id]) && <Closed key="closed" detail={detail} refused={refused[id]} />}
                {isDraft && open && isStale(detail) && <Fact key="stale" tone="warn" role="status" className="eos-needs-stale">{staleLine(detail.item.staleReason)}</Fact>}
                {isDraft && <SendState key="send" detail={detail} />}
              </ItemLead>
              {detail.item.view
                ? <ItemView item={detail.item} routineName={routineName} onSubmitOffer={setViewSubmit} />
                : <div className={`eos-needs-item__object eos-needs-item__object--${detail.item.kind}`}><Body detail={detail} values={values} setValue={setValue} routineName={routineName} /></div>}
              {open && !inFlight && viewSubmit?.phase !== "asking" && (
                <AnswerBar
                  kind={detail.item.kind}
                  actions={actions}
                  blocked={blocked}
                  offline={offline}
                  onAct={(a) => void doing(a)}
                  lead={detail.item.view && viewSubmit && <ViewSubmit offer={viewSubmit} shortcut={shortcutLabel("mod+return")} disabled={offline} />}
                  aside={setAside}
                />
              )}
              {open && asksNextTime && detail.item.routineId && <StreakLine routineId={detail.item.routineId} />}
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
              {open && at >= 0 && (
                <ItemFoot after={order.slice(at + 1)} nameOf={nameOf} onOpen={(next) => openLocation(itemLocation(next))} />
              )}
              {/* Sent, answered or gone from the list: it still ends on what waits now. */}
              {!open && at < 0 && list && (
                <ItemFoot after={listed.filter((i) => i.state !== "later" && i.id !== id)} nameOf={nameOf} onOpen={(next) => openLocation(itemLocation(next))} />
              )}
            </div>
            {hasAside && (
              <ChecksPanel runId={runId} whyOnly={!made} lead={viewBody?.aside?.length > 0 ? <ViewAside notes={viewBody.aside} /> : null} />
            )}
          </div>
        )}
      </div>
    </main>
  );
}
