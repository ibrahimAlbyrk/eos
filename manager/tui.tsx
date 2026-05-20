import React, { useState, useEffect, useMemo, useRef } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";

void React;

const ACCENT = "#D77757";
const DIM_TEXT = "#666666";
const DAEMON_URL = process.env.CLAUDE_MGR_URL ?? "http://127.0.0.1:7400";
const IS_TTY = !!process.stdin.isTTY;
const ORCH_ID = "orchestrator";
const SPINNER = ["◐", "◓", "◑", "◒"];
const SPINNER_MS = 80;
const POLL_MS = 1000;            // safety fallback when SSE is unavailable
const SSE_FALLBACK_POLL_MS = 5000; // long-poll heartbeat while SSE is healthy
const SSE_DEBOUNCE_MS = 80;       // coalesce SSE bursts before refetching
const MAX_ACTIVITY = 5;
const MAX_ORCH_ACTIVITY = 8;

interface Worker {
  id: string;
  state: string;
  branch: string | null;
  name: string | null;
  pid: number | null;
  port: number;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  prompt: string;
}
interface Pending {
  id: string;
  worker_id: string;
  tool_name: string;
  input: string;
  created_at: number;
  expires_at: number;
}
interface Event {
  ts: number;
  type: string;
  payload: string | null;
}

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [workers, setWorkers] = useState<Worker[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [eventsBy, setEventsBy] = useState<Record<string, Event[]>>({});
  const [chatInput, setChatInput] = useState("");
  const [flash, setFlash] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [spinner, setSpinner] = useState(0);
  const [online, setOnline] = useState(true);
  const [, force] = useState(0);

  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), POLL_MS);
    const sp = setInterval(() => setSpinner((f) => (f + 1) % SPINNER.length), SPINNER_MS);
    return () => { clearInterval(t); clearInterval(sp); };
  }, []);

  useEffect(() => {
    fetch(`${DAEMON_URL}/orchestrator/start`, { method: "POST" }).catch(() => {});
  }, []);

  // Workers + pending — driven by SSE 'change' events with a long-poll fallback.
  // lastEventTsRef tracks the highest ts seen per worker so each refresh can
  // delta-fetch via ?since= rather than refetching the whole event window.
  const lastEventTsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let alive = true;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const fetchAll = async () => {
      try {
        const [w, p] = await Promise.all([
          fetch(`${DAEMON_URL}/workers`).then((r) => r.json()),
          fetch(`${DAEMON_URL}/pending`).then((r) => r.json()),
        ]);
        if (!alive) return;
        setWorkers(w);
        setPending(p);
        setOnline(true);

        const active = (w as Worker[]).filter((x) => x.state !== "DONE").map((x) => x.id);

        // Evict cache for workers we no longer track.
        for (const id of Array.from(lastEventTsRef.current.keys())) {
          if (!active.includes(id)) lastEventTsRef.current.delete(id);
        }

        // Delta-fetch events per active worker. Collect into a side map, then
        // setEventsBy() once at the end so React batches a single re-render.
        const deltas: Array<{ id: string; events: Event[] }> = [];
        await Promise.all(
          active.map(async (id) => {
            try {
              const since = lastEventTsRef.current.get(id) ?? 0;
              const url = `${DAEMON_URL}/workers/${id}/events?since=${since}&limit=30`;
              const newEvents = (await fetch(url).then((r) => r.json())) as Event[];
              if (newEvents.length > 0) {
                lastEventTsRef.current.set(id, newEvents[newEvents.length - 1].ts);
              }
              deltas.push({ id, events: newEvents });
            } catch {}
          })
        );
        if (!alive) return;
        setEventsBy((prev) => {
          const next: Record<string, Event[]> = {};
          for (const id of active) next[id] = prev[id] ?? [];
          for (const { id, events } of deltas) {
            if (events.length === 0) continue;
            next[id] = (next[id] ?? []).concat(events).slice(-30);
          }
          return next;
        });
      } catch {
        if (alive) setOnline(false);
      }
    };

    const schedule = () => {
      if (debounce) return;
      debounce = setTimeout(() => { debounce = null; fetchAll(); }, SSE_DEBOUNCE_MS);
    };

    fetchAll();

    // SSE for push updates. Node 22.4+ exposes EventSource as a global; on
    // older runtimes we silently fall back to short polling.
    const ES = (globalThis as { EventSource?: typeof EventSource }).EventSource;
    let es: EventSource | null = null;
    let pollMs = POLL_MS;
    if (typeof ES === "function") {
      try {
        es = new ES(`${DAEMON_URL}/stream`);
        es.addEventListener("change", schedule);
        es.onmessage = schedule;
        es.onerror = () => { /* keep fallback poll running */ };
        pollMs = SSE_FALLBACK_POLL_MS;
      } catch { es = null; }
    }
    const id = setInterval(fetchAll, pollMs);

    return () => {
      alive = false;
      clearInterval(id);
      if (debounce) clearTimeout(debounce);
      if (es) es.close();
    };
  }, []);

  function notify(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
  }

  async function approveOldest() {
    if (pending.length === 0) { notify("no pending"); return; }
    const p = pending[0];
    try {
      const r = await fetch(`${DAEMON_URL}/pending/${p.id}/decision`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow" }),
      });
      notify(r.ok ? `approved ${p.id}` : "approve failed");
    } catch { notify("approve failed"); }
  }
  async function denyOldest(reason?: string) {
    if (pending.length === 0) { notify("no pending"); return; }
    const p = pending[0];
    try {
      const r = await fetch(`${DAEMON_URL}/pending/${p.id}/decision`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "deny", reason: reason ?? "denied via TUI" }),
      });
      notify(r.ok ? `denied ${p.id}` : "deny failed");
    } catch { notify("deny failed"); }
  }
  async function killWorker(id: string) {
    try {
      await fetch(`${DAEMON_URL}/workers/${id}`, { method: "DELETE" });
      notify(`killing ${id}`);
    } catch { notify("kill failed"); }
  }

  const submittingRef = useRef(false);

  async function handleSubmit(value: string) {
    const text = value.trim();
    if (!text || submittingRef.current) return;
    submittingRef.current = true;

    // Slash commands
    setChatInput("");
    if (text.startsWith("/")) {
      const [cmd, ...args] = text.slice(1).split(/\s+/);
      submittingRef.current = false;
      switch (cmd) {
        case "approve": case "a":
          await approveOldest();
          return;
        case "deny": case "d":
          await denyOldest(args.join(" ") || undefined);
          return;
        case "kill": case "k":
          if (!args[0]) { notify("usage: /kill <id>"); return; }
          await killWorker(args[0]);
          return;
        case "quit": case "exit": case "q":
          exit();
          return;
        case "help": case "?":
          notify("/approve  /deny  /kill <id>  /quit  (anything else → orchestrator)");
          return;
        default:
          notify(`unknown command: /${cmd}`);
          return;
      }
    }

    // Chat to orchestrator
    setSending(true);
    try {
      const r = await fetch(`${DAEMON_URL}/orchestrator/message`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      notify(r.ok ? `→ ${truncate(text, 60)}` : `send failed: ${r.status}`);
    } catch (e) {
      notify(`send failed: ${(e as Error).message}`);
    } finally {
      setSending(false);
      submittingRef.current = false;
    }
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") { exit(); return; }
    if (key.return) { handleSubmit(chatInput); return; }
    if (key.escape) { setChatInput(""); return; }
    if (key.backspace || key.delete) {
      setChatInput((s) => s.slice(0, -1));
      return;
    }
    // Ignore navigation/control keys; only accept printable input
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.tab || key.pageUp || key.pageDown) return;
    if (key.ctrl || key.meta) return;
    if (input && input.length >= 1) {
      setChatInput((s) => s + input);
    }
  }, { isActive: IS_TTY });

  const cols = stdout.columns ?? 120;

  const orch = workers.find((w) => w.id === ORCH_ID);
  const activeWorkers = workers
    .filter((w) => w.id !== ORCH_ID && w.state !== "DONE")
    .sort((a, b) => b.started_at - a.started_at);
  const nameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workers) if (w.name) m.set(w.id, w.name);
    return m;
  }, [workers]);
  const awaitingCount = pending.length;
  const workingCount = activeWorkers.filter((w) => w.state === "WORKING" || w.state === "SPAWNING").length;
  const idleCount = activeWorkers.filter((w) => w.state === "IDLE").length;

  return (
    <Box flexDirection="column" width={cols}>
      <Header
        cols={cols}
        awaiting={awaitingCount}
        working={workingCount}
        idle={idleCount}
        online={online}
        flash={flash}
      />

      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Text color={ACCENT}>ORCHESTRATOR</Text>
        {orch ? (
          <AgentBlock worker={orch} events={eventsBy[orch.id] ?? []} spinner={spinner} maxActivity={MAX_ORCH_ACTIVITY} isOrch lineWidth={cols - 2} nameMap={nameMap} />
        ) : (
          <Text dimColor>  starting up…</Text>
        )}
      </Box>

      {activeWorkers.length > 0 && (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Text color={ACCENT}>WORKING</Text>
          {activeWorkers.map((w) => (
            <AgentBlock key={w.id} worker={w} events={eventsBy[w.id] ?? []} spinner={spinner} maxActivity={MAX_ACTIVITY} lineWidth={cols - 2} nameMap={nameMap} />
          ))}
        </Box>
      )}

      {pending.length > 0 && (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Text color="yellow">NEEDS APPROVAL</Text>
          {pending.map((p) => (
            <PendingRow key={p.id} pending={p} cols={cols - 4} nameMap={nameMap} />
          ))}
        </Box>
      )}

      <Box marginTop={1} paddingX={1}>
        <Text color={DIM_TEXT}>{"─".repeat(Math.max(0, cols - 2))}</Text>
      </Box>
      <Box paddingX={1}>
        <Text color={DIM_TEXT}>│ </Text>
        <Text color={ACCENT}>ⓘ</Text>
        <Text> </Text>
        {sending ? (
          <Text color={ACCENT}>sending…</Text>
        ) : chatInput.length === 0 ? (
          <>
            <Text dimColor>{IS_TTY ? "describe the work the orchestrator should dispatch…   (try /help)" : "(non-TTY snapshot)"}</Text>
            {IS_TTY && <Text inverse> </Text>}
          </>
        ) : (
          <>
            <Text>{chatInput}</Text>
            {IS_TTY && <Text inverse> </Text>}
          </>
        )}
      </Box>
      <Box paddingX={1}>
        <Text color={ACCENT}>▸▸ </Text>
        <Text color={DIM_TEXT}>
          {orch ? `orchestrator ${orch.state.toLowerCase()}` : "orchestrator —"}
          {"  ·  "}
          enter send · esc clear · /approve · /deny · /kill {"<id>"} · /quit
        </Text>
      </Box>
    </Box>
  );
}

