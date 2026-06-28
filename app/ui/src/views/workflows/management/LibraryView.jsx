// The Workflow Library: a grid of every saved definition (builtin + file + runtime,
// merged by GET /workflows/definitions) as cards carrying a provenance badge and a
// latest-run chip (derived from GET /workflows/runs?scope=recent, matched by name).
//
// Per-card actions follow the provenance rule (libraryModel): clicking a graph card
// opens it — a runtime def goes to the editor (editable), a read-only-provenance def
// opens IN PLACE as a read-only detail in this tab's main area (no jump to the Editor
// tab). Any graph def can be Duplicated into an editable copy (which does open the
// editor); runtime defs are also deletable. v1 tree defs (builtins) have no v2 render
// path, so their cards aren't openable. Editor-loading goes through onOpenInEditor(doc,
// { readOnly }); read-only previews go through onSelectReadOnly(record).
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../../api/client.js";
import { WorkflowSidebarPortal } from "../sidebarSlot.jsx";
import { graphFromDoc } from "../editor/graphModel.js";
import { ReadOnlyGraphCanvas } from "../editor/ReadOnlyGraphCanvas.jsx";
import {
  isGraphDefinition, provenanceOf, isReadOnly, isDeletable, canOpen, canDuplicate,
  latestRunFor, recordToDoc, duplicateDoc,
} from "./libraryModel.js";

