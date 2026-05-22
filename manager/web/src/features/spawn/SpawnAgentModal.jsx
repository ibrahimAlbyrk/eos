// Unified spawn modal: pick agent type at the top, fields swap accordingly.
//   Orchestrator → name + cwd (model always opus, locked).
//   Worker → prompt + name + model + cwd/worktree mode.
// Returns the spawned id via the onSpawned callback so callers can select
// the new agent in the list immediately.

import { memo, useState, useEffect, useRef } from "react";
import { CONFIG } from "../../config.js";
import { Icon } from "../../components/primitives.jsx";
import { api } from "../../api/client.js";
import { PathField } from "./PathField.jsx";
import { pushRecentPath } from "./recents.js";

export const SpawnAgentModal = memo(function SpawnAgentModal({ open, onClose, onSpawned, initialKind = "orchestrator" }) {
  const [kind, setKind] = useState(initialKind);
  // shared
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // orchestrator
  const [orchCwd, setOrchCwd] = useState("");
  // worker
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(CONFIG.spawnModels[0]);
  const [mode, setMode] = useState("cwd");
  const [cwd, setCwd] = useState("");
  const [worktreeFrom, setWorktreeFrom] = useState("");
  const [branch, setBranch] = useState("");
  const dialogRef = useRef(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setErr(null);
      setBusy(false);
    } else {
      // Reset everything when closed so reopening is clean.
      setName(""); setOrchCwd(""); setPrompt(""); setCwd(""); setWorktreeFrom(""); setBranch("");
    }
  }, [open, initialKind]);

  if (!open) return null;

  const submitOrchestrator = async () => {
    if (!orchCwd.trim()) { setErr("working directory required"); return; }
    setBusy(true);
    try {
      // Name optional — daemon auto-generates "<adj>-<NNN>-orchestrator" when blank.
      const res = await window.live.spawnOrchestrator({ name: name.trim() || undefined, cwd: orchCwd.trim() });
      if (!res.ok) { setErr(res.error || "spawn failed"); setBusy(false); return; }
      pushRecentPath(orchCwd.trim());
      window.live.refresh();
      onSpawned && onSpawned(res.id);
      onClose();
    } catch (e) { setErr(String(e.message || e)); setBusy(false); }
  };

  const submitWorker = async () => {
    if (!prompt.trim()) { setErr("prompt required"); return; }
    const loc = mode === "cwd" ? cwd.trim() : worktreeFrom.trim();
    if (!loc) { setErr(mode === "cwd" ? "cwd required" : "worktreeFrom required"); return; }
    setBusy(true);
    try {
      const body = { prompt: prompt.trim(), name: name.trim() || undefined, model };
      if (mode === "cwd") body.cwd = cwd.trim();
      else { body.worktreeFrom = worktreeFrom.trim(); if (branch.trim()) body.branch = branch.trim(); }
      const r = await api.spawnWorker(body);
      if (!r.ok) {
        setErr(r.body?.error || `daemon ${r.status}`); setBusy(false); return;
      }
      pushRecentPath(mode === "cwd" ? cwd.trim() : worktreeFrom.trim());
      window.live.refresh();
      onSpawned && onSpawned(r.body.id);
      onClose();
    } catch (e) { setErr(String(e.message || e)); setBusy(false); }
  };

  const submit = () => { setErr(null); kind === "orchestrator" ? submitOrchestrator() : submitWorker(); };

  return (
    <dialog
      ref={dialogRef}
      className="vb-modal-overlay"
      aria-labelledby="spawn-modal-title"
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => { if (e.target === dialogRef.current) onClose(); }}
    >
      <div className="vb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="vb-modal__head">
          <div className="vb-modal__title" id="spawn-modal-title">Spawn agent</div>
          <button className="vb-iconbtn" onClick={onClose} aria-label="Close spawn dialog"><Icon name="cross" size={14} /></button>
        </div>
        <div className="vb-modal__body">
          <div className="vb-field">
            <span>Type</span>
            <div className="vb-segpick">
              <button type="button" className={`vb-segpick__btn ${kind === "orchestrator" ? "is-active" : ""}`} onClick={() => setKind("orchestrator")}>Orchestrator</button>
              <button type="button" className={`vb-segpick__btn ${kind === "worker" ? "is-active" : ""}`} onClick={() => setKind("worker")}>Worker</button>
            </div>
          </div>

          {kind === "orchestrator" ? (
            <>
              <label className="vb-field">
                <span>Name (optional)</span>
                <input placeholder="auto-generated if blank (e.g. swift-742-orchestrator)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </label>
              <label className="vb-field">
                <span>Working directory</span>
                <PathField placeholder="/Users/me/Projects/foo or ~/Projects/foo" value={orchCwd} onChange={setOrchCwd} />
              </label>
              <div style={{ marginTop: 4, opacity: 0.7, fontSize: 12 }}>
                Workers this orchestrator spawns will always run in the directory above. Model is always Opus.
              </div>
            </>
          ) : (
            <>
              <label className="vb-field">
                <span>Prompt</span>
                <textarea rows={4} placeholder="What should the worker do?" value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus />
              </label>
              <div className="vb-field-row">
                <label className="vb-field">
                  <span>Name (optional)</span>
                  <input placeholder="e.g. refactor-auth" value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="vb-field">
                  <span>Model</span>
                  <select value={model} onChange={(e) => setModel(e.target.value)}>
                    {CONFIG.spawnModels.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
              </div>
              <div className="vb-field">
                <span>Working directory</span>
                <div className="vb-segpick">
                  <button type="button" className={`vb-segpick__btn ${mode === "cwd" ? "is-active" : ""}`} onClick={() => setMode("cwd")}>cwd (plain dir)</button>
                  <button type="button" className={`vb-segpick__btn ${mode === "worktree" ? "is-active" : ""}`} onClick={() => setMode("worktree")}>worktree (git)</button>
                </div>
              </div>
              {mode === "cwd" ? (
                <label className="vb-field">
                  <span>Path</span>
                  <PathField placeholder="/Users/me/Projects/foo or ~/Desktop" value={cwd} onChange={setCwd} />
                </label>
              ) : (
                <>
                  <label className="vb-field">
                    <span>Repo path</span>
                    <PathField placeholder="/path/to/git/repo" value={worktreeFrom} onChange={setWorktreeFrom} />
                  </label>
                  <label className="vb-field">
                    <span>Branch (optional)</span>
                    <input placeholder="auto-named if blank" value={branch} onChange={(e) => setBranch(e.target.value)} />
                  </label>
                </>
              )}
            </>
          )}
          {err && <div className="vb-modal__err">{err}</div>}
        </div>
        <div className="vb-modal__foot">
          <button className="vb-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="vb-btn vb-btn--primary" onClick={submit} disabled={busy}>
            {busy ? "Spawning…" : <><Icon name="plus" size={12} /> <span>Spawn</span></>}
          </button>
        </div>
      </div>
    </dialog>
  );
});
