import { useCallback, useEffect, useMemo, useState } from "react";
import { AppLayout } from "../../components/layout/AppLayout.jsx";
import { useUi } from "../../state/ui.jsx";
import { useNavigation } from "../../state/navigation.jsx";
import { api } from "../../api/client.js";
import {
  useHosts, ensureHostsLoaded, switchMachine, reconnectMachine, hostLabel, linkTone, routeLabel, latencyLabel, canSwitchMachines,
} from "../../state/hostsStore.js";
import { summarizeSessions } from "../../lib/machineSessions.js";
import { nameOf } from "../../lib/agentName.js";
import { MachineGlyph } from "../../components/machines/MachineGlyph.jsx";
import { MachinesSidebar } from "./MachinesSidebar.jsx";

const POLL_MS = 4000;

// What a pending permission wants, in a line.
function describePending(p) {
  try {
    const input = JSON.parse(p.input ?? "{}");
    if (typeof input.command === "string") return { lead: "Wants to run", code: input.command };
    if (typeof input.file_path === "string") return { lead: `Wants to ${p.tool_name === "Read" ? "read" : "edit"}`, code: input.file_path };
  } catch { /* fall through */ }
  return { lead: `Wants to use ${p.tool_name}`, code: null };
}

function MachineColumn({ glyph, title, sub, badge, workers, pending, onOpen, openLabel }) {
  const summary = summarizeSessions(workers, pending, 6);
  return (
    <div className="machine-col">
      <div className="mc-card__head">
        {glyph}
        <div className="mc-card__text">
          <span className="mc-card__name">{title}</span>
          <span className="mc-card__sub">{sub}</span>
        </div>
        {badge && <span className="m-pill"><span className="mono">{badge}</span></span>}
      </div>
      <div className="mc-stats">
        {summary.running > 0 && <span className="mc-stat"><span className="mc-dot" />{summary.running} running</span>}
        {summary.needs > 0 && <span className="mc-stat is-warn"><span className="mc-dot mc-dot--need" />{summary.needs} need{summary.needs === 1 ? "s" : ""} you</span>}
        {summary.total === 0 && <span className="mc-stat">No agents</span>}
      </div>
      <div className="machine-col__rows">
        {summary.rows.map((r) => (
          <div className="agents-row" key={r.id} style={{ cursor: "default" }}>
            <span className={`ag-dot ${r.needs ? "think" : r.dot}`} />
            <span className="ag-name">{r.name}</span>
            <span className="ag-status" style={r.needs ? { color: "var(--warn)" } : undefined}>{r.status}</span>
          </div>
        ))}
      </div>
      {onOpen && <button type="button" className="acct-action" style={{ marginTop: "auto" }} onClick={onOpen}>{openLabel}</button>}
    </div>
  );
}

