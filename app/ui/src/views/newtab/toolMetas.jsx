import { useCallback, useEffect, useSyncExternalStore } from "react";
import { subscribe as subscribeDiff, getSnapshot as getDiff, revalidate as revalidateDiff } from "../../state/diffStore.js";
import { useSubagents } from "../../state/subagentsStore.js";
import { isActive, useTransfers } from "../../state/transfersStore.js";
import { useArtifactCatalog } from "../../state/artifactCatalogStore.js";

// The quiet second line of each new-tab launcher tile: live state where the
// panel has it cheaply. `scope` = { project, workerId } of the launcher's pane.

const baseName = (p) => (p ? p.replace(/\/+$/, "").split("/").pop() : "");

function Meta({ children, mono }) {
  return <span className={"nt-tool__meta" + (mono ? " nt-tool__meta--mono" : "")}>{children}</span>;
}

export function TerminalMeta({ scope }) {
  const folder = baseName(scope.project);
  return <Meta>{folder ? `Shell in ${folder}` : "Shell"}</Meta>;
}

export function FilesMeta({ scope }) {
  const folder = baseName(scope.project);
  return <Meta>{folder ? `Browse ${folder}` : "Open a folder"}</Meta>;
}

export const PageMeta = () => <Meta>Notes and tasks</Meta>;
export const ChatFilesMeta = () => <Meta>Shared in this chat</Meta>;

const NO_DIFF = { changes: null };

export function DiffMeta({ scope }) {
  const { workerId } = scope;
  const snap = useSyncExternalStore(
    useCallback((cb) => (workerId ? subscribeDiff(workerId, cb) : () => {}), [workerId]),
    useCallback(() => (workerId ? getDiff(workerId) : NO_DIFF), [workerId]),
  );
  useEffect(() => { if (workerId) void revalidateDiff(workerId); }, [workerId]);
  const files = snap.changes?.files ?? [];
  if (!files.length) return <Meta>{workerId ? "No changes" : "Diff and history"}</Meta>;
  const add = files.reduce((n, f) => n + (f.insertions ?? 0), 0);
  const del = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  return (
    <Meta mono>
      <span className="nt-add">+{add}</span> <span className="nt-del">−{del}</span>
    </Meta>
  );
}

export function SubagentMeta({ scope }) {
  const runs = useSubagents(scope.workerId);
  const running = (runs ?? []).filter((r) => r.status === "running").length;
  return <Meta>{running ? `${running} running` : "Background agents"}</Meta>;
}

export function TransferMeta() {
  const list = useTransfers();
  const moving = (list ?? []).filter(isActive).length;
  return <Meta>{moving ? `${moving} copying` : "Between your Macs"}</Meta>;
}

export function ArtifactsMeta() {
  const { loaded, artifacts } = useArtifactCatalog({ load: false });
  return <Meta>{loaded && artifacts.length ? `${artifacts.length} on claude.ai` : "From your Claude accounts"}</Meta>;
}
