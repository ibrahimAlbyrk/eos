import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../../api/client.js";
import { highlightAsync } from "../../../lib/asyncHighlight.js";
import { useWorkerConflicts } from "../../../hooks/useWorkerConflicts.js";

// Merge-conflict resolution, folded into the Git Diff panel as a prominent
// section above the file list. Ported verbatim from the former standalone
// ConflictResolver panel — same worker-scoped data source (useWorkerConflicts /
// conflictStore) and the same resolve contract; only the shell changed. The
// section is worker-scoped because resolution writes a `git add` + a
// conflict_resolved event to that worker's transcript; it renders only when the
// panel was opened from a worker context and the repo actually has conflicts.

// Whole-file keep/remove choices for the markerless add/delete kinds. The
// `side` matches the server's takeSide() contract; `danger` flags the
// destructive option.
const DELETE_CHOICES = {
  "theirs-deleted": [{ side: "ours", label: "Keep our version" }, { side: "theirs", label: "Accept deletion", danger: true }],
  "ours-deleted": [{ side: "theirs", label: "Restore their version" }, { side: "ours", label: "Keep deletion", danger: true }],
  "ours-added": [{ side: "ours", label: "Keep our file" }, { side: "theirs", label: "Discard file", danger: true }],
  "theirs-added": [{ side: "theirs", label: "Keep their file" }, { side: "ours", label: "Discard file", danger: true }],
  "both-deleted": [{ side: "theirs", label: "Confirm deletion", danger: true }],
};

function renderTokens(tokens) {
  return tokens.map((tok, k) => (tok.c ? <span key={k} className={tok.c}>{tok.t}</span> : tok.t));
}

// One side's lines, syntax-highlighted off the main thread (plain text until the
// worker answers). Trailing \r (CRLF files) is stripped for display only.
function HighlightedLines({ lines, path }) {
  const text = useMemo(() => lines.map((l) => l.replace(/\r$/, "")).join("\n"), [lines]);
  const [hl, setHl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    highlightAsync(text, path).then((r) => { if (!cancelled) setHl(r); });
    return () => { cancelled = true; };
  }, [text, path]);
  return (
    <div className="cr-lines">
      {lines.map((ln, i) => (
        <div className="cr-line" key={i}>
          <span className="cr-line-text">{hl?.[i] ? renderTokens(hl[i]) : (ln.replace(/\r$/, "") || " ")}</span>
        </div>
      ))}
    </div>
  );
}

// Unchanged region around a conflict: small ones in full (dim), large ones
// collapsed to a single marker — the operator is here for the conflicts.
function ContextBlock({ lines }) {
  if (lines.length > 6) {
    return <div className="cr-context cr-context-fold">⋯ {lines.length} unchanged lines</div>;
  }
  return (
    <div className="cr-context">
      {lines.map((ln, i) => <div className="cr-line" key={i}><span className="cr-line-text">{ln.replace(/\r$/, "") || " "}</span></div>)}
    </div>
  );
}

function SideBlock({ label, side, lines, path, selected, onClick }) {
  return (
    <div className={"cr-side cr-side-" + side + (selected ? " sel" : "") + (onClick ? " pickable" : "")} onClick={onClick}>
      <div className="cr-side-head">
        <span>{label}</span>
        {onClick && selected && <span className="cr-side-chk">✓ chosen</span>}
      </div>
      {lines.length === 0
        ? <div className="cr-side-empty">(empty on this side)</div>
        : <HighlightedLines lines={lines} path={path} />}
    </div>
  );
}

