// Live data layer — polls the claude-manager daemon and exposes a subscribe
// API for the React components. Maps backend rows into the design's data shape.
//
// Event fetching uses the daemon's `?since=<ts>` query parameter so each poll
// only transfers events newer than what we already have cached.

import { CONFIG, hydrateConfigFromDaemon } from "./config.js";
import { api } from "./api/client.js";
import { createReconnectingStream } from "./api/sse.js";

const state = {
  agents: [],
  events: [],
  pending: [],
  online: true,
  streaming: false,
  session: null,
};
const listeners = new Set();

// Monotonic counter bumped on every notify. Components using
// useSyncExternalStore read this as the snapshot — the `state` object itself
// is mutated in place across polls (so referential equality would miss
// updates), but the counter changes every time something downstream cares.
let version = 0;
function notify() {
  version++;
  listeners.forEach(fn => { try { fn(); } catch {} });
}

// Per-worker event cache + watermark. Survives across polls so each request
// only transfers events newer than the highest ts we've already seen.
const cachedEventsByWorker = new Map();   // workerId -> Event[] (ASC by ts)
const lastEventTsByWorker = new Map();    // workerId -> highest ts seen
// Mapped-event cache. mapEvent() is pure on (raw event, workerId, nameMap),
// so once a name map exists and events are mapped, we keep the mapped form
// and only re-map new arrivals on each poll. Without this, a long-running
// orchestrator with thousands of cached events paid O(N) JSON.parse +
// mapEvent calls on every SSE-triggered refetch — the single biggest
// client-side cost after the AnimatedMarkdown reflow fix.
const mappedEventsByWorker = new Map();   // workerId -> {raw: Event, mapped: MappedEvent|null}[]
// Bumped whenever the nameMap changes so cached entries get re-resolved
// (names can change mid-session: a worker that booted nameless gets a name
// from later events).
let nameMapVersion = 0;
const mappedNameVersion = new Map();      // workerId -> nameMapVersion at last cache

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
  if (!m) return CONFIG.defaultModel;
  const s = String(m).toLowerCase();
  if (s.startsWith("claude-")) return s;
  if (s.includes("opus")) return "claude-opus-4.5";
  if (s.includes("sonnet")) return "claude-sonnet-4.5";
  if (s.includes("haiku")) return "claude-haiku-4.5";
  return s;
}

function budgetFor(m) {
  const s = String(m || "").toLowerCase();
  if (s.includes("opus")) return CONFIG.modelBudgets.opus;
  if (s.includes("sonnet")) return CONFIG.modelBudgets.sonnet;
  if (s.includes("haiku")) return CONFIG.modelBudgets.haiku;
  return CONFIG.modelBudgets.default;
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
  // N-bucket histogram (1 min each) of meaningful events (tool calls + messages).
  const now = Date.now();
  const windowStart = now - CONFIG.activityBuckets * CONFIG.activityBucketMs;
  const buckets = new Array(CONFIG.activityBuckets).fill(0);
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
    const idx = Math.min(
      CONFIG.activityBuckets - 1,
      Math.floor((e.ts - windowStart) / CONFIG.activityBucketMs),
    );
    buckets[idx] += weight;
  }
  return buckets;
}

function mapWorker(w, allWorkers, toolCounts, signals, activityMap) {
  const isOrch = !!w.is_orchestrator;
  let depth = 0;
  let cur = w.parent_id;
  while (cur) {
    depth++;
    const next = allWorkers.find(x => x.id === cur);
    if (!next) break;
    cur = next.parent_id || null;
    if (depth > CONFIG.maxAgentTreeDepth) break;
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
    activity: activityMap.get(w.id) || new Array(CONFIG.activityBuckets).fill(0),
    description: (w.prompt || "").slice(0, 240),
    thinking: isThinking,
    branch: w.branch || null,
    cwd: w.cwd || w.worktree_from || null,
    isOrchestrator: isOrch,
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
      // Extended-thinking blocks get their own type so the UI can label them
      // distinctly from regular assistant prose.
      return { ...base, type: "thought", body: text };
    }
    if (p.kind === "tool_use") {
      const args = p.input ? JSON.stringify(p.input, null, 2) : "";
      // Keep the parsed input alongside the pretty-printed `args` string so
      // UI features (e.g. file-open button) can read structured fields like
      // `file_path` without re-parsing JSON on every render.
      return { ...base, type: "tool", tool: p.name, args, input: p.input || null, toolUseId: p.id || null };
    }
    if (p.kind === "tool_result") {
      // Empty text still needs to flow through so the matching tool flips out
      // of its "running" state — emit with an empty body and let the UI hide
      // the output pane / orphan block when there is nothing to show.
      // Do NOT run substituteIds here: MCP tools like spawn_worker return JSON
      // containing worker ids, and rewriting them to names breaks parseability
      // and corrupts what the user copies via the pane's copy button.
      const body = String(p.text || "").trim();
      return { ...base, type: p.isError ? "error" : "result", tool: "", body, toolUseId: p.toolUseId || null };
    }
    if (p.kind === "assistant_text") {
      const text = substituteIds(String(p.text || "").trim(), nameMap);
      if (!text) return null;
      // Plain assistant prose — rendered without the "thinking" badge so the
      // UI distinguishes the model's actual response from its internal
      // deliberation.
      return { ...base, type: "text", body: text };
    }
  }
  // Process lifecycle noise (spawn pid, exit code, worktree create/clean) is
  // visible through the agent's status badge — no need to clutter the feed.
  if (e.type === "spawn" || e.type === "exit" || e.type === "worktree") return null;
  return null;
}

