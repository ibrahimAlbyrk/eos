// The Workflow Library: a grid of every saved definition (builtin + file + runtime,
// merged by GET /workflows/definitions) as cards carrying a provenance badge and a
// latest-run chip (derived from GET /workflows/runs?scope=recent, matched by name).
//
// Per-card actions follow the provenance rule (libraryModel): runtime graph defs are
// editable (Edit) + deletable (Delete); any graph def can be Duplicated into an
// editable copy; builtin/file defs are read-only. All editor-loading goes through
// onOpenInEditor(doc) — the host switches to the Editor tab with that graph loaded.
import { useCallback, useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import {
  isGraphDefinition, provenanceOf, isReadOnly, isDeletable, canEdit, canDuplicate,
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

function LibraryCard({ record, latestRun, existingNames, onOpenInEditor, onDeleted, onFlash, index }) {
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

  return (
    <div className="wf-lib-card" style={{ animationDelay: `${Math.min(index, 12) * 12}ms` }}>
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
        {canEdit(record) && (
          <button type="button" className="wfe-btn" onClick={() => onOpenInEditor(recordToDoc(record))}>Edit</button>
        )}
        {canDuplicate(record) && (
          <button type="button" className="wfe-btn" onClick={() => onOpenInEditor(duplicateDoc(record, existingNames))}>Duplicate</button>
        )}
        {isDeletable(record) && !confirming && (
          <button type="button" className="wfe-btn wfe-btn--danger" onClick={() => setConfirming(true)}>Delete</button>
        )}
        {confirming && (
          <span className="wf-lib-card__confirm">
            <span className="wf-lib-card__confirm-q">Delete?</span>
            <button type="button" className="wfe-btn wfe-btn--danger" disabled={busy} onClick={doDelete}>Yes</button>
            <button type="button" className="wfe-btn" disabled={busy} onClick={() => setConfirming(false)}>No</button>
          </span>
        )}
        {isReadOnly(record) && <span className="wf-lib-card__ro">read-only</span>}
      </div>
    </div>
  );
}

export function LibraryView({ onOpenInEditor }) {
  const { status, records, runs, error, reload } = useLibrary();
  const [notice, setNotice] = useState(null);
  const flash = (type, text) => setNotice({ type, text });
  const existingNames = records.map((r) => r.name);

  return (
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
              key={`${provenanceOf(record)}:${record.name}`}
              index={i}
              record={record}
              latestRun={latestRunFor(record.name, runs)}
              existingNames={existingNames}
              onOpenInEditor={onOpenInEditor}
              onDeleted={reload}
              onFlash={flash}
            />
          ))}
        </div>
      )}
    </div>
  );
}
