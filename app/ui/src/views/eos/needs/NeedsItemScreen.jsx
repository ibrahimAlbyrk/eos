import { useEffect, useState } from "react";
import { useKeybinding } from "../../../keymap/useKeymap.js";
import { shortcutLabel } from "../../../lib/platform.js";
import {
  discardInboxItem, ensureInboxLoaded, laterInboxItem, loadInboxItem, useInbox,
} from "../../../state/eos/inboxStore.js";
import { loadRun } from "../../../state/eos/runsStore.js";
import { DevRunNote, Loading, LoadFailed } from "../capabilities/parts.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { openLocation } from "../nav/eosNav.js";
import { actionsOf, cardOf } from "./cards/index.js";
import { ChecksPanel } from "./ChecksPanel.jsx";
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
        <> <button type="button" className="eos-link" onClick={() => openLocation(itemLocation(detail.replacedBy))}>Open the newer draft</button></>
      )}
    </p>
  );
}

// eos:/needs/<id> — one item: its content by kind, its actions, Later and
// Discard, and what the run that made it did. J and K page through the list.
export function NeedsItemScreen({ id }) {
  const { list, details, failed, refused, devRun, offline } = useInbox();
  const [values, setValues] = useState({});
  const detail = details[id];
  const runId = detail?.item.runId;
  useEffect(() => {
    ensureInboxLoaded();
    void loadInboxItem(id);
  }, [id]);
  useEffect(() => { if (runId) void loadRun(runId); }, [runId]);

  const order = list ? inListOrder(list.items) : [];
  const at = order.findIndex((i) => i.id === id);
  const page = (by) => {
    const to = order[at + by];
    if (to) openLocation(itemLocation(to.id));
  };
  const open = Boolean(detail) && WAITING.has(detail.item.state) && !refused[id];
  const actions = open ? actionsOf(detail) : [];
  const doing = async (action) => {
    if (await action.run(detail, values)) openLocation(after(order, at));
  };
  const blocked = (action) => (action.write && offline) || (action.ready && !action.ready(detail, values));
  const primary = actions.find((a) => a.primary);

  const neighbours = order.map((i) => i.id).join(" ");
  useKeybinding({ match: plainKey("j"), run: (ctx, e) => { e.preventDefault(); page(1); } }, [neighbours, at]);
  useKeybinding({ match: plainKey("k"), run: (ctx, e) => { e.preventDefault(); page(-1); } }, [neighbours, at]);
  useKeybinding({
    match: primaryKey,
    run: (ctx, e) => {
      if (!primary || blocked(primary)) return;
      e.preventDefault();
      void doing(primary);
    },
  }, [detail, values, offline, neighbours, at]);

  const title = detail?.item.title ?? "Item";
  const { Body } = cardOf(detail?.item.kind);
  const stored = !isShownOnly(id);
  return (
    <main className="eos-screen">
      <EosHeader trail={[{ label: "Needs you", location: "eos:/needs" }, { label: title }]} />
      {offline && <p className="eos-needs-offline" role="status">{OFFLINE}</p>}
      <div className="eos-body eos-needs-item">
        {at >= 0 && (
          <nav className="eos-needs-pager" aria-label="Items">
            <button type="button" className="eos-btn" disabled={at === 0} onClick={() => page(-1)}>Previous</button>
            <span>{at + 1} of {order.length}</span>
            <button type="button" className="eos-btn" disabled={at === order.length - 1} onClick={() => page(1)}>Next</button>
          </nav>
        )}
        {devRun && <DevRunNote />}
        {!detail && failed[id] === "gone" && <p className="eos-note">This is no longer in Needs you.</p>}
        {!detail && failed[id] === "error" && <LoadFailed what="this item" retry={() => void loadInboxItem(id)} />}
        {!detail && !failed[id] && <Loading blocks={2} />}
        {detail && (
          <div className="eos-needs-item__columns">
            <div className="eos-needs-item__main">
              {!open && <Closed detail={detail} refused={refused[id]} />}
              <Body detail={detail} values={values} setValue={(key, value) => setValues((v) => ({ ...v, [key]: value }))} />
              {open && (
                <div className="eos-actions eos-needs-item__actions">
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
                    <button type="button" className="eos-btn" disabled={offline} onClick={() => { void laterInboxItem(id); openLocation(after(order, at)); }}>Later</button>
                  )}
                  {stored && (
                    <button type="button" className="eos-btn" disabled={offline} onClick={() => void doing({ run: () => discardInboxItem(id) })}>Discard</button>
                  )}
                </div>
              )}
            </div>
            {runId && <ChecksPanel runId={runId} />}
          </div>
        )}
      </div>
    </main>
  );
}
