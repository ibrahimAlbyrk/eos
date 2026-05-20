// Live data layer — polls the claude-manager daemon and exposes a subscribe
// API for the React components. Maps backend rows into the design's data shape.

(function () {
  const DAEMON = location.origin;
  const POLL_FALLBACK_MS = 4000;
  const REFETCH_DEBOUNCE_MS = 80;
  const ACTIVITY_BUCKETS = 24;
  const ACTIVITY_BUCKET_MS = 60_000; // 1-minute buckets → 24 minute window

  const state = { agents: [], events: [], pending: [], online: true, streaming: false, session: null };
  const listeners = new Set();

  function mapState(s) {
    const u = String(s || "").toUpperCase();
    if (u === "SPAWNING") return "queued";
    if (u === "WORKING") return "running";
    if (u === "IDLE") return "waiting";
    if (u === "ENDING") return "done";
    if (u === "DONE") return "done";
    if (u === "KILLING") return "killed";
    return u.toLowerCase();
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
  }
  function fmtDur(ms) {
    if (ms == null || ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function normalizeModel(m) {
    if (!m) return "claude-opus-4.5";
    const s = String(m).toLowerCase();
    if (s.startsWith("claude-")) return s;
    if (s.includes("opus")) return "claude-opus-4.5";
    if (s.includes("sonnet")) return "claude-sonnet-4.5";
    if (s.includes("haiku")) return "claude-haiku-4.5";
    return s;
  }

  function budgetFor(m) {
    const s = String(m || "").toLowerCase();
    if (s.includes("opus")) return 1_000_000;
    if (s.includes("sonnet")) return 1_000_000;
    if (s.includes("haiku")) return 200_000;
    return 200_000;
  }

  function substituteIds(text, names) {
    if (!text) return "";
    let out = String(text);
    out = out.replace(/\s*\(w-[a-z0-9]+\)/g, "");
    out = out.replace(/w-[a-z0-9]+\s*\(([^)]+)\)/g, "$1");
    out = out.replace(/\bw-[a-z0-9]+\b/g, (id) => names.get(id) || id);
    return out;
  }

  function computeActivity(events) {
    // 24-bucket histogram (1 min each) of meaningful events (tool calls + messages)
    // for the last 24 minutes. Index 0 is oldest, index 23 is current minute.
    const now = Date.now();
    const windowStart = now - ACTIVITY_BUCKETS * ACTIVITY_BUCKET_MS;
    const buckets = new Array(ACTIVITY_BUCKETS).fill(0);
    for (const e of events) {
      if (e.ts < windowStart) continue;
      let weight = 0;
      if (e.type === "jsonl") {
        try {
          const p = JSON.parse(e.payload || "{}");
          if (p.kind === "tool_use") weight = 1;
          else if (p.kind === "assistant_text") weight = 1;
        } catch {}
      } else if (e.type === "user_message") weight = 2;
      else if (e.type === "hook") weight = 0;
      if (!weight) continue;
      const idx = Math.min(ACTIVITY_BUCKETS - 1, Math.floor((e.ts - windowStart) / ACTIVITY_BUCKET_MS));
      buckets[idx] += weight;
    }
    return buckets;
  }

  function mapWorker(w, allWorkers, toolCounts, signals, activityMap) {
    const isOrch = w.id === "orchestrator";
    let depth = 0;
    let cur = w.parent_id;
    while (cur) {
      depth++;
      const next = allWorkers.find(x => x.id === cur);
      if (!next) break;
      cur = next.parent_id || null;
      if (depth > 8) break;
    }
    const role = isOrch ? "main" : depth >= 2 ? "sub2" : "sub";
    const rawStatus = mapState(w.state);
    const startedTs = w.started_at || 0;
    const endedTs = w.ended_at || null;
    const elapsedMs = endedTs ? endedTs - startedTs : Date.now() - startedTs;
    const tools = toolCounts.get(w.id) || [];
    const sig = (signals && signals.get(w.id)) || {};
    const isThinking =
      rawStatus === "queued" &&
      (sig.promptSent || sig.lastHeartbeatTs) &&
      elapsedMs > 800;
    const status = isThinking ? "thinking" : rawStatus;
    const tIn = w.tokens_in || 0;
    const tOut = w.tokens_out || 0;
    return {
      id: w.id,
      name: w.name || (isOrch ? "Orchestrator" : w.id.slice(2, 10)),
      role,
      depth,
      parent: w.parent_id || null,
      status,
      model: normalizeModel(w.model),
      started: fmtTime(startedTs),
      startedTs,
      endedTs,
      elapsed: fmtDur(elapsedMs),
      tokens: { in: tIn, out: tOut, budget: budgetFor(w.model) },
      cost: w.cost_usd || 0,
      tools,
      activity: activityMap.get(w.id) || new Array(ACTIVITY_BUCKETS).fill(0),
      description: (w.prompt || "").slice(0, 240),
      thinking: isThinking,
      branch: w.branch || null,
      cwd: w.cwd || w.worktree_from || null,
      lastHeartbeatTs: sig.lastHeartbeatTs || null,
      heartbeatQuietMs: sig.heartbeatQuietMs || 0,
    };
  }

  function mapEvent(e, workerId, nameMap) {
    let p = null;
    try { p = e.payload ? JSON.parse(e.payload) : null; } catch {}
    const ts = fmtTime(e.ts);
    const base = { id: `${workerId}-${e.id}`, _ts: e.ts, ts, agent: workerId };

    if (e.type === "user_message" && p) {
      return { ...base, type: "user", body: substituteIds(p.text, nameMap) };
    }
    if (e.type === "hook") return null;
    if (e.type === "lifecycle") return null;
    if (e.type === "state") return null;
    if (e.type === "usage") return null;
    if (e.type === "policy" && p && p.decision === "deny") {
      return { ...base, type: "error", body: `policy denied ${p.tool}: ${p.reason || ""}` };
    }
    if (e.type === "permission_pending" && p) {
      return { ...base, type: "policy", body: `permission pending — awaiting approval` };
    }
    if (e.type === "permission_ttl_deny" && p) {
      return { ...base, type: "error", body: `permission auto-denied (TTL)` };
    }
    if (e.type === "heartbeat") return null;
    if (e.type === "jsonl" && p) {
      if (p.kind === "thinking") {
        const text = String(p.text || "").trim();
        if (!text) return null;
        return { ...base, type: "thought", body: text.slice(0, 4096) };
      }
      if (p.kind === "tool_use") {
        const args = p.input ? JSON.stringify(p.input, null, 2) : "";
        return { ...base, type: "tool", tool: p.name, args, toolUseId: p.id || null };
      }
      if (p.kind === "tool_result") {
        const text = String(p.text || "").trim();
        if (!text) return null;
        return { ...base, type: p.isError ? "error" : "result", tool: "", body: substituteIds(text.slice(0, 4096), nameMap), toolUseId: p.toolUseId || null };
      }
      if (p.kind === "assistant_text") {
        const text = substituteIds(String(p.text || "").trim(), nameMap);
        if (!text) return null;
        return { ...base, type: "thought", body: text.slice(0, 4096) };
      }
    }
    if (e.type === "spawn" && p) {
      return { ...base, type: "system", body: `process spawned · pid ${p.pid || "?"}` };
    }
    if (e.type === "exit" && p) {
      const code = p.code;
      const label = code === 129 ? "completed (SIGHUP)" : code === 143 ? "killed (SIGTERM)" : code === 0 ? "exit 0" : `exit ${code}`;
      return { ...base, type: "complete", body: label };
    }
    if (e.type === "worktree" && p) {
      return { ...base, type: "system", body: `worktree ${p.phase || ""} ${p.path || ""}`.trim() };
    }
    return null;
  }

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const [workers, pending, session] = await Promise.all([
        fetch(`${DAEMON}/workers`).then(r => r.json()),
        fetch(`${DAEMON}/pending`).then(r => r.json()),
        fetch(`${DAEMON}/session`).then(r => r.json()).catch(() => null),
      ]);

      const nameMap = new Map();
      for (const w of workers) if (w.name) nameMap.set(w.id, w.name);

      const eventsByAgent = {};
      const toolCounts = new Map();
      const signals = new Map();
      const activityMap = new Map();

      await Promise.all(
        workers.map(async (w) => {
          try {
            const e = await fetch(`${DAEMON}/workers/${w.id}/events?limit=400`).then(r => r.json());
            eventsByAgent[w.id] = e;
            const counts = {};
            let promptSent = false;
            let lastHeartbeatTs = 0;
            let heartbeatQuietMs = 0;
            for (const ev of e) {
              if (ev.type === "jsonl" && ev.payload) {
                try {
                  const pl = JSON.parse(ev.payload);
                  if (pl.kind === "tool_use" && pl.name) counts[pl.name] = (counts[pl.name] || 0) + 1;
                } catch {}
              }
              if (ev.type === "lifecycle" && ev.payload) {
                try { const pl = JSON.parse(ev.payload); if (pl.phase === "prompt_sent") promptSent = true; } catch {}
              }
              if (ev.type === "heartbeat" && ev.ts > lastHeartbeatTs) {
                lastHeartbeatTs = ev.ts;
                try { const pl = JSON.parse(ev.payload || "{}"); heartbeatQuietMs = pl.quietMs || 0; } catch {}
              }
            }
            const tools = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
            toolCounts.set(w.id, tools);
            signals.set(w.id, { promptSent, lastHeartbeatTs, heartbeatQuietMs });
            activityMap.set(w.id, computeActivity(e));
          } catch {}
        })
      );

      const agents = workers.map(w => mapWorker(w, workers, toolCounts, signals, activityMap));

      const flat = [];
      for (const wid of Object.keys(eventsByAgent)) {
        for (const e of eventsByAgent[wid]) {
          const mapped = mapEvent(e, wid, nameMap);
          if (mapped) flat.push(mapped);
        }
      }
      flat.sort((a, b) => a._ts - b._ts);
      const events = flat.slice(-300);

      state.agents = agents;
      state.events = events;
      state.pending = pending;
      state.session = session;
      state.online = true;

      listeners.forEach(fn => { try { fn(); } catch {} });
    } catch (e) {
      state.online = false;
      listeners.forEach(fn => { try { fn(); } catch {} });
    } finally {
      polling = false;
    }
  }

  window.fmtDur = fmtDur;

  window.live = {
    state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    sendMessage: async (text, agentId) => {
      const target = (!agentId || agentId === "orchestrator") ? "/orchestrator/message" : `/workers/${agentId}/message`;
      const r = await fetch(`${DAEMON}${target}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      poll();
      return r.ok;
    },
    killAgent: async (id) => {
      const r = await fetch(`${DAEMON}/workers/${id}`, { method: "DELETE" });
      poll();
      return r.ok;
    },
    spawnOrchestrator: async () => {
      const r = await fetch(`${DAEMON}/orchestrator/start`, { method: "POST" });
      poll();
      return r.ok;
    },
    approvePending: async (pendingId, updatedInput) => {
      const body = { decision: "allow" };
      if (updatedInput) body.updatedInput = updatedInput;
      const r = await fetch(`${DAEMON}/pending/${pendingId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      poll();
      return r.ok;
    },
    denyPending: async (pendingId, reason) => {
      const r = await fetch(`${DAEMON}/pending/${pendingId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "deny", reason: reason || "denied via web UI" }),
      });
      poll();
      return r.ok;
    },
    refresh: poll,
  };

  // Auto-start orchestrator on first load
  fetch(`${DAEMON}/orchestrator/start`, { method: "POST" }).catch(() => {});

  let debounceTimer = null;
  function schedulePoll() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => { debounceTimer = null; poll(); }, REFETCH_DEBOUNCE_MS);
  }

  function connectStream() {
    try {
      const es = new EventSource(`${DAEMON}/stream`);
      es.onopen = () => { state.streaming = true; listeners.forEach(fn => { try { fn(); } catch {} }); };
      es.addEventListener("change", schedulePoll);
      es.onmessage = schedulePoll;
      es.onerror = () => {
        state.streaming = false;
        listeners.forEach(fn => { try { fn(); } catch {} });
      };
    } catch (_) {}
  }

  poll();
  connectStream();
  setInterval(poll, POLL_FALLBACK_MS);
})();