function Header({ awaiting, working, idle, online, flash }: {
  cols: number; awaiting: number; working: number; idle: number; online: boolean; flash: string | null;
}) {
  const mascot = [
    "▐▛███▜▌",
    "▐█████▌",
    " ▘▘ ▝▝ ",
  ];
  return (
    <Box paddingX={1}>
      <Box flexDirection="column" marginRight={2}>
        {mascot.map((line, i) => (
          <Text key={i} color={ACCENT}>{line}</Text>
        ))}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Box>
          <Text bold color={ACCENT}>claude-manager</Text>
          <Text color={DIM_TEXT}>  v0.1.0  ·  Claude Max  ·  127.0.0.1:7400</Text>
          {!online && <Text color="red">  ·  daemon offline</Text>}
        </Box>
        <Text color={DIM_TEXT}>{process.cwd()}</Text>
        <Box>
          <Text color={awaiting > 0 ? "yellow" : DIM_TEXT} bold={awaiting > 0}>{awaiting} awaiting input</Text>
          <Text color={DIM_TEXT}>  ·  </Text>
          <Text color={working > 0 ? ACCENT : DIM_TEXT} bold={working > 0}>{working} working</Text>
          <Text color={DIM_TEXT}>  ·  </Text>
          <Text color={DIM_TEXT}>{idle} idle</Text>
          {flash && (
            <>
              <Text color={DIM_TEXT}>     </Text>
              <Text color="green">· {flash}</Text>
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function AgentBlock({ worker, events, spinner, maxActivity, isOrch, lineWidth, nameMap }: {
  worker: Worker; events: Event[]; spinner: number; maxActivity: number; isOrch?: boolean; lineWidth: number; nameMap: Map<string, string>;
}) {
  const icon = agentIcon(worker, spinner, !!isOrch);
  const color = agentColor(worker.state);
  const label = isOrch ? "orchestrator" : (worker.name ?? worker.id.slice(2));
  const status = truncate(substituteIds(statusText(worker.state, events), nameMap), Math.max(20, lineWidth - 38));
  const dur = formatDur(worker.started_at, worker.ended_at);
  const activity = activityLines(events, maxActivity, !!isOrch, lineWidth - 5, nameMap);

  // manual flex: account for ' I  LABEL18  ' = 23, ' DUR' = ~7
  const consumed = 1 + 1 + 2 + 18 + 2 + 7;
  const statusSpace = Math.max(20, lineWidth - consumed);
  const statusTrunc = truncate(status, statusSpace);
  const padStatus = statusTrunc + " ".repeat(Math.max(1, statusSpace - [...statusTrunc].length));
  return (
    <Box flexDirection="column">
      <Box>
        <Text> </Text>
        <Text color={color}>{icon}</Text>
        <Text>  </Text>
        <Text bold>{padEndUnicode(label, 18)}</Text>
        <Text>  </Text>
        <Text color={statusColor(worker.state)}>{padStatus}</Text>
        <Text color={DIM_TEXT}>{dur.padStart(6)}</Text>
      </Box>
      {activity.map((line, i) => {
        const dimTier = activity.length - 1 - i; // newest at bottom → tier 0; older → higher
        const opacity = dimTier === 0 ? 1 : dimTier <= 1 ? 0.85 : 0.6;
        return (
          <Box key={i}>
            <Text>     </Text>
            <Text color={lineKindColor(line.kind)} dimColor={opacity < 1 && line.kind !== "error"}>
              {linePrefix(line.kind)} {line.text}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function PendingRow({ pending, cols, nameMap }: { pending: Pending; cols: number; nameMap: Map<string, string> }) {
  const secs = Math.max(0, Math.round((pending.expires_at - Date.now()) / 1000));
  const ttlColor = secs < 10 ? "red" : "yellow";
  let inputBrief = "";
  try {
    const j = JSON.parse(pending.input);
    inputBrief = String(j.command ?? j.file_path ?? j.url ?? JSON.stringify(j));
  } catch { inputBrief = pending.input; }
  const worker = nameMap.get(pending.worker_id) ?? (pending.worker_id.length > 16 ? pending.worker_id.slice(0, 16) : pending.worker_id);
  return (
    <Box flexDirection="column">
      <Box>
        <Text> </Text>
        <Text color="yellow">▲</Text>
        <Text>  </Text>
        <Text bold>{padEndUnicode(worker, 18)}</Text>
        <Text>  </Text>
        <Box flexGrow={1}>
          <Text>{pending.tool_name} <Text color={DIM_TEXT}>{truncate(inputBrief, cols - 40)}</Text></Text>
        </Box>
        <Text color={ttlColor}>{secs}s</Text>
      </Box>
      <Box>
        <Text>     </Text>
        <Text color={DIM_TEXT}>pending approval · </Text>
        <Text color={ttlColor}>auto-deny in {secs}s</Text>
        <Text color={DIM_TEXT}> · type </Text>
        <Text color={ACCENT}>/approve</Text>
        <Text color={DIM_TEXT}> or </Text>
        <Text color={ACCENT}>/deny</Text>
      </Box>
    </Box>
  );
}

function agentIcon(w: Worker, spinner: number, isOrch: boolean): string {
  if (isOrch) {
    if (w.state === "WORKING") return SPINNER[spinner];
    return "▣";
  }
  switch (w.state) {
    case "SPAWNING": return "◌";
    case "WORKING":  return SPINNER[spinner];
    case "IDLE":     return "○";
    case "ENDING":   return "◑";
    case "KILLING":  return "✗";
    default:         return "·";
  }
}

function agentColor(state: string): string | undefined {
  switch (state) {
    case "SPAWNING": return "magenta";
    case "WORKING":  return ACCENT;
    case "IDLE":     return "yellow";
    case "KILLING":  return "red";
    case "ENDING":   return DIM_TEXT;
    default:         return DIM_TEXT;
  }
}

function statusColor(state: string): string | undefined {
  if (state === "KILLING") return "red";
  if (state === "WORKING") return undefined;
  if (state === "IDLE") return DIM_TEXT;
  return DIM_TEXT;
}

function statusText(state: string, events: Event[]): string {
  if (state === "SPAWNING") return "Starting up…";
  if (state === "ENDING") return "Wrapping up";
  if (state === "KILLING") return "Stopping";

  let lastTool: { name: string; input: Record<string, unknown> } | null = null;
  let lastAssistant = "";
  for (const e of events) {
    if (e.type !== "jsonl" || !e.payload) continue;
    try {
      const p = JSON.parse(e.payload);
      if (p.kind === "tool_use") lastTool = { name: p.name, input: p.input ?? {} };
      else if (p.kind === "assistant_text") lastAssistant = String(p.text ?? "");
    } catch {}
  }

  if (state === "WORKING") {
    if (lastTool) return runningVerb(lastTool.name, lastTool.input);
    return "Thinking…";
  }
  if (state === "IDLE") {
    if (lastAssistant) return truncate(lastAssistant.replace(/\s+/g, " "), 80);
    return "Standing by";
  }
  return state.toLowerCase();
}

function runningVerb(tool: string, input: Record<string, unknown>): string {
  const get = (k: string) => String(input?.[k] ?? "");
  switch (tool) {
    case "Bash":      return `Running ${truncate(get("command"), 60)}`;
    case "Read":      return `Reading ${truncate(get("file_path"), 60)}`;
    case "Write":     return `Writing ${truncate(get("file_path"), 60)}`;
    case "Edit":      return `Editing ${truncate(get("file_path"), 60)}`;
    case "Glob":      return `Searching ${truncate(get("pattern"), 60)}`;
    case "Grep":      return `Searching ${truncate(get("pattern"), 60)}`;
    case "WebFetch":  return `Fetching ${truncate(get("url"), 60)}`;
    case "WebSearch": return `Searching the web for ${truncate(get("query"), 50)}`;
    default:
      if (tool.startsWith("mcp__")) {
        const name = tool.replace(/^mcp__[^_]+__/, "");
        return `Calling ${name}`;
      }
      return `Running ${tool}`;
  }
}

type ActLine = { kind: "tool_use" | "result" | "error" | "assistant" | "user" | "policy"; text: string };

function activityLines(events: Event[], max: number, isOrch: boolean, lineWidth: number, nameMap: Map<string, string>): ActLine[] {
  const out: ActLine[] = [];
  const cap = Math.max(20, lineWidth - 2);
  const sub = (s: string) => truncate(substituteIds(s, nameMap), cap);
  for (const e of events) {
    if (e.type === "user_message" && e.payload) {
      try {
        const p = JSON.parse(e.payload);
        const text = String(p.text ?? "").replace(/\s+/g, " ").trim();
        if (text) out.push({ kind: "user", text: sub(text) });
      } catch {}
    } else if (e.type === "jsonl" && e.payload) {
      try {
        const p = JSON.parse(e.payload);
        if (p.kind === "tool_use" && !isOrch) {
          // Skip tool_use for orchestrator — assistant_text already narrates spawn/etc.
          out.push({ kind: "tool_use", text: sub(formatToolUse(p, isOrch)) });
        } else if (p.kind === "tool_result" && !isOrch) {
          const t = String(p.text ?? "").replace(/\s+/g, " ").trim();
          if (t) out.push({ kind: p.isError ? "error" : "result", text: sub(t) });
        } else if (p.kind === "assistant_text") {
          const t = String(p.text ?? "").replace(/\s+/g, " ").trim();
          if (t) out.push({ kind: "assistant", text: sub(t) });
        }
      } catch {}
    } else if (e.type === "policy" && e.payload) {
      try {
        const p = JSON.parse(e.payload);
        if (p.decision === "deny") {
          out.push({ kind: "policy", text: `policy denied ${p.tool}` });
        }
      } catch {}
    }
  }
  return out.slice(-max);
}

function substituteIds(text: string, names: Map<string, string>): string {
  // 1) "name (w-xxxxx)" → "name"  (drop the parenthetical id)
  let out = text.replace(/\s*\(w-[a-z0-9]+\)/g, "");
  // 2) "w-xxxxx (name)" → "name"
  out = out.replace(/w-[a-z0-9]+\s*\(([^)]+)\)/g, "$1");
  // 3) any remaining "w-xxxxx" → friendly name if known
  out = out.replace(/\bw-[a-z0-9]+\b/g, (id) => names.get(id) ?? id);
  return out;
}

function formatToolUse(p: { name: string; input: Record<string, unknown> }, isOrch: boolean): string {
  const t = p.name;
  const i = p.input ?? {};
  const get = (k: string) => String(i?.[k] ?? "");
  if (isOrch && t.startsWith("mcp__orchestrator__")) {
    const sub = t.replace("mcp__orchestrator__", "");
    if (sub === "spawn_worker") return `Spawning worker — ${truncate(get("prompt"), 80)}`;
    if (sub === "list_workers") return `Listing workers`;
    if (sub === "get_worker") return `Inspecting ${get("id")}`;
    if (sub === "kill_worker") return `Killing ${get("id")}`;
    if (sub === "list_pending_permissions") return `Checking pending permissions`;
    return `${sub}`;
  }
  switch (t) {
    case "Bash":      return `Ran Bash: ${truncate(get("command"), 100)}`;
    case "Read":      return `Read ${truncate(get("file_path"), 80)}`;
    case "Write":     return `Wrote ${truncate(get("file_path"), 80)}`;
    case "Edit":      return `Edited ${truncate(get("file_path"), 80)}`;
    case "Glob":      return `Globbed ${truncate(get("pattern"), 80)}`;
    case "Grep":      return `Greped for ${truncate(get("pattern"), 80)}`;
    case "WebFetch":  return `Fetched ${truncate(get("url"), 80)}`;
    case "WebSearch": return `Searched web: ${truncate(get("query"), 80)}`;
    default:          return `${t} ${truncate(JSON.stringify(i), 60)}`;
  }
}

function linePrefix(kind: ActLine["kind"]): string {
  switch (kind) {
    case "tool_use":  return "↳";
    case "result":    return "✓";
    case "error":     return "✗";
    case "assistant": return "‹";
    case "user":      return "›";
    case "policy":    return "·";
  }
}

function lineKindColor(kind: ActLine["kind"]): string | undefined {
  if (kind === "error") return "red";
  if (kind === "policy") return "yellow";
  if (kind === "user") return ACCENT;
  return undefined;
}

function formatDur(start: number, end: number | null): string {
  if (!start) return "—";
  const ms = (end ?? Date.now()) - start;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${(Math.floor(s / 60) % 60).toString().padStart(2, "0")}m`;
}

function truncate(s: string, n: number): string {
  if (n < 4) return s.slice(0, Math.max(0, n));
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function padEndUnicode(s: string, n: number): string {
  const len = [...s].length;
  if (len >= n) return s;
  return s + " ".repeat(n - len);
}

if (!IS_TTY) {
  const app = render(<App />);
  setTimeout(() => { app.unmount(); process.exit(0); }, 2500);
} else {
  render(<App />);
}
