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

export const SpawnModal = memo(function SpawnModal({ open, onClose, onSpawned }) {
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState(CONFIG.spawnModels[0]);
  const [mode, setMode] = useState("cwd"); // "cwd" | "worktree"
  const [cwd, setCwd] = useState("");
  const [worktreeFrom, setWorktreeFrom] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!open) { setErr(null); setBusy(false); }
  }, [open]);
  if (!open) return null;

  const submit = async () => {
    setErr(null);
    if (!prompt.trim()) { setErr("prompt required"); return; }
    const loc = mode === "cwd" ? cwd.trim() : worktreeFrom.trim();
    if (!loc) { setErr(mode === "cwd" ? "cwd required" : "worktreeFrom required"); return; }
    setBusy(true);
    try {
      const body = {
        prompt: prompt.trim(),
        name: name.trim() || undefined,
        model,
      };
      if (mode === "cwd") body.cwd = cwd.trim();
      else { body.worktreeFrom = worktreeFrom.trim(); if (branch.trim()) body.branch = branch.trim(); }
      const r = await fetch(`${location.origin}/workers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.error || `daemon ${r.status}`);
        setBusy(false);
        return;
      }
      const res = await r.json();
      window.live.refresh();
      onSpawned && onSpawned(res.id);
      onClose();
    } catch (e) {
      setErr(String(e.message || e));
      setBusy(false);
    }
  };

  return (
    <div className="vb-modal-overlay" onClick={onClose}>
      <div className="vb-modal" onClick={e => e.stopPropagation()}>
        <div className="vb-modal__head">
          <div className="vb-modal__title">Spawn worker</div>
          <button className="vb-iconbtn" onClick={onClose} title="Close"><Icon name="cross" size={14} /></button>
        </div>
        <div className="vb-modal__body">
          <label className="vb-field">
            <span>Prompt</span>
            <textarea rows={4} placeholder="What should the worker do?" value={prompt} onChange={e => setPrompt(e.target.value)} />
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
              <button className={`vb-segpick__btn ${mode === "cwd" ? "is-active" : ""}`} onClick={() => setMode("cwd")}>cwd (plain dir)</button>
              <button className={`vb-segpick__btn ${mode === "worktree" ? "is-active" : ""}`} onClick={() => setMode("worktree")}>worktree (git)</button>
            </div>
          </div>
          {mode === "cwd" ? (
            <label className="vb-field">
              <span>Path</span>
              <input placeholder="/Users/me/Projects/foo or ~/Desktop" value={cwd} onChange={e => setCwd(e.target.value)} />
            </label>
          ) : (
            <div className="vb-field-row">
              <label className="vb-field">
                <span>Repo path</span>
                <input placeholder="/path/to/git/repo" value={worktreeFrom} onChange={e => setWorktreeFrom(e.target.value)} />
              </label>
              <label className="vb-field">
                <span>Branch (optional)</span>
                <input placeholder="auto-named if blank" value={branch} onChange={e => setBranch(e.target.value)} />
              </label>
            </div>
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
    </div>
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
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (open) {
      setText("");
      setSending(false);
      setTimeout(() => ref.current?.focus(), 30);
    }
  }, [open, agent?.id]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open || !agent) return null;
  const submit = async () => {
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    try { await onSend(v, agent.id); } finally { setSending(false); onClose(); }
  };
  return (
    <div className="vb-qp-overlay" onClick={onClose}>
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
    </div>
  );
});

export const AgentsPanel = memo(function AgentsPanel({ agents, selectedId, onSelect, onCollapse, online, onSpawnClick, onSpawnOrchestrator, session, onContextMenu }) {
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
    const walk = (parentId) => {
      const kids = agents
        .filter(a => (a.parent || null) === parentId)
        .sort((a, b) => {
          if (a.id === "orchestrator") return -1;
          if (b.id === "orchestrator") return 1;
          return (a.startedTs || 0) - (b.startedTs || 0);
        });
      for (const k of kids) { out.push(k); walk(k.id); }
    };
    walk(null);
    for (const a of agents) if (!out.includes(a)) out.push(a);
    return out;
  }, [agents, filtered, query]);

  const hasOrch = agents.some(a => a.id === "orchestrator");

  return (
    <aside className="vb-agents">
      <div className="vb-agents__head">
        <div className="vb-agents__title-col">
          <div className="vb-agents__title">Agents</div>
          <div className="vb-agents__sub">{agents.length} in this session</div>
        </div>
        <div className="vb-agents__head-actions">
          <button className="vb-pillbtn vb-pillbtn--primary" onClick={onSpawnClick} title="Spawn a new worker">
            <Icon name="plus" size={13} />
            <span>Spawn</span>
          </button>
          <button className="vb-iconbtn vb-iconbtn--paneltoggle" onClick={onCollapse} title="Collapse panel">
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
          <button className="vb-agents__search-clear" onClick={() => setQuery("")} title="Clear">
            <Icon name="cross" size={11} />
          </button>
        )}
      </div>

      <div className="vb-agents__list">
        {!hasOrch && agents.length === 0 && (
          <div className="vb-agents__empty" style={{ padding: "32px 16px", lineHeight: 1.7 }}>
            <Icon name="orchestrator" size={28} />
            <div style={{ marginTop: 10 }}>No orchestrator yet.</div>
            <button className="vb-pillbtn vb-pillbtn--primary" style={{ marginTop: 14 }} onClick={onSpawnOrchestrator}>
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
