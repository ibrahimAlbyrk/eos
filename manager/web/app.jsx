// claude-manager web UI — adapted from the "Atelier" redesign.
// Live data via window.live (data.jsx), all actions wired to the daemon HTTP API.

const { useState, useMemo, useRef, useEffect, useCallback } = React;
const Icon = window.Icon;

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────
function groupEvents(events) {
  const turns = [];
  let cur = null;
  for (const e of events) {
    if (e.type === "user") { turns.push({ kind: "user", agent: "user", events: [e] }); cur = null; continue; }
    if (e.type === "system" || e.type === "spawn" || e.type === "complete" || e.type === "msg") { turns.push({ kind: "system", agent: e.agent, events: [e] }); cur = null; continue; }
    if (e.type === "policy") continue;
    if (!cur || cur.agent !== e.agent || cur.kind !== "agent") {
      cur = { kind: "agent", agent: e.agent, events: [] };
      turns.push(cur);
    }
    cur.events.push(e);
  }
  return turns;
}
function turnBlocks(turn) {
  // First pass: build a map of toolUseId → result event so multiple tool_use
  // blocks emitted in the same assistant message pair with the right results
  // regardless of arrival order.
  const resultById = new Map();
  const consumed = new Set();
  for (let i = 0; i < turn.events.length; i++) {
    const e = turn.events[i];
    if ((e.type === "result" || e.type === "error") && e.toolUseId) {
      resultById.set(e.toolUseId, { e, idx: i });
    }
  }
  const out = [];
  for (let i = 0; i < turn.events.length; i++) {
    const e = turn.events[i];
    if (consumed.has(i)) continue;
    if (e.type === "tool") {
      let pair = e.toolUseId ? resultById.get(e.toolUseId) : null;
      // Fallback for legacy events without an id: nearest unconsumed result
      // after this tool in the same turn.
      if (!pair) {
        for (let j = i + 1; j < turn.events.length; j++) {
          if (consumed.has(j)) continue;
          const n = turn.events[j];
          if ((n.type === "result" || n.type === "error") && !n.toolUseId) { pair = { e: n, idx: j }; break; }
        }
      }
      if (pair) { out.push({ kind: "toolpair", tool: e, result: pair.e }); consumed.add(pair.idx); continue; }
      out.push({ kind: "tool", tool: e }); continue;
    }
    if (e.type === "result" || e.type === "error") { out.push({ kind: "result", result: e }); continue; }
    if (e.type === "thought") { out.push({ kind: "thought", e }); continue; }
  }
  return out;
}
function toolIcon(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("read")) return "read";
  if (n.includes("edit") || n.includes("write")) return "edit";
  if (n.includes("bash")) return "terminal";
  if (n.includes("grep")) return "grep";
  if (n.includes("fetch") || n.includes("web")) return "globe";
  if (n.includes("spawn")) return "spawn";
  return "tool";
}
function ctxPct(agent) {
  const used = (agent.tokens?.in || 0) + (agent.tokens?.out || 0);
  const budget = agent.tokens?.budget || 200000;
  return Math.min(100, Math.round((used / budget) * 100));
}
function modelShort(model) {
  if (!model) return "—";
  return String(model).replace(/^claude-/, "");
}

// Live elapsed — uses Date.now() at render time so the App's 500ms tick keeps
// agent counters smooth instead of waiting on the next poll.
function liveElapsed(agent) {
  if (!agent || !agent.startedTs) return "—";
  const end = agent.endedTs || Date.now();
  return window.fmtDur(end - agent.startedTs);
}

