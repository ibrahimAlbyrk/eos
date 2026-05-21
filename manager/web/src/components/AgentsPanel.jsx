import { memo, useState, useEffect, useMemo, useRef } from "react";
import { CONFIG } from "../config.js";
import { ctxPct, modelShort, liveElapsed, fmtCost } from "../lib/format.js";
import { Icon, RingAvatar, StatusBadge, SpawnChip } from "./primitives.jsx";

const AgentRow = memo(function AgentRow({ agent, agents, selected, onSelect, onContextMenu }) {
  const pct = ctxPct(agent);
  const parent = agent.parent ? agents.find(a => a.id === agent.parent) : null;
  return (
    <div
      className={`vb-agentcard vb-agentcard--${agent.role} ${selected ? "is-selected" : ""}`}
      onClick={() => onSelect(agent.id)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu && onContextMenu(agent.id, e.clientX, e.clientY); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(agent.id); } }}
      role="option"
      aria-selected={selected}
      aria-current={selected ? "true" : undefined}
      aria-label={`${agent.name} — ${agent.status}, ${modelShort(agent.model)}`}
      tabIndex={0}
    >
      <RingAvatar agent={agent} ctxPct={pct} size={34} />
      <div className="vb-agentcard__main">
        <div className="vb-agentcard__name-row">
          <span className="vb-agentcard__name">{agent.name}</span>
          <StatusBadge status={agent.status} />
        </div>
        <div className="vb-agentcard__meta">
          <span>{modelShort(agent.model)}</span>
          <span className="vb-dot-sep">·</span>
          <span className="vb-mono">{liveElapsed(agent)}</span>
          <span className="vb-dot-sep">·</span>
          <span className="vb-mono vb-agentcard__ctx">{pct}% ctx</span>
        </div>
        {parent && <SpawnChip parent={parent} />}
      </div>
    </div>
  );
});

const RECENT_PATHS_KEY = "cm-recent-paths";
const RECENT_PATHS_CAP = 5;

function loadRecentPaths() {
  try { return JSON.parse(localStorage.getItem(RECENT_PATHS_KEY) || "[]"); }
  catch { return []; }
}
export function pushRecentPath(path) {
  if (!path) return;
  try {
    const cur = loadRecentPaths();
    const next = [path, ...cur.filter(p => p !== path)].slice(0, RECENT_PATHS_CAP);
    localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(next));
  } catch {}
}