// All machines: every computer this Mac drives in one place — what needs you
// (answered right here), and what each machine's agents are doing.
export function MachinesView({ live, hidden }) {
  const ui = useUi();
  const { setActiveView } = useNavigation();
  const { hosts, local } = useHosts();
  const [remote, setRemote] = useState({}); // id → { workers, pending }
  useEffect(() => { ensureHostsLoaded(); }, []);

  const liveHosts = useMemo(() => hosts.filter((h) => h.link?.state === "live"), [hosts]);
  const load = useCallback(async () => {
    const entries = await Promise.all(liveHosts.map(async (h) => {
      const [workers, pending] = await Promise.all([api.hostWorkers(h.id), api.hostPending(h.id)]);
      return [h.id, { workers: workers ?? [], pending: pending ?? [] }];
    }));
    setRemote(Object.fromEntries(entries));
  }, [liveHosts]);

  useEffect(() => {
    if (hidden) return;
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [hidden, load]);

  const localPending = (live.pendingPermissions ?? []).filter((p) => !p.resolved);
  const needs = [
    ...localPending.map((p) => ({ p, hostId: null, where: local?.name ?? "This Mac", worker: live.workers.find((w) => w.id === p.worker_id) })),
    ...liveHosts.flatMap((h) => (remote[h.id]?.pending ?? []).filter((p) => !p.resolved).map((p) => ({
      p, hostId: h.id, where: hostLabel(h), worker: remote[h.id]?.workers.find((w) => w.id === p.worker_id),
    }))),
  ];

  const decide = async (item, decision) => {
    if (!item.hostId) {
      if (decision === "allow") await live.approvePending(item.p.id);
      else await live.denyPending(item.p.id);
      return;
    }
    await api.hostDecidePending(item.hostId, item.p.id, decision).catch(() => {});
    void load();
  };
  const open = (item) => {
    if (item.hostId) { switchMachine(item.hostId); return; }
    setActiveView("agents");
    ui.setSelectedId(item.p.worker_id);
  };

  const totalRunning = summarizeSessions(live.workers, localPending).running
    + liveHosts.reduce((n, h) => n + summarizeSessions(remote[h.id]?.workers, remote[h.id]?.pending).running, 0);
  const offline = hosts.filter((h) => h.link?.state !== "live");

  const main = (
    <>
      <header className="pane-head">
        <div className="crumb">
          <span className="cur">All machines</span>
          <span className="scope">{liveHosts.length + 1} online · {totalRunning} running{needs.length ? ` · ${needs.length} need you` : ""}</span>
        </div>
      </header>
      <div className="machines-view">
        {needs.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="machines-view__label">Needs you</div>
            {needs.map((item) => {
              const what = describePending(item.p);
              return (
                <div className="needs-card" key={`${item.hostId ?? "local"}:${item.p.id}`}>
                  <span className="mc-dot mc-dot--need" />
                  <div className="needs-card__text">
                    <span className="needs-card__title">{item.worker ? nameOf(item.worker) : "Agent"} <span className="needs-card__where">· {item.where}</span></span>
                    <span className="needs-card__what">{what.lead}{what.code && <> <span className="ic">{what.code}</span></>}</span>
                  </div>
                  {(item.hostId == null || canSwitchMachines()) && <button type="button" className="m-btn m-btn--quiet m-btn--sm" onClick={() => open(item)}>Open</button>}
                  <button type="button" className="m-btn m-btn--sm" onClick={() => void decide(item, "deny")}>Deny</button>
                  <button type="button" className="m-btn m-btn--accent m-btn--sm" onClick={() => void decide(item, "allow")}>Allow once</button>
                </div>
              );
            })}
          </div>
        )}

        <div className="machines-grid">
          <MachineColumn
            glyph={<MachineGlyph name={local?.name} platform={local?.platform} tone="ok" size="lg" />}
            title={local?.name ?? "This Mac"}
            sub="This Mac"
            workers={live.workers}
            pending={localPending}
            onOpen={() => setActiveView("agents")}
            openLabel="Open agents"
          />
          {liveHosts.map((h) => (
            <MachineColumn
              key={h.id}
              glyph={<MachineGlyph name={h.name} platform={h.platform} tone={linkTone(h.link)} size="lg" />}
              title={hostLabel(h)}
              sub={routeLabel(h.link)}
              badge={latencyLabel(h.link)}
              workers={remote[h.id]?.workers}
              pending={remote[h.id]?.pending}
              onOpen={canSwitchMachines() ? () => switchMachine(h.id) : null}
              openLabel={`Switch to ${hostLabel(h)}`}
            />
          ))}
        </div>

        {offline.map((h) => (
          <div className="machine-offline" key={h.id}>
            <MachineGlyph name={h.name} platform={h.platform} tone={linkTone(h.link)} />
            <span><b>{hostLabel(h)}</b> · {routeLabel(h.link).toLowerCase()}</span>
            <button type="button" className="m-btn m-btn--quiet m-btn--sm" style={{ marginLeft: "auto" }} onClick={() => reconnectMachine(h.id)}>Retry</button>
          </div>
        ))}
      </div>
    </>
  );

  return <AppLayout sidebar={(variant) => <MachinesSidebar live={live} variant={variant} needs={needs.length} />} main={main} hidden={hidden} />;
}
