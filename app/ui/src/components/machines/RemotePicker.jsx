import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { useRemotePicker, finishRemotePick } from "../../state/remotePickerStore.js";
import { currentHost } from "../../lib/host.js";
import { hostLabel } from "../../state/hostsStore.js";
import { CheckIcon, CloseIcon } from "./icons.jsx";

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" />
    </svg>
  );
}

const parentOf = (p) => (p === "/" ? "/" : p.replace(/\/[^/]+\/?$/, "") || "/");

// Browses the controlled computer's disk (GET /fs/list through its facade) in
// place of the native picker, which would open on that computer's screen — or,
// when the request names a `source`, that disk (the Transfer tab's destination).
export function RemotePicker() {
  const { request } = useRemotePicker();
  const [dir, setDir] = useState(null);
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const localInput = useRef(null);

  const source = request?.source ?? null;
  const load = useCallback(async (path) => {
    setError(null);
    try {
      const r = await (source ? source.list(path) : api.listFiles(path));
      const list = (r?.entries ?? []).slice().sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
      setEntries(list);
      setDir(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [source]);

  useEffect(() => {
    if (!request) { setDir(null); setEntries([]); setSelected(new Set()); return; }
    const start = request.source ? request.source.home : currentHost()?.home;
    if (start) { void load(start); return; }
    void api.hostInfo().then((info) => load(info?.home ?? "/"));
  }, [request, load]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); finishRemotePick({ cancelled: true }); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request]);

  if (!request) return null;
  const files = request.mode === "files";
  const where = source?.where ?? hostLabel(currentHost());

  // Files on THIS Mac: copy them over and answer with where they landed, so
  // callers attach them like any file picked on that computer.
  const pickLocal = async (list) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    setUploading(true);
    setError(null);
    const results = await Promise.all(picked.map((f) => api.uploadPaste(f).catch(() => null)));
    setUploading(false);
    const paths = results.map((r) => r?.body?.path).filter(Boolean);
    if (paths.length) finishRemotePick({ paths });
    else setError(`Couldn't copy the files to ${where}.`);
  };
  const toggle = (p) => setSelected((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const choose = () => finishRemotePick(files ? { paths: [...selected] } : { path: dir });

  return (
    <div className="stg-overlay" onMouseDown={() => finishRemotePick({ cancelled: true })}>
      <div className="connect-sheet glass-pop rpick" role="dialog" aria-modal="true" aria-label={files ? "Choose files" : "Choose a folder"} onMouseDown={(e) => e.stopPropagation()}>
        <div className="connect-sheet__intro">
          <h2 className="stg-title" style={{ margin: 0 }}>{files ? `Choose files on ${where}` : `Choose a folder on ${where}`}</h2>
        </div>
        <div className="rpick__path">
          <button type="button" className="m-btn m-btn--sm" disabled={!dir || dir === "/"} onClick={() => void load(parentOf(dir))}>Up</button>
          <span className="mono">{dir ?? "…"}</span>
        </div>
        <div className="rpick__list">
          {error && <div className="connect-sheet__err" style={{ padding: 10 }}>{error}</div>}
          {!error && entries.length === 0 && <div className="machine-col__empty" style={{ padding: 10 }}>Empty folder</div>}
          {entries.map((e) => {
            const isDir = e.type === "directory";
            const on = selected.has(e.absolutePath);
            return (
              <button
                type="button"
                key={e.absolutePath}
                className={"rpick__row" + (on ? " on" : "") + (!isDir && !files ? " is-dim" : "")}
                onClick={() => (isDir ? void load(e.absolutePath) : files && toggle(e.absolutePath))}
                disabled={!isDir && !files}
              >
                <span className="rpick__ic">{isDir ? <FolderIcon /> : <FileIcon />}</span>
                <span className="rpick__name">{e.name}</span>
                {on && <span className="rpick__check"><CheckIcon /></span>}
              </button>
            );
          })}
        </div>
        <div className="connect-sheet__foot">
          <span className="connect-sheet__note">{files ? `${selected.size} selected` : "Opens the folder you're in."}</span>
          {files && !source && (
            <>
              <input ref={localInput} type="file" multiple hidden onChange={(e) => void pickLocal(e.target.files)} />
              <button type="button" className="m-btn" disabled={uploading} onClick={() => localInput.current?.click()}>
                {uploading ? "Copying…" : "From this Mac…"}
              </button>
            </>
          )}
          <button type="button" className="m-btn" onClick={() => finishRemotePick({ cancelled: true })}>Cancel</button>
          <button type="button" className="m-btn m-btn--accent" disabled={files ? selected.size === 0 : !dir} onClick={choose}>
            {files ? `Add ${selected.size || ""} file${selected.size === 1 ? "" : "s"}`.replace("  ", " ") : "Choose this folder"}
          </button>
        </div>
        <button type="button" className="stg-close" title="Close (Esc)" onClick={() => finishRemotePick({ cancelled: true })}><CloseIcon /></button>
      </div>
    </div>
  );
}