function useLibrary() {
  const [state, setState] = useState({ status: "loading", records: [], runs: [], error: null });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: s.records.length ? s.status : "loading" }));
    try {
      const [records, runs] = await Promise.all([
        api.listWorkflowDefinitions(),
        api.listWorkflowRuns("recent"),
      ]);
      setState({
        status: "ready",
        records: Array.isArray(records) ? records : [],
        runs: Array.isArray(runs) ? runs : [],
        error: null,
      });
    } catch (e) {
      setState((s) => ({ ...s, status: "error", error: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

function LatestRunChip({ run }) {
  if (!run) return <span className="wf-lib-card__norun">no runs</span>;
  const status = run.status || "pending";
  return <span className={"wf-status wf-status-" + status}>{status}</span>;
}

function LibraryCard({ record, latestRun, existingNames, onOpenInEditor, onSelectReadOnly, selected, onDeleted, onFlash, index }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const source = provenanceOf(record);
  const graphKind = isGraphDefinition(record);

  const doDelete = async () => {
    setBusy(true);
    const r = await api.deleteWorkflow(record.name);
    setBusy(false);
    setConfirming(false);
    if (r.ok) { onFlash("ok", `deleted "${record.name}"`); onDeleted(); }
    else onFlash("err", `delete failed: ${r.body?.error || r.status}`);
  };

  const readOnly = isReadOnly(record);
  const openable = canOpen(record);
  // Read-only defs preview in place (Library main area); runtime defs open the editor.
  const open = () => {
    if (!openable) return;
    if (readOnly) onSelectReadOnly(record);
    else onOpenInEditor(recordToDoc(record), { readOnly: false });
  };

  // Duplicate/Delete sit inside the clickable card, so they swallow the click so it
  // doesn't ALSO open the card.
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };

  return (
    <div
      className={"wf-lib-card" + (openable ? " wf-lib-card--clickable" : "") + (selected ? " wf-lib-card--selected" : "")}
      style={{ animationDelay: `${Math.min(index, 12) * 12}ms` }}
      role={openable ? "button" : undefined}
      tabIndex={openable ? 0 : undefined}
      aria-pressed={openable ? selected : undefined}
      title={openable ? (readOnly ? "Preview (read-only)" : "Open in editor") : "v1 tree — graph view unavailable"}
      onClick={openable ? open : undefined}
      onKeyDown={openable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } : undefined}
    >
      <div className="wf-lib-card__head">
        <span className="wf-lib-card__name">{record.name}</span>
        <span className={"wf-prov wf-prov--" + source}>{source}</span>
      </div>
      <div className="wf-lib-card__desc">{record.description || "No description"}</div>
      <div className="wf-lib-card__meta">
        <span className="wf-lib-card__kind">
          {graphKind ? `graph · ${record.nodes?.length ?? 0} nodes` : "tree"}
        </span>
        <LatestRunChip run={latestRun} />
      </div>
      <div className="wf-lib-card__actions">
        {canDuplicate(record) && (
          <button type="button" className="wfe-btn" onClick={stop(() => onOpenInEditor(duplicateDoc(record, existingNames), { readOnly: false }))}>Duplicate</button>
        )}
        {isDeletable(record) && !confirming && (
          <button type="button" className="wfe-btn wfe-btn--danger" onClick={stop(() => setConfirming(true))}>Delete</button>
        )}
        {confirming && (
          <span className="wf-lib-card__confirm" onClick={(e) => e.stopPropagation()}>
            <span className="wf-lib-card__confirm-q">Delete?</span>
            <button type="button" className="wfe-btn wfe-btn--danger" disabled={busy} onClick={stop(doDelete)}>Yes</button>
            <button type="button" className="wfe-btn" disabled={busy} onClick={stop(() => setConfirming(false))}>No</button>
          </span>
        )}
        {readOnly && <span className="wf-lib-card__ro">read-only</span>}
      </div>
    </div>
  );
}

// The read-only in-place detail: a header + the shared read-only canvas host (canvas
// + locked inspector). Lives in the Library main area so a built-in opens here, not
// in the Editor tab.
function LibraryDetail({ record, onClose }) {
  const graph = useMemo(() => graphFromDoc(recordToDoc(record)), [record]);
  return (
    <div className="wf-lib-detail">
      <div className="wf-lib-detail__head">
        <span className="wf-lib-detail__name">{record.name}</span>
        <span className="wfe-ro-badge">read-only</span>
        <div className="wf-lib-detail__spacer" />
        <button type="button" className="wfe-btn" onClick={onClose}>Close</button>
      </div>
      <ReadOnlyGraphCanvas graph={graph} />
    </div>
  );
}

const cardKey = (record) => `${provenanceOf(record)}:${record.name}`;

export function LibraryView({ onOpenInEditor }) {
  const { status, records, runs, error, reload } = useLibrary();
  const [notice, setNotice] = useState(null);
  const [selected, setSelected] = useState(null); // read-only record previewed in place
  const flash = (type, text) => setNotice({ type, text });
  const existingNames = records.map((r) => r.name);
  const selectedKey = selected ? cardKey(selected) : null;

  return (
    <>
      {/* The library list lives in the left sidebar (under the switcher); the main
          area shows a hint, or a read-only def's preview when one is selected. */}
      <WorkflowSidebarPortal>
        <div className="wf-lib">
          <div className="wf-lib__bar">
            <div className="wf-lib__title">Library</div>
            <button type="button" className="wfe-btn" onClick={reload} disabled={status === "loading"}>Refresh</button>
            {notice && <span className={"wfe-notice wfe-notice--" + notice.type}>{notice.text}</span>}
          </div>

          {status === "loading" && <div className="wf-lib__state">Loading workflows…</div>}
          {status === "error" && (
            <div className="wf-lib__state wf-lib__state--err">
              Couldn’t load workflows{error ? `: ${error}` : ""}.
              <button type="button" className="wfe-btn" onClick={reload}>Retry</button>
            </div>
          )}
          {status === "ready" && records.length === 0 && (
            <div className="wf-lib__state">No workflows yet. Author one in the Editor and Save it.</div>
          )}
          {status === "ready" && records.length > 0 && (
            <div className="wf-lib__grid">
              {records.map((record, i) => (
                <LibraryCard
                  key={cardKey(record)}
                  index={i}
                  record={record}
                  latestRun={latestRunFor(record.name, runs)}
                  existingNames={existingNames}
                  onOpenInEditor={onOpenInEditor}
                  onSelectReadOnly={setSelected}
                  selected={selectedKey === cardKey(record)}
                  onDeleted={reload}
                  onFlash={flash}
                />
              ))}
            </div>
          )}
        </div>
      </WorkflowSidebarPortal>
      <div className="wf-lib-main">
        {selected ? (
          <LibraryDetail record={selected} onClose={() => setSelected(null)} />
        ) : (
          <div className="wf-lib-main__hint">
            Browse saved workflows in the left panel. Click a built-in to preview it read-only here; click a runtime workflow to edit it. Use Duplicate to start an editable copy.
          </div>
        )}
      </div>
    </>
  );
}
