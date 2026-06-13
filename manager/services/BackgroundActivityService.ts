// In-memory registry of the live background processes a worker has spawned —
// the Monitor tool and `Bash run_in_background`. Both are ASYNC: the tool call
// returns immediately (tool_running → tool_done within ms) while the real
// process keeps running, so a single tool pair cannot tell us "still alive".
// We therefore track from the START signal (tool_running) and clear when the
// turn that started them ends (the route calls clearWorker on Stop/SessionEnd)
// or the worker dies — a turn-scoped indicator, backed by the route's
// WORKING-only enrichment filter. The async finish itself isn't observable
// (tool_done fires ~200ms after start, at arm time, not completion), so this is
// the honest signal we have. Ephemeral by design: a daemon restart kills every
// worker process, so a fresh empty map is the correct state and these entries
// are never persisted.

import type { Clock } from "../../core/src/ports/Clock.ts";
import type {
  BackgroundActivityEntry,
  BackgroundActivityKind,
} from "../../contracts/src/background-activity.ts";

interface Classified {
  kind: BackgroundActivityKind;
  label: string;
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// The one place that decides which tool calls count as a tracked background
// process. Adding a backend's long-running tool is one more case here (OCP).
export function classifyBackgroundTool(
  toolName: string,
  input: Record<string, unknown>,
): Classified | null {
  if (toolName === "Monitor") {
    return { kind: "monitor", label: strOf(input.description) || strOf(input.command) || "monitor" };
  }
  if (toolName === "Bash" && input.run_in_background === true) {
    return { kind: "bash", label: strOf(input.command) || "background shell" };
  }
  return null;
}

// Background bash/monitor replies "...running in background with ID: <id>...".
export function parseShellId(result: string): string | null {
  const m = /with ID:\s*(\S+)/i.exec(result);
  return m ? m[1].replace(/[.,]+$/, "") : null;
}

export class BackgroundActivityService {
  private byWorker = new Map<string, BackgroundActivityEntry[]>();
  private clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  onToolRunning(
    workerId: string,
    toolName: string,
    toolUseId: string | null,
    input: Record<string, unknown>,
  ): void {
    const cls = classifyBackgroundTool(toolName, input);
    if (!cls) return;
    const list = this.byWorker.get(workerId) ?? [];
    // De-dup on toolUseId so a re-emitted start can never double-count.
    if (toolUseId && list.some((e) => e.toolUseId === toolUseId)) return;
    list.push({ kind: cls.kind, toolUseId, label: cls.label, startedAt: this.clock.now(), shellId: null });
    this.byWorker.set(workerId, list);
  }

  onToolDone(workerId: string, toolName: string, toolUseId: string | null, result: string): void {
    // The done of the START call carries the shell id — record it for display.
    // NOT a close: the process outlives this call (see file header). Terminal
    // tools (KillShell/BashOutput) are out of scope for this MVP.
    if (!toolUseId) return;
    const entry = this.byWorker.get(workerId)?.find((e) => e.toolUseId === toolUseId);
    if (!entry || entry.shellId) return;
    const id = parseShellId(result);
    if (id) entry.shellId = id;
  }

  forWorker(workerId: string): BackgroundActivityEntry[] {
    return this.byWorker.get(workerId) ?? [];
  }

  clearWorker(workerId: string): void {
    this.byWorker.delete(workerId);
  }
}