// Path input + native picker button + last-N recents below. Browser can't show
// an absolute-path directory dialog (sandbox), so we ask the daemon to shell
// out to osascript.
function PathField({ value, onChange, placeholder }) {
  const [picking, setPicking] = useState(false);
  // Re-read recents whenever value changes (covers the post-spawn case where
  // the modal calls pushRecentPath and immediately resets state).
  const recents = useMemo(loadRecentPaths, [value]);
  const pick = async () => {
    setPicking(true);
    try {
      const r = await fetch(`${location.origin}/pick-directory`);
      const j = await r.json();
      if (j.path) onChange(j.path);
    } catch {} finally { setPicking(false); }
  };
  return (
    <>
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <input style={{ flex: 1, minWidth: 0 }} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} />
        <button type="button" className="vb-btn" onClick={pick} disabled={picking} title="Browse for a folder" style={{ flexShrink: 0 }}>
          Browse…
        </button>
      </div>
      {recents.length > 0 && (
        <div className="vb-recents">
          <div className="vb-recents__label">Recent</div>
          {recents.map(p => (
            <button
              key={p}
              type="button"
              className={`vb-recent ${p === value ? "is-active" : ""}`}
              onClick={() => onChange(p)}
              title={p}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// Unified spawn modal: pick agent type at the top, fields swap accordingly.
// Orchestrator → name + cwd (model always opus, locked).
// Worker → prompt + name + model + cwd/worktree mode.
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
      const r = await fetch(`${location.origin}/workers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.error || `daemon ${r.status}`); setBusy(false); return;
      }
      const res = await r.json();
      pushRecentPath(mode === "cwd" ? cwd.trim() : worktreeFrom.trim());
      window.live.refresh();
      onSpawned && onSpawned(res.id);
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
      <div className="vb-modal" onClick={e => e.stopPropagation()}>
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
                <input placeholder="auto-generated if blank (e.g. swift-742-orchestrator)" value={name} onChange={e => setName(e.target.value)} autoFocus />
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
                <textarea rows={4} placeholder="What should the worker do?" value={prompt} onChange={e => setPrompt(e.target.value)} autoFocus />
              </label>
              <div className="vb-field-row">
                <label className="vb-field">
                  <span>Name (optional)</span>
                  <input placeholder="e.g. refactor-auth" value={name} onChange={e => setName(e.target.value)} />
                </label>
                <label className="vb-field">
                  <span>Model</span>
                  <select value={model} onChange={e => setModel(e.target.value)}>
                    {CONFIG.spawnModels.map(m => <option key={m} value={m}>{m}</option>)}
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
                    <input placeholder="auto-named if blank" value={branch} onChange={e => setBranch(e.target.value)} />
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

// Right-click menu — positioned where the cursor was, closes on outside-click or Escape.
export const AgentContextMenu = memo(function AgentContextMenu({ menu, onClose, onQuickPrompt, onKill }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [menu, onClose]);
  if (!menu) return null;
  // Clamp position so the menu stays fully on-screen.
  const W = 200, H = 120;
  const x = Math.min(menu.x, window.innerWidth - W - 8);
  const y = Math.min(menu.y, window.innerHeight - H - 8);
  return (
    <div ref={ref} className="vb-ctxmenu" style={{ left: x, top: y }}>
      <button className="vb-ctxmenu__item" onClick={() => { onQuickPrompt(menu.agentId); onClose(); }}>
        <Icon name="send" size={12} /> <span>Send prompt</span>
      </button>
      <div className="vb-ctxmenu__sep" />
      <button className="vb-ctxmenu__item vb-ctxmenu__item--danger" onClick={() => { onKill(menu.agentId); onClose(); }}>
        <Icon name="kill" size={12} /> <span>Kill</span>
      </button>
    </div>
  );
});

// Blurred-backdrop modal: focused single-line input, Enter sends to the named
// agent without switching the main selection.
export const QuickPromptModal = memo(function QuickPromptModal({ open, agent, onClose, onSend }) {
  const ref = useRef(null);
  const dialogRef = useRef(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  // Native <dialog> handles Esc + focus trap + restore-on-close natively.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && agent && !d.open) d.showModal();
    if ((!open || !agent) && d.open) d.close();
  }, [open, agent]);

  useEffect(() => {
    if (open) {
      setText("");
      setSending(false);
      setTimeout(() => ref.current?.focus(), 30);
    }
  }, [open, agent?.id]);

  if (!open || !agent) return null;
  const submit = async () => {
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    try { await onSend(v, agent.id); } finally { setSending(false); onClose(); }
  };
  return (
    <dialog
      ref={dialogRef}
      className="vb-qp-overlay"
      aria-label={`Send prompt to ${agent.name}`}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => { if (e.target === dialogRef.current) onClose(); }}
    >
      <div className="vb-qp-shell" onClick={(e) => e.stopPropagation()}>
        <div className="vb-qp-target">
          <Icon name="arrowRight" size={12} />
          <span className={`vb-qp-target__name vb-turn__name--${agent.role}`}>{agent.name}</span>
          <span className="vb-qp-target__meta vb-mono">{modelShort(agent.model)}</span>
        </div>
        <textarea
          ref={ref}
          rows={3}
          placeholder={`Tell ${agent.name} what to do…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
        />
        <div className="vb-qp-foot">
          <div className="vb-qp-hints">
            <span><kbd>⏎</kbd> send</span>
            <span><kbd>⇧⏎</kbd> newline</span>
            <span><kbd>Esc</kbd> cancel</span>
          </div>
          <button className="vb-btn vb-btn--primary" onClick={submit} disabled={!text.trim() || sending}>
            <span>{sending ? "Sending…" : "Send"}</span>
            <Icon name="send" size={12} />
          </button>
        </div>
      </div>
    </dialog>
  );
});

export const AgentsPanel = memo(function AgentsPanel({ agents, selectedId, onSelect, onCollapse, online, onSpawnClick, session, onContextMenu }) {
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);
  // ⌘K focuses the filter input.
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(a =>
      (a.name || "").toLowerCase().includes(q) ||
      (a.model || "").toLowerCase().includes(q) ||
      (a.id || "").toLowerCase().includes(q)
    );
  }, [agents, query]);

  const flat = useMemo(() => {
    if (query.trim()) return filtered;
    const out = [];
    // Multi-root walk: orchestrators are the roots (no parent), each followed
    // by its worker subtree. Orphan parent_id chains (worker whose root isn't
    // in this list) fall through to the leftovers loop at the end.
    const walk = (parentId) => {
      const kids = agents
        .filter(a => (a.parent || null) === parentId)
        .sort((a, b) => (a.startedTs || 0) - (b.startedTs || 0));
      for (const k of kids) { out.push(k); walk(k.id); }
    };
    walk(null);
    for (const a of agents) if (!out.includes(a)) out.push(a);
    return out;
  }, [agents, filtered, query]);

  const hasOrch = agents.some(a => a.isOrchestrator);

  return (
    <aside className="vb-agents">
      <div className="vb-agents__head">
        <div className="vb-agents__title-col">
          <div className="vb-agents__title">Agents</div>
          <div className="vb-agents__sub">{agents.length} in this session</div>
        </div>
        <div className="vb-agents__head-actions">
          <button className="vb-pillbtn vb-pillbtn--primary" onClick={onSpawnClick} title="Spawn a new agent (orchestrator or worker)">
            <Icon name="plus" size={13} />
            <span>Agent</span>
          </button>
          <button className="vb-iconbtn vb-iconbtn--paneltoggle" onClick={onCollapse} title="Collapse panel" aria-label="Collapse agents panel">
            <Icon name="panelLeft" size={14} />
          </button>
        </div>
      </div>

      <div className="vb-agents__search">
        <Icon name="search" size={13} />
        <input
          ref={searchRef}
          placeholder="Filter by name or model…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="vb-agents__search-clear" onClick={() => setQuery("")} title="Clear" aria-label="Clear search">
            <Icon name="cross" size={11} />
          </button>
        )}
      </div>

      <div className="vb-agents__list" role="listbox" aria-label="Agents">

        {!hasOrch && agents.length === 0 && (
          <div className="vb-agents__empty" style={{ padding: "32px 16px", lineHeight: 1.7 }}>
            <Icon name="orchestrator" size={28} />
            <div style={{ marginTop: 10 }}>No orchestrator yet.</div>
            <div style={{ marginTop: 4, opacity: 0.7, fontSize: 12 }}>
              Create one to pick a project directory and start dispatching workers.
            </div>
            <button className="vb-pillbtn vb-pillbtn--primary" style={{ marginTop: 14 }} onClick={onSpawnClick}>
              <Icon name="play" size={12} /> <span>Spawn orchestrator</span>
            </button>
          </div>
        )}
        {flat.length === 0 && hasOrch && (
          <div className="vb-agents__empty">
            <span>No agents match “{query}”</span>
          </div>
        )}
        {flat.map(a => (
          <AgentRow key={a.id} agent={a} agents={agents} selected={selectedId === a.id} onSelect={onSelect} onContextMenu={onContextMenu} />
        ))}
      </div>

      <div className="vb-agents__foot">
        <div className="vb-footrow">
          <span className="vb-footrow__label">Session cost</span>
          <span className="vb-footrow__value">{fmtCost(session?.totalCost || 0)}</span>
        </div>
        <div className="vb-footrow">
          <span className="vb-footrow__label">Daemon</span>
          <span className={`vb-footrow__value ${online ? "vb-footrow__value--ok" : ""}`} style={online ? {} : { color: "var(--vb-err)" }}>
            <span className="vb-dot" style={online ? { background: "var(--vb-sage)", boxShadow: "0 0 6px var(--vb-sage)" } : { background: "var(--vb-err)", boxShadow: "0 0 6px var(--vb-err)" }} />
            {online ? "online" : "offline"}
          </span>
        </div>
      </div>
    </aside>
  );
});
