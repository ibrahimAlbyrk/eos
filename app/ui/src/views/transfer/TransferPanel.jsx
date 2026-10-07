import { useEffect, useMemo, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { usePanelHost } from "../../state/panelHost.js";
import { ensureHostsLoaded, requestConnect, switchMachine } from "../../state/hostsStore.js";
import { ensureTransfersLoaded, isActive, noteTransfer, useTransfers } from "../../state/transfersStore.js";
import { requestRemotePick } from "../../state/remotePickerStore.js";
import { canBrowse, transferMode, transfers, viewedMachine } from "../../lib/transferClient.js";
import { findLeaf } from "../../lib/paneLayout.js";
import { workerGitDir } from "../../lib/workerGitDir.js";
import { projectPathFor } from "../../lib/breadcrumb.js";
import { currentHost } from "../../lib/host.js";
import { formatBytes } from "../../lib/format.js";
import { PanelShell } from "../agents/panes/PanelShell.jsx";
import { RouteHeader } from "./RouteHeader.jsx";
import { SourceBrowser } from "./SourceBrowser.jsx";
import { Destination } from "./Destination.jsx";
import { TransferCard } from "./TransferCard.jsx";
import { RecentTransfers } from "./RecentTransfers.jsx";
import { useMachines } from "./useMachines.js";
import { IntoIcon, OutIcon, TransferIcon } from "./icons.jsx";

const STALLED = new Set(["paused", "interrupted"]);
const FINISHED = new Set(["done", "failed", "cancelled"]);

// Side-panel tab: copy files between this Mac and a paired one. From ⇄ To, the
// source's folders to tick things in, where they land, and the transfers in
// flight. Plan: docs/transfer/00-TRANSFER-PLAN.md.
export function TransferPanel({ live }) {
  useEffect(() => { ensureHostsLoaded(); ensureTransfersLoaded(); }, []);
  const machines = useMachines();
  if (transferMode() === "none") {
    return (
      <Empty
        title="Transfers run from your Mac"
        subtitle="This view runs that Mac’s own Eos build, which can’t reach your Mac. Open your Mac’s window to send files."
        action={{ label: "Go to your Mac", run: () => switchMachine(null) }}
      />
    );
  }
  if (!machines.peers.length) {
    return (
      <Empty
        title="No other Mac yet"
        subtitle="Pair another Mac to send files between them."
        action={{ label: "Connect a machine", run: requestConnect }}
      />
    );
  }
  return <TransferBody live={live} machines={machines} />;
}

function TransferBody({ live, machines }) {
  const ui = useUi();
  const all = useTransfers();
  const [mountedAt] = useState(() => Date.now());
  const [peerRef, setPeerRef] = useState(() => ui.panelData?.transfer?.peer ?? defaultPeer(machines.peers, all));
  const peer = machines.peers.find((m) => m.ref === peerRef) ?? machines.peers[0];
  // Pull (that Mac → yours) first: bringing back what an agent made over there is the usual errand.
  const [pull, setPull] = useState(true);
  const from = pull ? peer : machines.local;
  const to = pull ? machines.local : peer;
  const [selected, setSelected] = useState(() => new Map());
  const [chosen, setChosen] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => new Set());

  useEffect(() => { setSelected(new Map()); setChosen(null); setError(null); }, [from.ref, to.ref]);

  const project = useChatProject(live);
  const projectOnSource = useProjectOn(from.ref, project);
  const browsable = canBrowse(from.ref);
  const paths = useMemo(() => [...selected.keys()], [selected]);
  const dest = useDestination({ from: from.ref, to: to.ref, paths, chosen, project, browsable });

  const toggle = (e) => setSelected((cur) => {
    const next = new Map(cur);
    if (next.has(e.path)) next.delete(e.path);
    else {
      // A ticked folder takes whatever was ticked inside it.
      for (const p of next.keys()) if (p.startsWith(`${e.path}/`)) next.delete(p);
      next.set(e.path, e);
    }
    return next;
  });

  const changeDest = async () => {
    setError(null);
    try {
      if (!canBrowse(to.ref)) {
        const r = await transfers.chooseLocalFolder();
        if (r?.destDir) setChosen({ destDir: r.destDir, native: true });
        return;
      }
      // Opens where the copy would land, if that folder exists yet; else at home.
      const at = dest?.destDir ? await transfers.browse(to.ref, dest.destDir).then((l) => l.path, () => null) : null;
      const start = at ?? (await transfers.browse(to.ref, null)).home;
      const r = await requestRemotePick("directory", {
        home: start,
        where: to.label,
        list: async (p) => ({ entries: (await transfers.browse(to.ref, p)).entries.map((e) => ({ name: e.name, absolutePath: e.path, type: e.type })) }),
      });
      if (r?.path) setChosen({ destDir: r.path });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const send = async () => {
    setError(null);
    setBusy(true);
    try {
      const t = browsable
        ? await transfers.start({ from: from.ref, to: to.ref, paths, destDir: chosen?.native ? null : chosen?.destDir ?? dest?.destDir ?? null, chosen: Boolean(chosen?.native) })
        : await transfers.pickAndSend({ destDir: dest?.destDir });
      if (t) { noteTransfer(t); setSelected(new Map()); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const list = all ?? [];
  const cards = list.filter((t) => isActive(t) || STALLED.has(t.status)
    || ((t.status === "done" || t.status === "failed") && (t.finishedAt ?? 0) >= mountedAt && !dismissed.has(t.id)));
  const shown = new Set(cards.map((t) => t.id));
  const recent = list.filter((t) => FINISHED.has(t.status) && !shown.has(t.id));
  const dismiss = (id) => setDismissed((s) => new Set(s).add(id));

  const known = [...selected.values()];
  const size = known.every((e) => e.type === "file") ? known.reduce((n, e) => n + (e.size ?? 0), 0) : null;
  const summary = known.length ? `${known.length} item${known.length === 1 ? "" : "s"}${size != null ? ` · ${formatBytes(size)}` : ""}` : "Nothing selected";

  return (
    <PanelShell type="transfer">
      <div className="tx">
        <div className="tx-scroll">
          <RouteHeader from={from} to={to} peer={peer} peers={machines.peers} onPickPeer={setPeerRef} onSwap={() => setPull((p) => !p)} />
          {cards.length > 0 && (
            <div className="tx-cards">
              {cards.map((t) => <TransferCard key={t.id} t={t} label={machines.label} onDismiss={() => dismiss(t.id)} />)}
            </div>
          )}
          {browsable ? (
            projectOnSource.ready
              ? <SourceBrowser machine={from.ref} startPath={projectOnSource.path} project={projectOnSource.path} selected={selected} onToggle={toggle} />
              : <div className="tx-list"><div className="tx-list__note">Loading…</div></div>
          ) : (
            <div className="tx-pick">
              <span className="tx-pick__ic"><TransferIcon /></span>
              <span className="tx-pick__text">Files on {from.label} are picked with its own file picker, so this view never sees its disk.</span>
            </div>
          )}
          <Destination dest={browsable && !paths.length && !chosen ? null : dest} toLabel={to.label} onChange={() => void changeDest()} />
          <RecentTransfers items={recent} label={machines.label} onClear={() => void transfers.clear().then(() => { for (const t of recent) dismiss(t.id); })} />
        </div>
        {error && <div className="tx-error">{error}</div>}
        <div className="tx-bar">
          <span className="tx-bar__sum">{browsable ? summary : `To ${to.label}`}</span>
          <button type="button" className="m-btn m-btn--accent" disabled={busy || (browsable && (!paths.length || !dest))} onClick={() => void send()}>
            {pull ? <IntoIcon /> : <OutIcon />}
            {browsable ? `Copy to ${to.label}` : `Choose files on ${from.label}…`}
          </button>
        </div>
      </div>
    </PanelShell>
  );
}

function Empty({ title, subtitle, action }) {
  return (
    <PanelShell type="transfer">
      <div className="empty-state">
        <span className="empty-state__icon">
          <svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13" /></svg>
        </span>
        <span className="empty-state__title">{title}</span>
        <span className="empty-state__subtitle">{subtitle}</span>
        {action && <button type="button" className="empty-state__action" onClick={action.run}>{action.label}</button>}
      </div>
    </PanelShell>
  );
}

// The paired Mac last used, if it's still around; else one that's online.
function defaultPeer(peers, all) {
  const last = (all ?? []).map((t) => (t.from === "local" ? t.to : t.from)).find((ref) => peers.some((p) => p.ref === ref));
  return last ?? peers.find((p) => p.link?.state === "live")?.ref ?? peers[0]?.ref ?? null;
}

// The folder of the chat this panel sits beside, as a path on the viewed machine.
function useChatProject(live) {
  const ui = useUi();
  const host = usePanelHost();
  if (host) return host.cwd ?? null;
  const workers = live?.workers ?? [];
  const id = findLeaf(ui.tree, ui.paneId)?.agentId ?? ui.selectedId ?? null;
  return workerGitDir(workers.find((w) => w.id === id)) ?? projectPathFor(workers, id) ?? null;
}

// That project on `machine`: itself where it lives, else the checkout of the same
// repo there (by git remote). `ready` once known, so browsing starts in the right place.
function useProjectOn(machine, project) {
  const viewed = viewedMachine();
  const [state, setState] = useState({ key: null, path: null });
  const key = `${machine}\n${project ?? ""}`;
  useEffect(() => {
    let on = true;
    if (!project || machine === viewed || !canBrowse(machine)) return undefined;
    void (async () => {
      const k = await transfers.projectKey(viewed, project).catch(() => null);
      const path = k ? await transfers.locate(machine, k).catch(() => null) : null;
      if (on) setState({ key, path });
    })();
    return () => { on = false; };
  }, [key, machine, project, viewed]);
  if (!project) return { ready: true, path: null };
  if (machine === viewed) return { ready: true, path: project };
  return state.key === key ? { ready: true, path: state.path } : { ready: false, path: null };
}

// Where the picked items land: a folder the user chose, else the engine's pick
// (the same project there, else ~/Downloads/Eos). Sending this Mac's files from a
// view of another Mac has nothing picked yet — it lands in the chat's project there.
function useDestination({ from, to, paths, chosen, project, browsable }) {
  const [suggested, setSuggested] = useState(null);
  useEffect(() => {
    let on = true;
    setSuggested(null);
    if (chosen || !browsable || !paths.length) return undefined;
    const t = setTimeout(() => {
      transfers.destination({ from, to, paths }).then((d) => { if (on) setSuggested(d); }, () => {});
    }, 200);
    return () => { on = false; clearTimeout(t); };
  }, [from, to, paths, chosen, browsable]);
  if (chosen) return { destDir: chosen.destDir, reason: "chosen" };
  if (!browsable) {
    const home = currentHost()?.home;
    return project ? { destDir: project, reason: "chosen" } : home ? { destDir: `${home}/Downloads/Eos`, reason: "default" } : null;
  }
  return suggested;
}