function ConflictHunk({ index, seg, path, picked, editing, editText, onPick, onToggleEdit, onEditText }) {
  const [showBase, setShowBase] = useState(false);
  const rows = Math.min(24, Math.max(3, editText.split("\n").length + 1));
  return (
    <div className={"cr-hunk" + (picked || editing ? " resolved" : "")}>
      <div className="cr-hunk-bar">
        <span className="cr-hunk-label">Conflict {index + 1}</span>
        <span className="cr-grow" />
        {!editing && (
          <div className="cr-pick">
            <button className={"cr-pick-btn" + (picked === "ours" ? " on" : "")} onClick={() => onPick(seg.id, "ours")}>Ours</button>
            <button className={"cr-pick-btn" + (picked === "theirs" ? " on" : "")} onClick={() => onPick(seg.id, "theirs")}>Theirs</button>
          </div>
        )}
        {seg.base && !editing && (
          <button className={"cr-mini-btn" + (showBase ? " on" : "")} onClick={() => setShowBase((b) => !b)}>Base</button>
        )}
        <button className={"cr-mini-btn" + (editing ? " on" : "")} onClick={() => onToggleEdit(seg)}>Edit</button>
      </div>
      {!editing && (
        <>
          <SideBlock label="Ours (HEAD)" side="ours" lines={seg.ours} path={path} selected={picked === "ours"} onClick={() => onPick(seg.id, "ours")} />
          {showBase && seg.base && <SideBlock label="Base" side="base" lines={seg.base} path={path} />}
          <SideBlock label="Theirs" side="theirs" lines={seg.theirs} path={path} selected={picked === "theirs"} onClick={() => onPick(seg.id, "theirs")} />
        </>
      )}
      {editing && (
        <textarea
          className="cr-edit"
          value={editText}
          spellCheck={false}
          rows={rows}
          onChange={(e) => onEditText(seg.id, e.target.value)}
        />
      )}
    </div>
  );
}