// Aggregate per-worker derived signals (tool counts, prompt_sent, heartbeat
// watermark) from the cached event stream.
function deriveSignals(events) {
  const counts = {};
  let promptSent = false;
  let lastHeartbeatTs = 0;
  let heartbeatQuietMs = 0;
  for (const ev of events) {
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
  return { tools, promptSent, lastHeartbeatTs, heartbeatQuietMs };
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const [workers, pending, session] = await Promise.all([
      api.listWorkers(),
      api.listPending(),
      api.getSession(),
    ]);

    // Evict cache for workers no longer present (e.g. after DELETE).
    const activeIds = new Set(workers.map(w => w.id));
    for (const id of Array.from(cachedEventsByWorker.keys())) {
      if (!activeIds.has(id)) {
        cachedEventsByWorker.delete(id);
        lastEventTsByWorker.delete(id);
        mappedEventsByWorker.delete(id);
        mappedNameVersion.delete(id);
      }
    }

    const nameMap = new Map();
    for (const w of workers) if (w.name) nameMap.set(w.id, w.name);
    // Detect name additions/changes to know when to invalidate the mapped
    // cache (rare — names land in the first /workers response and stay).
    const nameSnapshot = JSON.stringify(Array.from(nameMap.entries()).sort());
    if (nameSnapshot !== window.__cmLastNameSnapshot) {
      window.__cmLastNameSnapshot = nameSnapshot;
      nameMapVersion++;
    }

    const toolCounts = new Map();
    const signals = new Map();
    const activityMap = new Map();

    await Promise.all(
      workers.map(async (w) => {
        try {
          // Forward pagination (order=asc): each round returns the OLDEST
          // events with ts > since. Loop until we get a short page — that's
          // how we guarantee no event is ever skipped, even on first load of
          // a worker with thousands of events and even when activity bursts
          // exceed the per-request limit between polls.
          const fetchBatch = [];
          let cursor = lastEventTsByWorker.get(w.id) || 0;
          for (;;) {
            const page = await api.getWorkerEvents(w.id, {
              since: cursor,
              order: "asc",
              limit: CONFIG.eventsPerWorkerLimit,
            });
            if (!Array.isArray(page) || page.length === 0) break;
            fetchBatch.push(...page);
            cursor = page[page.length - 1].ts;
            if (page.length < CONFIG.eventsPerWorkerLimit) break;
          }

          const existing = cachedEventsByWorker.get(w.id) || [];
          let merged = fetchBatch.length === 0
            ? existing
            : (existing.length === 0 ? fetchBatch : existing.concat(fetchBatch));
          if (fetchBatch.length > 0) {
            lastEventTsByWorker.set(w.id, fetchBatch[fetchBatch.length - 1].ts);
          }
          // FIFO drop: events are appended in ts-ascending order, so slicing
          // off the head preserves recency. The forward-pagination watermark
          // (lastEventTsByWorker) stays correct because we only ever cap from
          // the OLDEST end and the cursor tracks the NEWEST ts we've seen.
          if (merged.length > CONFIG.maxCachedEventsPerWorker) {
            merged = merged.slice(merged.length - CONFIG.maxCachedEventsPerWorker);
          }
          cachedEventsByWorker.set(w.id, merged);

          const sig = deriveSignals(merged);
          toolCounts.set(w.id, sig.tools);
          signals.set(w.id, {
            promptSent: sig.promptSent,
            lastHeartbeatTs: sig.lastHeartbeatTs,
            heartbeatQuietMs: sig.heartbeatQuietMs,
          });
          activityMap.set(w.id, computeActivity(merged));
        } catch {}
      })
    );

    const agents = workers.map(w => mapWorker(w, workers, toolCounts, signals, activityMap));

    // Flatten EVERY cached event into the global feed. Re-uses the
    // mappedEventsByWorker cache so already-seen events skip mapEvent +
    // JSON.parse. Worst case (cache miss / name change) is identical to
    // the previous behavior; best case (steady-state, new events trickling
    // in) is O(new events) not O(all events).
    const flat = [];
    for (const [wid, evs] of cachedEventsByWorker.entries()) {
      const lastNameVer = mappedNameVersion.get(wid) ?? -1;
      const stale = lastNameVer !== nameMapVersion;
      let mappedList = mappedEventsByWorker.get(wid);
      if (!mappedList || stale) {
        mappedList = evs.map((e) => ({ raw: e, mapped: mapEvent(e, wid, nameMap) }));
        mappedEventsByWorker.set(wid, mappedList);
        mappedNameVersion.set(wid, nameMapVersion);
      } else if (mappedList.length < evs.length) {
        // New events appended at the tail — map only those.
        const startIdx = mappedList.length;
        for (let i = startIdx; i < evs.length; i++) {
          mappedList.push({ raw: evs[i], mapped: mapEvent(evs[i], wid, nameMap) });
        }
      } else if (mappedList.length > evs.length) {
        // FIFO eviction shrank the cache — drop matching head from mapped.
        mappedList = mappedList.slice(mappedList.length - evs.length);
        mappedEventsByWorker.set(wid, mappedList);
      }
      for (const m of mappedList) if (m.mapped) flat.push(m.mapped);
    }
    flat.sort((a, b) => a._ts - b._ts);
    const events = flat;

    state.agents = agents;
    state.events = events;
    state.pending = pending;
    state.session = session;
    state.online = true;

    notify();
  } catch (e) {
    state.online = false;
    notify();
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
  // Monotonic version — useSyncExternalStore reads this as the snapshot so
  // React's referential equality check works even though `state` is mutated.
  getVersion() { return version; },
  sendMessage: async (text, agentId) => {
    if (!agentId) return false;
    const agent = state.agents.find(a => a.id === agentId);
    const r = agent?.isOrchestrator
      ? await api.sendOrchestratorMessage(agentId, text)
      : await api.sendWorkerMessage(agentId, text);
    poll();
    return r.ok;
  },
  killAgent: async (id) => {
    const r = await api.killWorker(id);
    // Evict eagerly so the UI does not flash stale events from a dead worker
    // between the DELETE and the next poll.
    cachedEventsByWorker.delete(id);
    lastEventTsByWorker.delete(id);
    poll();
    return r.ok;
  },
  spawnOrchestrator: async ({ name, cwd } = {}) => {
    // Orchestrators are always opus — daemon defaults to opus when model omitted.
    const r = await api.spawnOrchestrator({ name, cwd });
    poll();
    if (!r.ok) {
      return { ok: false, error: r.body?.error || `daemon ${r.status}` };
    }
    return { ok: true, id: r.body?.id };
  },
  approvePending: async (pendingId, updatedInput) => {
    const r = await api.approvePending(pendingId, updatedInput);
    poll();
    return r.ok;
  },
  denyPending: async (pendingId, reason) => {
    const r = await api.denyPending(pendingId, reason);
    poll();
    return r.ok;
  },
  refresh: poll,
};

let debounceTimer = null;
function schedulePoll() {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => { debounceTimer = null; poll(); }, CONFIG.refetchDebounceMs);
}

function connectStream() {
  createReconnectingStream({
    onOpen: () => { state.streaming = true; notify(); },
    onChange: schedulePoll,
    onMessage: schedulePoll,
    onClose: () => { state.streaming = false; notify(); },
  });
}

// Fetch daemon-provided overrides in parallel with the first poll so neither
// blocks the other — the merged values are picked up on the next render
// triggered by the poll completing.
hydrateConfigFromDaemon();
poll();
connectStream();
setInterval(poll, CONFIG.pollFallbackMs);
