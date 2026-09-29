import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api/client.js";
import {
  useHosts, switchMachine, hostLabel, linkTone, routeLabel, latencyLabel, canManageMachines,
} from "../../state/hostsStore.js";
import { currentHost, isRemoteView } from "../../lib/host.js";
import { summarizeSessions } from "../../lib/machineSessions.js";
import { MachineGlyph } from "./MachineGlyph.jsx";
import { CheckIcon, GridIcon, PlusIcon, ShieldIcon } from "./icons.jsx";

// Only these ids get a ⌃N shortcut — the shell's Machines menu binds the same.
const shortcut = (i) => (i < 9 ? `⌃${i + 1}` : null);

function SessionRows({ summary }) {
  if (!summary?.rows.length) return null;
  return (
    <div className="mc-rows">
      {summary.rows.map((r) => (
        <div className="mc-row" key={r.id}>
          <span className={"mc-dot" + (r.needs ? " mc-dot--need" : r.dot === "run" ? "" : " mc-dot--idle")} />
          <span className="mc-row__name">{r.name}</span>
          <span className={"mc-row__status" + (r.needs ? " is-warn" : "")}>{r.status}</span>
        </div>
      ))}
    </div>
  );
}

function Stats({ summary }) {
  if (!summary) return null;
  if (!summary.total) return <div className="mc-stats"><span className="mc-stat">No agents</span></div>;
  return (
    <div className="mc-stats">
      {summary.running > 0 && <span className="mc-stat"><span className="mc-dot" />{summary.running} running</span>}
      {summary.needs > 0 && <span className="mc-stat is-warn"><span className="mc-dot mc-dot--need" />{summary.needs} need{summary.needs === 1 ? "s" : ""} you</span>}
      {summary.running === 0 && summary.needs === 0 && <span className="mc-stat"><span className="mc-dot mc-dot--idle" />{summary.idle} idle</span>}
    </div>
  );
}

// The Machines menu, above the sidebar footer's machine row: every computer this
// Mac drives, what its agents are doing, and the ways to add one or to let
// others in. Portal'd like the Account menu; data-popover keeps inside clicks inside.
export function MachinesMenu({ anchor, live, onConnect, onAllMachines, onRemoteAccess }) {
  const { hosts, local } = useHosts();
  const remote = isRemoteView();
  const here = remote ? currentHost()?.id : null;
  // Other computers' agents, read through this Mac's facade — possible only from
  // this Mac's own view (a remote view may reach its own host alone).
  const [previews, setPreviews] = useState({});

  useEffect(() => {
    if (remote) return;
    let alive = true;
    for (const h of hosts) {
      if (h.link?.state !== "live") continue;
      Promise.all([api.hostWorkers(h.id), api.hostPending(h.id)]).then(([workers, pending]) => {
        if (alive && workers) setPreviews((p) => ({ ...p, [h.id]: summarizeSessions(workers, pending) }));
      });
    }
    return () => { alive = false; };
  }, [remote, hosts]);

  const ownSummary = summarizeSessions(live?.workers, live?.pendingPermissions);
  const pos = { left: Math.round(anchor.left + 2), bottom: Math.round(window.innerHeight - anchor.top + 6) };
  const reachable = hosts.filter((h) => h.link?.state !== "offline" || h.id === here);
  const offline = hosts.filter((h) => h.link?.state === "offline" && h.id !== here);

  return createPortal(
    <div className="machines-menu" data-popover="machines-menu" role="menu" aria-label="Machines" style={pos}>
      <div className="machines-menu__label">Machines<span className="acct-kbd">⌘⇧M</span></div>

      <button type="button" className="mc-card" role="menuitemradio" aria-checked={!remote} onClick={() => switchMachine(null)}>
        <span className="mc-card__head">
          <MachineGlyph name={local?.name} platform={local?.platform} tone="ok" size="lg" />
          <span className="mc-card__text">
            <span className="mc-card__name">{local?.name ?? "This Mac"}</span>
            <span className="mc-card__sub">This Mac</span>
          </span>
          {!remote && <span className="mc-card__check"><CheckIcon /></span>}
          <span className="mc-card__kbd">⌃1</span>
        </span>
        {!remote && <Stats summary={ownSummary} />}
      </button>

      {reachable.map((h) => {
        const i = hosts.indexOf(h) + 1;
        const isHere = h.id === here;
        const summary = isHere ? ownSummary : previews[h.id];
        const lat = latencyLabel(h.link);
        const tone = linkTone(h.link);
        return (
          <button type="button" className="mc-card" role="menuitemradio" aria-checked={isHere} key={h.id} onClick={() => switchMachine(h.id)}>
            <span className="mc-card__head">
              <MachineGlyph name={h.name} platform={h.platform} tone={tone} size="lg" />
              <span className="mc-card__text">
                <span className="mc-card__name">{hostLabel(h)}</span>
                <span className={"mc-card__sub" + (tone === "err" ? " is-err" : "")}>
                  {routeLabel(h.link)}{lat && <> · <span className="mono">{lat}</span></>}
                </span>
              </span>
              {isHere && <span className="mc-card__check"><CheckIcon /></span>}
              {shortcut(i) && <span className="mc-card__kbd">{shortcut(i)}</span>}
            </span>
            {h.link?.state === "live" && <Stats summary={summary} />}
            {h.link?.state === "live" && <SessionRows summary={summary} />}
          </button>
        );
      })}

      {offline.map((h) => (
        <button type="button" className="mc-card mc-card--quiet" key={h.id} onClick={() => switchMachine(h.id)}>
          <span className="mc-card__head">
            <MachineGlyph name={h.name} platform={h.platform} tone="off" size="lg" />
            <span className="mc-card__text">
              <span className="mc-card__name">{hostLabel(h)}</span>
              <span className="mc-card__sub">{routeLabel(h.link)}</span>
            </span>
            {shortcut(hosts.indexOf(h) + 1) && <span className="mc-card__kbd">{shortcut(hosts.indexOf(h) + 1)}</span>}
          </span>
        </button>
      ))}

      {canManageMachines() && <div className="acct-sep" />}
      {canManageMachines() && (
        <button type="button" className="acct-action" role="menuitem" onClick={onConnect}><PlusIcon />Connect a machine…</button>
      )}
      {canManageMachines() && hosts.length > 0 && (
        <button type="button" className="acct-action" role="menuitem" onClick={onAllMachines}><GridIcon />All machines</button>
      )}
      {canManageMachines() && (
        <button type="button" className="acct-action" role="menuitem" onClick={onRemoteAccess}><ShieldIcon />Remote access to this Mac</button>
      )}
    </div>,
    document.body,
  );
}