function ContentResolver({ workerId, file, doc, refresh, reload }) {
  const [pick, setPick] = useState(() => new Map());
  const [editing, setEditing] = useState(() => new Set());
  const [edits, setEdits] = useState(() => new Map());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const onPick = useCallback((id, side) => {
    setPick((prev) => new Map(prev).set(id, side));
    setEditing((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
  }, []);

  const onToggleEdit = useCallback((seg) => {
    setEditing((prev) => {
      const n = new Set(prev);
      if (n.has(seg.id)) { n.delete(seg.id); return n; }
      n.add(seg.id);
      return n;
    });
    setEdits((prev) => {
      if (prev.has(seg.id)) return prev;
      const base = pick.get(seg.id) === "theirs" ? seg.theirs : seg.ours;
      return new Map(prev).set(seg.id, base.map((l) => l.replace(/\r$/, "")).join("\n"));
    });
  }, [pick]);

  const onEditText = useCallback((id, text) => setEdits((prev) => new Map(prev).set(id, text)), []);

  const hunks = doc.segments.filter((s) => s.kind === "conflict");
  const isResolved = (s) => editing.has(s.id) || pick.has(s.id);
  const unresolved = hunks.filter((s) => !isResolved(s)).length;

  const apply = async () => {
    setBusy(true);
    setErr(null);
    const resolutions = hunks.map((s) =>
      editing.has(s.id)
        ? { id: s.id, manual: (edits.get(s.id) ?? "").split("\n") }
        : { id: s.id, choice: pick.get(s.id) },
    );
    const r = await api.resolveWorkerConflict(workerId, { path: file.path, fingerprint: doc.fingerprint, resolutions });
    setBusy(false);
    if (r.ok && r.body?.ok) { refresh(); return; }
    const reason = r.body?.reason ?? r.body?.error;
    if (reason === "stale") { setErr("The file changed underneath — reloaded, please re-pick."); reload(); return; }
    setErr(reason ? `Could not resolve: ${reason}` : "Could not resolve");
  };

  if (doc.style === "unparseable") {
    return (
      <div className="cr-note cr-note-warn">
        These conflict markers couldn't be parsed automatically. Resolve with the git button (⌘G) or edit the file directly.
      </div>
    );
  }

  let conflictIndex = -1;
  return (
    <div className="cr-content">
      {doc.segments.map((seg, i) => {
        if (seg.kind === "context") return <ContextBlock key={i} lines={seg.lines} />;
        conflictIndex++;
        return (
          <ConflictHunk
            key={seg.id}
            index={conflictIndex}
            seg={seg}
            path={file.path}
            picked={pick.get(seg.id) ?? null}
            editing={editing.has(seg.id)}
            editText={edits.get(seg.id) ?? ""}
            onPick={onPick}
            onToggleEdit={onToggleEdit}
            onEditText={onEditText}
          />
        );
      })}
      <div className="cr-apply">
        <span className={unresolved ? "cr-unresolved" : "cr-ready"}>
          {unresolved ? `${unresolved} hunk${unresolved > 1 ? "s" : ""} left` : "All hunks resolved"}
        </span>
        <button className="dv-act dv-act-apply" disabled={unresolved > 0 || busy} onClick={apply}>
          {busy ? "Applying…" : "Apply → stage"}
        </button>
      </div>
      {err && <div className="cr-err">{err}</div>}
    </div>
  );
}

function DeleteResolver({ workerId, file, refresh }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const choices = DELETE_CHOICES[file.kind] ?? [];

  const choose = async (side) => {
    setBusy(true);
    setErr(null);
    const r = await api.resolveWorkerConflict(workerId, { path: file.path, side });
    setBusy(false);
    if (r.ok && r.body?.ok) { refresh(); return; }
    const reason = r.body?.reason ?? r.body?.error;
    setErr(reason ? `Could not resolve: ${reason}` : "Could not resolve");
  };

  return (
    <div className="cr-delete">
      <div className="cr-note">One side changed this file while the other removed it — pick the outcome.</div>
      <div className="cr-delete-actions">
        {choices.map((c) => (
          <button key={c.side + c.label} className={"dv-act" + (c.danger ? " dv-act-err" : " dv-act-apply")} disabled={busy} onClick={() => choose(c.side)}>
            {c.label}
          </button>
        ))}
      </div>
      {err && <div className="cr-err">{err}</div>}
    </div>
  );
}

const ConflictFileCard = memo(function ConflictFileCard({ workerId, file, docEntry, loadDoc, refresh }) {
  const [open, setOpen] = useState(true);
  const isContent = file.kind === "content";

  useEffect(() => {
    if (open && isContent && !docEntry?.data && !docEntry?.loading) loadDoc(file.path);
  }, [open, isContent, docEntry, file.path, loadDoc]);

  const doc = docEntry?.data;
  return (
    <div className={"cr-file" + (open ? " open" : "")}>
      <button className="cr-file-row" onClick={() => setOpen((o) => !o)}>
        <svg className="cr-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 4 4 4-4 4" />
        </svg>
        <span className="cr-file-path">{file.path}</span>
        <span className="cr-grow" />
        <span className="cr-kind">{file.kind === "content" ? "both modified" : file.kind.replace("-", " ")}</span>
      </button>
      {open && (
        isContent
          ? (docEntry?.error
              ? <div className="cr-note cr-note-warn">{docEntry.error}</div>
              : doc
                ? <ContentResolver workerId={workerId} file={file} doc={doc} refresh={refresh} reload={() => loadDoc(file.path)} />
                : <div className="cr-note">Parsing…</div>)
          : <DeleteResolver workerId={workerId} file={file} refresh={refresh} />
      )}
    </div>
  );
});

// Conflicts section for the Git Diff panel. Renders nothing until the list has
// loaded and only when there is at least one conflict — so it costs no vertical
// space in the common clean-tree case.
export function GitDiffConflicts({ workerId, live }) {
  const { list, docs, refresh, loadDoc } = useWorkerConflicts(workerId, live);

  if (!list || list.length === 0) return null;

  return (
    <div className="gd-conflicts">
      <div className="gd-conflicts-head">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 1.5L13 12H1L7 1.5z" />
          <line x1="7" y1="5.5" x2="7" y2="8.5" />
          <circle cx="7" cy="10.3" r="0.4" fill="currentColor" stroke="none" />
        </svg>
        <span className="gd-conflicts-title">Conflicts</span>
        <span className="gd-conflicts-count">{list.length}</span>
      </div>
      <div className="gd-conflicts-list">
        {list.map((f) => (
          <ConflictFileCard
            key={f.path}
            workerId={workerId}
            file={f}
            docEntry={docs.get(f.path)}
            loadDoc={loadDoc}
            refresh={refresh}
          />
        ))}
      </div>
    </div>
  );
}