// ────────────────────────────────────────────────────────────────────
// Tiny primitives
// ────────────────────────────────────────────────────────────────────
function Avatar({ agent, size = 28 }) {
  const initial = agent.role === "main" ? "C" : (agent.name?.[0] || "?").toUpperCase();
  return (
    <div className={`vb-avatar vb-avatar--${agent.role}`} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {agent.role === "main" ? (
        <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="currentColor"><path d="M5 12c0-3.9 3.1-7 7-7s7 3.1 7 7-3.1 7-7 7-7-3.1-7-7zm7-4.5L9 12l3 4.5L15 12z"/></svg>
      ) : initial}
    </div>
  );
}
function StatusBadge({ status }) {
  const labels = { running: "running", thinking: "thinking", waiting: "idle", queued: "queued", done: "done", error: "error", killed: "killed" };
  return (
    <span className={`vb-statbadge vb-statbadge--${status}`}>
      <span className="vb-statbadge__dot" />
      <span>{labels[status] || status}</span>
    </span>
  );
}
function RingAvatar({ agent, ctxPct: pct, size = 34 }) {
  const initial = agent.role === "main" ? "C" : (agent.name?.[0] || "?").toUpperCase();
  const cx = size / 2;
  const cy = size / 2;
  return (
    <div className="vb-ring-av" style={{ width: size, height: size }}>
      <svg className="vb-ring-av__svg" viewBox={`0 0 ${size} ${size}`}>
        <rect className="vb-ring-av__track" x="1.5" y="1.5" width={size - 3} height={size - 3} rx="7.5" fill="none" />
        <rect className={`vb-ring-av__fill vb-ring-av__fill--${agent.role}`}
              x="1.5" y="1.5" width={size - 3} height={size - 3} rx="7.5"
              fill="none" pathLength="100"
              strokeDasharray={`${pct} 100`}
              transform={`rotate(-90 ${cx} ${cy})`} />
      </svg>
      <div className={`vb-ring-av__face vb-ring-av__face--${agent.role}`}>
        {agent.role === "main" ? (
          <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="currentColor">
            <path d="M5 12c0-3.9 3.1-7 7-7s7 3.1 7 7-3.1 7-7 7-7-3.1-7-7zm7-4.5L9 12l3 4.5L15 12z"/>
          </svg>
        ) : initial}
      </div>
    </div>
  );
}
function SpawnChip({ parent }) {
  if (!parent) return null;
  const initial = parent.role === "main" ? "★" : (parent.name?.[0] || "?").toUpperCase();
  return (
    <span className="vb-spawnchip" title={`Spawned by ${parent.name}`}>
      <span className="vb-spawnchip__arrow">↳</span>
      <span className={`vb-spawnchip__av vb-spawnchip__av--${parent.role}`}>{initial}</span>
      <span className="vb-spawnchip__name">{parent.name}</span>
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────
// Topbar
// ────────────────────────────────────────────────────────────────────
function fmtCost(n) { return "$" + (n || 0).toFixed(n >= 1 ? 2 : 3); }
function fmtElapsed(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function Topbar({ agents, session, online, sessionName }) {
  const running = agents.filter(a => a.status === "running" || a.status === "thinking").length;
  const elapsedMs = session?.sessionStartTs ? Date.now() - session.sessionStartTs : 0;
  return (
    <header className="vb-topbar">
      <div className="vb-topbar__brand">
        <div className="vb-logomark">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M5 12c0-3.9 3.1-7 7-7s7 3.1 7 7-3.1 7-7 7-7-3.1-7-7zm7-4.5L9 12l3 4.5L15 12z"/></svg>
        </div>
        <div className="vb-topbar__brand-text">
          <div className="vb-topbar__brand-name">Claude Manager</div>
          <div className="vb-topbar__brand-sub">
            <span>{sessionName}</span>
            <span className="vb-topbar__brand-sep">·</span>
            <span className="vb-mono">v0.5</span>
          </div>
        </div>
      </div>

      <div className="vb-topbar__right">
        <div className="vb-headerstats">
          <div className="vb-headerstat">
            <div className="vb-headerstat__label">running</div>
            <div className="vb-headerstat__value">
              <span className="vb-live-dot" />
              {running}
            </div>
          </div>
          <div className="vb-headerstat">
            <div className="vb-headerstat__label">cost/h</div>
            <div className="vb-headerstat__value">{fmtCost(session?.costPerHour || 0)}</div>
          </div>
          <div className="vb-headerstat">
            <div className="vb-headerstat__label">elapsed</div>
            <div className="vb-headerstat__value vb-mono">{fmtElapsed(elapsedMs)}</div>
          </div>
        </div>
        {!online && (
          <div className="vb-headerstat" style={{ color: "var(--vb-err)", padding: "4px 10px", border: "1px solid rgba(217,126,126,0.4)", borderRadius: 8, background: "rgba(217,126,126,0.08)" }}>
            <div className="vb-headerstat__label" style={{ color: "var(--vb-err)" }}>daemon</div>
            <div className="vb-headerstat__value" style={{ color: "var(--vb-err)" }}>offline</div>
          </div>
        )}
      </div>
    </header>
  );
}

// ────────────────────────────────────────────────────────────────────
// Agents panel + Spawn modal
// ────────────────────────────────────────────────────────────────────
function AgentRow({ agent, agents, selected, onSelect, onContextMenu }) {
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
}

function SpawnModal({ open, onClose, onSpawned }) {
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("opus");
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
                <option value="opus">opus</option>
                <option value="sonnet">sonnet</option>
                <option value="haiku">haiku</option>
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
}

// Custom right-click menu — positioned where the cursor was, closes on
// outside-click or Escape.
function AgentContextMenu({ menu, onClose, onQuickPrompt, onKill }) {
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
  // Keep the menu fully on-screen — clamp x/y near edges.
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
}

// Blurred-backdrop modal: focused single-line input, Enter sends to the named
// agent without switching the main selection.
function QuickPromptModal({ open, agent, onClose, onSend }) {
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
}

function AgentsPanel({ agents, selectedId, onSelect, onCollapse, online, onSpawnClick, onSpawnOrchestrator, session, onContextMenu }) {
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
}

function LeftPanelHandle({ onExpand }) {
  return (
    <button className="vb-panelhandle vb-panelhandle--left" onClick={onExpand} title="Show agents panel">
      <Icon name="panelLeft" size={14} />
    </button>
  );
}
function RightPanelHandle({ onExpand }) {
  return (
    <button className="vb-panelhandle vb-panelhandle--right" onClick={onExpand} title="Show details panel">
      <Icon name="panelRight" size={14} />
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────
// Pending banner + pane
// ────────────────────────────────────────────────────────────────────
function PendingBanner({ pending, agents, onApprove, onDeny }) {
  if (!pending || pending.length === 0) return null;
  const p = pending[0];
  const agent = agents.find(a => a.id === p.worker_id);
  const expiresSec = Math.max(0, Math.round((p.expires_at - Date.now()) / 1000));
  let brief = p.input;
  try { const j = JSON.parse(p.input); brief = j.file_path || j.command || j.url || JSON.stringify(j).slice(0, 80); } catch {}
  return (
    <div className="vb-pendbar">
      <div className="vb-pendbar__icon">
        <Icon name="shield" size={14} />
      </div>
      <div className="vb-pendbar__main">
        <div className="vb-pendbar__title">
          <b>{agent?.name || p.worker_id}</b> wants to use <code className="vb-inlinecode">{p.tool_name}</code> on <code className="vb-inlinecode">{String(brief).slice(0, 60)}</code>
        </div>
        <div className="vb-pendbar__sub">
          {pending.length > 1
            ? <span>+{pending.length - 1} more queued · approve to apply this change</span>
            : <span>approve to apply this change, deny to block it</span>}
        </div>
      </div>
      <div className="vb-pendbar__timer">
        <Icon name="clock" size={12} />
        <span>auto-deny in <b>{expiresSec}s</b></span>
      </div>
      <div className="vb-pendbar__actions">
        <button className="vb-btn vb-btn--pendbar-ghost" onClick={() => onDeny(p.id)}>Deny</button>
        <button className="vb-btn vb-btn--pendbar-primary" onClick={() => onApprove(p.id)}>
          <Icon name="check" size={12} /> Approve
        </button>
      </div>
    </div>
  );
}

function PendingCard({ p, agents, onApprove, onDeny }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => {
    try { return JSON.stringify(JSON.parse(p.input), null, 2); } catch { return p.input; }
  });
  const [err, setErr] = useState(null);
  const agent = agents.find(a => a.id === p.worker_id);
  const expiresSec = Math.max(0, Math.round((p.expires_at - Date.now()) / 1000));
  let brief = p.input;
  try { const j = JSON.parse(p.input); brief = j.file_path || j.command || j.url || JSON.stringify(j).slice(0, 80); } catch {}

  const approveWithEdit = async () => {
    setErr(null);
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { setErr("invalid JSON: " + e.message); return; }
    await onApprove(p.id, parsed);
  };

  return (
    <div className="vb-pending-card">
      <div className="vb-pending-card__head">
        <div className="vb-pending-card__left">
          {agent && <Avatar agent={agent} size={32} />}
          <div>
            <div className="vb-pending-card__title">{agent?.name || p.worker_id} wants to use <code className="vb-inlinecode">{p.tool_name}</code></div>
            <div className="vb-pending-card__sub">{String(brief).slice(0, 200)}</div>
          </div>
        </div>
        <div className="vb-pending-card__timer">
          <Icon name="clock" size={12} />
          <span>{expiresSec}s</span>
        </div>
      </div>
      {editing ? (
        <textarea className="vb-pending-card__editor" value={text} onChange={e => setText(e.target.value)} rows={Math.min(20, text.split("\n").length + 1)} />
      ) : (
        <pre className="vb-code vb-pending-card__code">{text}</pre>
      )}
      {err && <div className="vb-modal__err" style={{ margin: "0 0 8px" }}>{err}</div>}
      <div className="vb-pending-card__actions">
        <button className="vb-btn vb-btn--ghost" onClick={() => setEditing(v => !v)}>
          {editing ? "Cancel edit" : "Edit input"}
        </button>
        <div className="vb-pending-card__actions-right">
          <button className="vb-btn" onClick={() => onDeny(p.id)}>Deny</button>
          {editing
            ? <button className="vb-btn vb-btn--primary" onClick={approveWithEdit}><Icon name="check" size={12} /> Approve with edits</button>
            : <button className="vb-btn vb-btn--primary" onClick={() => onApprove(p.id)}><Icon name="check" size={12} /> Approve</button>
          }
        </div>
      </div>
    </div>
  );
}

function PendingPane({ pending, agents, onApprove, onDeny }) {
  if (pending.length === 0) {
    return <div className="vb-empty"><Icon name="check" size={32} /><div>Nothing pending</div></div>;
  }
  return (
    <div className="vb-feed">
      <div className="vb-feed__inner">
        {pending.map(p => (
          <PendingCard key={p.id} p={p} agents={agents} onApprove={onApprove} onDeny={onDeny} />
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Activity feed
// ────────────────────────────────────────────────────────────────────
function ToolCard({ tool, result }) {
  const [open, setOpen] = useState(false);
  const hasResult = !!result;
  const isError = result?.type === "error";
  const argsPreview = (tool.args || "").replace(/\s+/g, " ").slice(0, 80);
  return (
    <div className={`vb-tool ${open ? "is-open" : ""}`}>
      <button className="vb-tool__head" onClick={() => setOpen(o => !o)}>
        <span className="vb-tool__icon"><Icon name={toolIcon(tool.tool)} size={13} /></span>
        <div className="vb-tool__head-text">
          <div className="vb-tool__head-name"><span>{(tool.tool || "tool").replace(/^mcp__[^_]+__/, "")}</span><Icon name={open ? "chevronDown" : "chevronRight"} size={11} /></div>
          <div className="vb-tool__head-args">{argsPreview}</div>
        </div>
        <span className="vb-tool__status">
          {hasResult
            ? (isError
                ? <span className="vb-pill" style={{ color: "var(--vb-err)", background: "var(--vb-ember-soft)", borderColor: "rgba(217,126,126,0.32)" }}><Icon name="cross" size={10} /> err</span>
                : <span className="vb-pill vb-pill--ok"><Icon name="check" size={10} /> ok</span>)
            : <span className="vb-pill vb-pill--warn"><span className="vb-spinner" /> running</span>}
        </span>
      </button>
      {open && (
        <div className="vb-tool__body" style={hasResult ? undefined : { gridTemplateColumns: "1fr" }}>
          <div className="vb-tool__pane">
            <div className="vb-tool__pane-head">input</div>
            <pre className="vb-code">{tool.args || "(no args)"}</pre>
          </div>
          {hasResult && (
            <div className="vb-tool__pane">
              <div className="vb-tool__pane-head">{isError ? "error" : "output"}</div>
              <pre className="vb-code">{result.body || ""}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UserTurn({ turn }) {
  const e = turn.events[0];
  return (
    <div className="vb-turn vb-turn--user">
      <div className="vb-userbubble">
        <div className="vb-userbubble__head">
          <span className="vb-userbubble__name">You</span>
          <span className="vb-userbubble__ts">{e.ts}</span>
        </div>
        <div className="vb-userbubble__body">{e.body}</div>
      </div>
    </div>
  );
}

function SystemTurn({ turn, agents }) {
  const e = turn.events[0];
  const agent = agents.find(a => a.id === e.agent);
  return (
    <div className="vb-systemrow">
      <div className="vb-systemrow__dot" />
      <div className="vb-systemrow__body">
        <span className="vb-systemrow__agent">{agent?.name || e.agent}</span>
        <span> · </span>
        <span>{e.body}</span>
      </div>
      <div className="vb-systemrow__ts">{e.ts}</div>
    </div>
  );
}

function AgentTurn({ turn, agents }) {
  const agent = agents.find(a => a.id === turn.agent);
  if (!agent) return null;
  const blocks = turnBlocks(turn);
  const last = turn.events[turn.events.length - 1];
  return (
    <div className={`vb-turn vb-turn--agent vb-turn--${agent.role}`}>
      <div className="vb-turn__rail">
        <Avatar agent={agent} size={32} />
        <div className="vb-turn__line" />
      </div>
      <div className="vb-turn__body">
        <div className="vb-turn__head">
          <span className={`vb-turn__name vb-turn__name--${agent.role}`}>{agent.name}</span>
          <span className="vb-turn__model vb-mono">{modelShort(agent.model)}</span>
          <span className="vb-turn__ts vb-mono">{last.ts}</span>
        </div>
        <div className="vb-turn__content">
          {blocks.map((b, i) => {
            if (b.kind === "thought") {
              return (
                <div key={i} className="vb-textblock is-thought">
                  <div className="vb-textblock__label">
                    <Icon name="thinking" size={11} />
                    <span>thinking</span>
                  </div>
                  <div className="vb-textblock__body">{b.e.body}</div>
                </div>
              );
            }
            if (b.kind === "toolpair") return <ToolCard key={i} tool={b.tool} result={b.result} />;
            if (b.kind === "tool") return <ToolCard key={i} tool={b.tool} />;
            if (b.kind === "result") {
              const isError = b.result.type === "error";
              return (
                <div key={i} className="vb-tool">
                  <div className="vb-tool__body" style={{ gridTemplateColumns: "1fr", borderTop: "none" }}>
                    <div className="vb-tool__pane">
                      <div className="vb-tool__pane-head">{isError ? "error" : "result"}</div>
                      <pre className="vb-code">{b.result.body || ""}</pre>
                    </div>
                  </div>
                </div>
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}

function ActivityFeed({ events, agents, scope, busy }) {
  const turns = useMemo(() => groupEvents(events), [events]);
  const ref = useRef(null);
  // Auto-scroll only when already pinned to bottom — preserves manual scrollback
  // when the user is reading older events.
  const stickRef = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [turns.length]);
  const onScroll = () => {
    const el = ref.current; if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };
  return (
    <div className="vb-feed" ref={ref} onScroll={onScroll}>
      <div className="vb-feed__inner">
        <div className="vb-feed__intro">
          <div className="vb-feed__intro-eyebrow">Session activity</div>
          <div className="vb-feed__intro-title">{scope}</div>
        </div>
        {turns.length === 0 && (
          <div className="vb-empty" style={{ padding: "40px 0" }}>
            <Icon name="sparkle" size={28} />
            <div>No activity yet — send a message to begin.</div>
          </div>
        )}
        {turns.map((t, i) => {
          if (t.kind === "user") return <UserTurn key={i} turn={t} />;
          if (t.kind === "system") return <SystemTurn key={i} turn={t} agents={agents} />;
          return <AgentTurn key={i} turn={t} agents={agents} />;
        })}
        {busy && (
          <div className="vb-feed__thinking">
            <div className="vb-thinking-bar">
              <div className="vb-thinking-bar__fill" />
            </div>
            <span>{scope} is thinking…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ConsolePane({ events, agents }) {
  return (
    <div className="vb-feed vb-feed--console">
      <div className="vb-feed__inner">
        {events.length === 0 && <div className="vb-empty" style={{ padding: "40px 0" }}><div>No console output yet.</div></div>}
        {events.map(e => {
          const agent = agents.find(a => a.id === e.agent);
          return (
            <div key={e.id} className="vb-console-line">
              <span className="vb-mono vb-console-line__ts">{e.ts}</span>
              <span className="vb-console-line__agent">{agent?.name || e.agent}</span>
              <span className={`vb-console-line__type vb-console-line__type--${e.type}`}>{e.type}</span>
              <span className="vb-mono vb-console-line__body">{(e.body || e.args || "").slice(0, 200)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Composer
// ────────────────────────────────────────────────────────────────────
function Composer({ target, busy, onSend, model }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [busySince, setBusySince] = useState(null);
  const [, tick] = useState(0);
  const ref = useRef(null);

  useEffect(() => { setBusySince(null); }, [target]);
  useEffect(() => {
    if (busy) setBusySince(cur => cur || Date.now());
    else setBusySince(null);
  }, [busy]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const elapsedSec = busy && busySince ? Math.max(0, Math.floor((Date.now() - busySince) / 1000)) : 0;
  const elapsedLabel = elapsedSec < 60
    ? `${elapsedSec}s`
    : `${Math.floor(elapsedSec / 60)}m${String(elapsedSec % 60).padStart(2, "0")}s`;

  const submit = async () => {
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    setText("");
    if (ref.current) ref.current.style.height = "auto";
    try { await onSend(v); } finally { setSending(false); }
  };

  const autoResize = (el) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  return (
    <div className={`vb-composer ${busy ? "is-busy" : ""}`}>
      <div className="vb-composer__shell">
        <div className="vb-composer__header">
          <div className="vb-composer__target">
            <Icon name="arrowRight" size={12} />
            <span className="vb-composer__target-name">{target}</span>
          </div>
          <div className="vb-composer__chips">
            <span className="vb-chip">scope <b>full</b></span>
            <span className="vb-chip">policy <b>auto-spawn</b></span>
            <span className="vb-chip">model <b>{modelShort(model || "opus")}</b></span>
          </div>
          {busy && (
            <div className="vb-composer__thinking">
              <span className="vb-pulse-dot" />
              <span className="vb-mono">thinking {elapsedLabel}</span>
            </div>
          )}
        </div>
        <textarea
          ref={ref}
          placeholder={sending ? "sending…" : `Tell ${target} what to do…`}
          value={text}
          onChange={e => { setText(e.target.value); autoResize(e.target); }}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          rows={2}
          disabled={sending}
        />
        <div className="vb-composer__foot">
          <div className="vb-composer__hints">
            <span><kbd>⏎</kbd> send</span>
            <span><kbd>⇧⏎</kbd> newline</span>
          </div>
          <div className="vb-composer__foot-actions">
            <button className="vb-iconbtn" title="Attach (not implemented)" disabled><Icon name="folder" size={14} /></button>
            <button className="vb-iconbtn" title="History (not implemented)" disabled><Icon name="history" size={14} /></button>
            <button className="vb-btn vb-btn--primary vb-btn--send" onClick={submit} disabled={!text.trim() || sending}>
              <span>{sending ? "Sending…" : "Send"}</span>
              <Icon name="send" size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Center
// ────────────────────────────────────────────────────────────────────
function Center({ events, agents, selected, pending, onApprove, onDeny, onSend }) {
  const [tab, setTab] = useState("activity");
  const scope = selected ? selected.name : "all agents";
  const busy = !!(selected && (selected.status === "thinking" || selected.status === "running"));
  return (
    <main className="vb-main">
      <div className="vb-main__head">
        <div className="vb-segctrl">
          <button className={`vb-seg ${tab === "activity" ? "is-active" : ""}`} onClick={() => setTab("activity")}>
            <Icon name="list" size={12} /> Activity
            <span className="vb-seg__badge">{events.length}</span>
          </button>
          <button className={`vb-seg ${tab === "pending" ? "is-active" : ""}`} onClick={() => setTab("pending")}>
            <Icon name="shield" size={12} /> Pending
            {pending.length > 0 && <span className="vb-seg__badge vb-seg__badge--alert">{pending.length}</span>}
          </button>
          <button className={`vb-seg ${tab === "console" ? "is-active" : ""}`} onClick={() => setTab("console")}>
            <Icon name="terminal" size={12} /> Console
          </button>
        </div>

      </div>

      <PendingBanner pending={pending} agents={agents} onApprove={onApprove} onDeny={onDeny} />

      {tab === "activity" && <ActivityFeed events={events} agents={agents} scope={scope} busy={busy} />}
      {tab === "pending" && <PendingPane pending={pending} agents={agents} onApprove={onApprove} onDeny={onDeny} />}
      {tab === "console" && <ConsolePane events={events} agents={agents} />}

      <Composer target={selected?.name || "Orchestrator"} busy={busy} onSend={onSend} model={selected?.model} />
    </main>
  );
}

// ────────────────────────────────────────────────────────────────────
// Details panel
// ────────────────────────────────────────────────────────────────────
function KillButton({ agent }) {
  const [pending, setPending] = useState(false);
  const terminal = agent.status === "done" || agent.status === "killed" || agent.status === "error";
  const click = async () => {
    if (pending) return;
    setPending(true);
    try {
      await fetch(`${location.origin}/workers/${agent.id}`, { method: "DELETE" }).catch(() => {});
      window.live.refresh();
    } finally {
      setTimeout(() => setPending(false), 800);
    }
  };
  return (
    <button className="vb-btn vb-btn--ghost vb-btn--danger" onClick={click} disabled={pending}
            style={pending ? { opacity: 0.6, cursor: "wait" } : terminal ? { opacity: 0.85 } : {}}
            title="SIGTERM the worker, sweep orphans, drop the entry">
      <Icon name="kill" size={12} /> <span>{pending ? "Killing…" : "Kill"}</span>
    </button>
  );
}

function ActivitySection({ activity, max }) {
  const [hover, setHover] = useState(null); // bar index or null
  const total = activity.reduce((s, n) => s + n, 0);
  const label = hover != null
    ? `${activity[hover]} call${activity[hover] === 1 ? "" : "s"} · ${24 - hover}m ago`
    : `${total} total · last 24m`;
  return (
    <div className="vb-detsection">
      <div className="vb-detsection__head">
        <span>Activity · last 24 minutes</span>
        <span className="vb-muted vb-mono">{label}</span>
      </div>
      <div className="vb-bars" onMouseLeave={() => setHover(null)}>
        {activity.map((v, i) => (
          <div key={i}
               className="vb-bar-slot"
               onMouseEnter={() => setHover(v > 0 ? i : null)}>
            <i className={`vb-bar ${v / max > 0.7 ? "vb-bar--hot" : ""} ${hover === i ? "vb-bar--hover" : ""}`}
               style={{ height: `${Math.max(6, (v / max) * 100)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Details({ agent, agents, onSelect, onCollapse }) {
  if (!agent) {
    return (
      <aside className="vb-details">
        <div className="vb-details__head-bar">
          <span>Details</span>
          <button className="vb-iconbtn vb-iconbtn--paneltoggle" onClick={onCollapse} title="Collapse panel">
            <Icon name="panelRight" size={14} />
          </button>
        </div>
        <div className="vb-empty">
          <Icon name="agent" size={36} />
          <div>Select an agent to inspect</div>
        </div>
      </aside>
    );
  }

  const children = agents.filter(a => a.parent === agent.id);
  const parent = agents.find(a => a.id === agent.parent);
  const pct = ctxPct(agent);
  const max = Math.max(1, ...(agent.activity || [0]));

  return (
    <aside className="vb-details">
      <div className="vb-details__head-bar">
        <span>Agent details</span>
        <button className="vb-iconbtn vb-iconbtn--paneltoggle" onClick={onCollapse} title="Collapse panel">
          <Icon name="panelRight" size={14} />
        </button>
      </div>
      <div className="vb-details__hero">
        <Avatar agent={agent} size={44} />
        <div className="vb-details__hero-text">
          <div className="vb-details__hero-name">{agent.name}</div>
          <div className="vb-details__hero-id">
            <code className="vb-inlinecode">{agent.id}</code>
            <button className="vb-iconbtn vb-iconbtn--xs" onClick={() => navigator.clipboard?.writeText(agent.id)} title="Copy id"><Icon name="copy" size={10} /></button>
          </div>
        </div>
        <StatusBadge status={agent.status} />
      </div>

      {agent.description && <div className="vb-details__desc">{agent.description}</div>}

      <div className="vb-details__scroll">
        <div className="vb-detsection">
          <div className="vb-detsection__head">Vitals</div>
          <div className="vb-vitals">
            <div className="vb-vital"><div className="vb-vital__label">Model</div><div className="vb-vital__value">{modelShort(agent.model)}</div></div>
            <div className="vb-vital"><div className="vb-vital__label">Elapsed</div><div className="vb-vital__value vb-mono">{liveElapsed(agent)}</div></div>
            <div className="vb-vital"><div className="vb-vital__label">Cost</div><div className="vb-vital__value">{fmtCost(agent.cost || 0)}</div></div>
            <div className="vb-vital"><div className="vb-vital__label">Parent</div><div className="vb-vital__value">{parent ? <a className="vb-link" onClick={() => onSelect(parent.id)}>{parent.name}</a> : <span className="vb-muted">root</span>}</div></div>
          </div>
        </div>

        <div className="vb-detsection">
          <div className="vb-detsection__head">
            <span>Context</span>
            <span className="vb-muted vb-mono">{pct}%</span>
          </div>
          <div className="vb-segbar">
            <div className="vb-segbar__fill" style={{ width: `${pct}%` }} />
            <div className="vb-segbar__ticks">{[25, 50, 75].map(t => <div key={t} style={{ left: `${t}%` }} />)}</div>
          </div>
          <div className="vb-tokrow">
            <div><span className="vb-muted">in</span> <b>{(agent.tokens?.in || 0).toLocaleString()}</b></div>
            <div><span className="vb-muted">out</span> <b>{(agent.tokens?.out || 0).toLocaleString()}</b></div>
            <div><span className="vb-muted">budget</span> <b>{(() => {
              const b = agent.tokens?.budget || 200000;
              return b >= 1_000_000 ? `${(b/1_000_000).toFixed(0)}M` : `${(b/1000)|0}k`;
            })()}</b></div>
          </div>
        </div>

        <ActivitySection activity={agent.activity || new Array(24).fill(0)} max={max} />

        <div className="vb-detsection">
          <div className="vb-detsection__head">
            <span>Tools used</span>
            <span className="vb-muted vb-mono">{(agent.tools || []).reduce((s, t) => s + t.count, 0)} calls</span>
          </div>
          {(!agent.tools || agent.tools.length === 0) ? (
            <div className="vb-empty-row">— none yet —</div>
          ) : (() => {
            const max = Math.max(...agent.tools.map(x => x.count));
            return agent.tools.map(t => (
              <div key={t.name} className="vb-toolrow">
                <span className="vb-toolrow__icon"><Icon name={toolIcon(t.name)} size={12} /></span>
                <span className="vb-toolrow__name">{t.name.replace(/^mcp__[^_]+__/, "")}</span>
                <span className="vb-toolrow__bar"><span style={{ width: `${(t.count / max) * 100}%` }} /></span>
                <span className="vb-toolrow__count vb-mono">{t.count}</span>
              </div>
            ));
          })()}
        </div>

        {children.length > 0 && (
          <div className="vb-detsection">
            <div className="vb-detsection__head">
              <span>Children</span>
              <span className="vb-muted vb-mono">{children.length}</span>
            </div>
            {children.map(c => (
              <div key={c.id} className="vb-childrow" onClick={() => onSelect(c.id)}>
                <Avatar agent={c} size={26} />
                <div className="vb-childrow__col">
                  <div className="vb-childrow__name">{c.name}</div>
                  <div className="vb-childrow__meta">{modelShort(c.model)} · <span className="vb-mono">{liveElapsed(c)}</span></div>
                </div>
                <StatusBadge status={c.status} />
              </div>
            ))}
          </div>
        )}

        {(agent.branch || agent.cwd) && (
          <div className="vb-detsection">
            <div className="vb-detsection__head">Worktree</div>
            <div className="vb-kvb">
              {agent.branch && <div className="vb-kvb__row"><span className="vb-kvb__k">branch</span><span className="vb-kvb__v vb-mono">{agent.branch}</span></div>}
              {agent.cwd && (
                <div className="vb-kvb__row">
                  <span className="vb-kvb__k">cwd</span>
                  <span className="vb-kvb__v vb-mono">
                    {agent.cwd.split("/").flatMap((seg, i, arr) =>
                      i < arr.length - 1
                        ? [seg, <React.Fragment key={i}>/<wbr/></React.Fragment>]
                        : [seg]
                    )}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="vb-details__actions">
        <KillButton agent={agent} />
      </div>
    </aside>
  );
}

// ────────────────────────────────────────────────────────────────────
// Root
// ────────────────────────────────────────────────────────────────────
function App() {
  const [, force] = useState(0);
  const [selectedId, setSelectedId] = useState("orchestrator");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState(null); // { agentId, x, y }
  const [quickPrompt, setQuickPrompt] = useState(null); // agentId

  useEffect(() => window.live.subscribe(() => force(n => n + 1)), []);
  // Drive all elapsed/cost counters at a steady cadence regardless of poll/SSE.
  useEffect(() => { const t = setInterval(() => force(n => n + 1), 500); return () => clearInterval(t); }, []);

  const { agents, events, pending, online, session } = window.live.state;
  const selected = agents.find(a => a.id === selectedId) || null;

  const visibleEvents = useMemo(() => {
    if (!selectedId) return events;
    return events.filter(e => e.agent === selectedId || e.agent === "user");
  }, [events, selectedId]);

  const onSend = useCallback(async (text) => {
    await window.live.sendMessage(text, selectedId);
  }, [selectedId]);

  const onApprove = useCallback(async (pid, updatedInput) => {
    await window.live.approvePending(pid, updatedInput);
  }, []);
  const onDeny = useCallback(async (pid) => {
    await window.live.denyPending(pid);
  }, []);
  const onSpawnOrchestrator = useCallback(async () => {
    await window.live.spawnOrchestrator();
    setSelectedId("orchestrator");
  }, []);

  const onAgentContextMenu = useCallback((agentId, x, y) => {
    setCtxMenu({ agentId, x, y });
  }, []);
  const onKillAgent = useCallback(async (agentId) => {
    await window.live.killAgent(agentId);
  }, []);
  const onQuickPromptSend = useCallback(async (text, agentId) => {
    await window.live.sendMessage(text, agentId);
  }, []);

  const bodyCls = useMemo(() => {
    if (leftCollapsed && rightCollapsed) return "vb-body vb-body--both-collapsed";
    if (leftCollapsed) return "vb-body vb-body--left-collapsed";
    if (rightCollapsed) return "vb-body vb-body--right-collapsed";
    return "vb-body";
  }, [leftCollapsed, rightCollapsed]);

  return (
    <div className="vb-app">
      <Topbar agents={agents} session={session} online={online} sessionName="claude-manager session" />
      <div className={bodyCls}>
        {leftCollapsed
          ? <LeftPanelHandle onExpand={() => setLeftCollapsed(false)} />
          : <AgentsPanel
              agents={agents}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onCollapse={() => setLeftCollapsed(true)}
              online={online}
              onSpawnClick={() => setSpawnOpen(true)}
              onSpawnOrchestrator={onSpawnOrchestrator}
              session={session}
              onContextMenu={onAgentContextMenu}
            />
        }
        <Center
          events={visibleEvents}
          agents={agents}
          selected={selected}
          pending={pending}
          onApprove={onApprove}
          onDeny={onDeny}
          onSend={onSend}
        />
        {rightCollapsed
          ? <RightPanelHandle onExpand={() => setRightCollapsed(false)} />
          : <Details agent={selected} agents={agents} onSelect={setSelectedId} onCollapse={() => setRightCollapsed(true)} />
        }
      </div>
      <SpawnModal open={spawnOpen} onClose={() => setSpawnOpen(false)} onSpawned={(id) => setSelectedId(id)} />
      <AgentContextMenu
        menu={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onQuickPrompt={(id) => setQuickPrompt(id)}
        onKill={onKillAgent}
      />
      <QuickPromptModal
        open={!!quickPrompt}
        agent={agents.find(a => a.id === quickPrompt) || null}
        onClose={() => setQuickPrompt(null)}
        onSend={onQuickPromptSend}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
