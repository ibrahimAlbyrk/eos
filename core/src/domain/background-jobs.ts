// Pure rules of the background-jobs registry (manager/services/BackgroundJobService):
// how each source's state reads as a job row. No I/O.

import type { BackgroundJob, BackgroundJobKind, BackgroundJobStatus } from "../../../contracts/src/background-job.ts";
import type { WorkflowRunSnapshot } from "../../../contracts/src/canonical.ts";
import type { TransferRecord } from "../../../contracts/src/transfer.ts";

export const jobIdOf = (kind: BackgroundJobKind, workerId: string | null, ref: string): string =>
  `${kind}:${workerId ?? "eos"}:${ref}`;

export function firstLine(text: string | null | undefined, max = 160): string | null {
  const line = text?.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")} ${units[i]}`;
}

export function agentJobTitle(agentType: string | undefined, description: string | undefined): string {
  if (agentType && description) return `${agentType} · ${description}`;
  return description ?? agentType ?? "Subagent";
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function agentProgressDetail(lastTool: string | null, toolUses: number | null): string | null {
  const parts = [lastTool, toolUses ? plural(toolUses, "tool use") : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

// "Verify 2/3 · 6 agents", agents done of all as the bar.
export function workflowProgressOf(snapshot: WorkflowRunSnapshot): Pick<BackgroundJob, "detail" | "progress"> {
  const { phases, agents } = snapshot;
  const current = Math.max(0, ...agents.filter((a) => a.state === "running").map((a) => a.phaseIndex ?? 0));
  const phase = phases.find((p) => p.index === current);
  const parts = [
    phase ? `${phase.title} ${phase.index}/${phases.length}` : null,
    agents.length ? plural(agents.length, "agent") : null,
  ].filter(Boolean);
  const done = agents.filter((a) => a.state === "done" || a.state === "error" || a.state === "cancelled").length;
  return {
    detail: parts.length ? parts.join(" · ") : null,
    progress: agents.length ? { done, total: agents.length } : null,
  };
}

const TRANSFER_STATUS: Record<TransferRecord["status"], BackgroundJobStatus> = {
  queued: "running", scanning: "running", copying: "running", conflict: "running", committing: "running",
  paused: "running", interrupted: "running", done: "completed", failed: "failed", cancelled: "stopped",
};

const TRANSFER_WAITING: Partial<Record<TransferRecord["status"], string>> = {
  queued: "Queued", scanning: "Scanning files", conflict: "Needs a decision", paused: "Paused",
  interrupted: "Interrupted — will resume", committing: "Placing files",
};

const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

export function transferJobFields(t: TransferRecord, machineName: (ref: string) => string): Pick<BackgroundJob, "status" | "title" | "detail" | "progress"> {
  const what = t.sources.length ? `${baseName(t.sources[0])}${t.sources.length > 1 ? ` +${t.sources.length - 1}` : ""}` : "Files";
  const status = TRANSFER_STATUS[t.status];
  const moved = t.totalBytes ? `${formatBytes(t.doneBytes)} of ${formatBytes(t.totalBytes)}` : null;
  const detail = t.status === "failed" ? t.error?.message ?? "Failed"
    : TRANSFER_WAITING[t.status]
    ?? [moved, t.status === "copying" && t.rate ? `${formatBytes(Math.round(t.rate))}/s` : null].filter(Boolean).join(" · ");
  return {
    status,
    title: `${what} → ${machineName(t.to)}`,
    detail: detail || null,
    progress: t.totalBytes && status === "running" ? { done: t.doneBytes, total: t.totalBytes } : null,
  };
}

// Running first (newest start first), then finished by end, newest first.
export function compareJobs(a: BackgroundJob, b: BackgroundJob): number {
  const ar = a.status === "running", br = b.status === "running";
  if (ar !== br) return ar ? -1 : 1;
  return ar ? b.startedAt - a.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0);
}
