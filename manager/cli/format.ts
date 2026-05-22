// Shared CLI formatters. Pulled out of cli.ts so command modules don't each
// re-implement the same padding/truncation logic.

export function fmtTs(ts: number | null): string {
  if (!ts) return "-";
  return new Date(ts).toISOString().slice(11, 19);
}

export function fmtDur(start: number, end: number | null): string {
  if (!start) return "-";
  const ms = (end ?? Date.now()) - start;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

export function short(id: string): string {
  return id.length > 10 ? id.slice(0, 10) : id;
}

export interface WorkerRowMin {
  id: string;
  state: string;
  cwd: string | null;
  worktree_from?: string | null;
  branch: string | null;
  prompt: string;
  name: string | null;
  pid: number | null;
  port: number;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
}

export function exitCodeLabel(code: number): string {
  if (code === 129) return "completed";
  if (code === 143) return "killed";
  if (code === 0) return "exit=0";
  return `exit=${code}`;
}
