// Pure rules of a file transfer between Macs: which paths are safe, what a
// "Keep both" copy is called, how big a chunk is, how fast it's going, and which
// paired Mac a name means. The engine (use-cases/RunTransfer) and both endpoint
// adapters share them.

import type {
  ManifestItem, TransferConflict, TransferErrorCode, TransferExisting, TransferRoot, TransferRoute,
} from "../../../contracts/src/transfer.ts";

export class TransferError extends Error {
  readonly code: TransferErrorCode;
  // offset-mismatch: what the receiving side already holds.
  readonly have?: number;

  constructor(code: TransferErrorCode, message: string, have?: number) {
    super(message);
    this.name = "TransferError";
    this.code = code;
    this.have = have;
  }
}

// Worth waiting out: the link dropped, the other Mac is waking up.
export function isTransient(e: unknown): boolean {
  return e instanceof TransferError && e.code === "unreachable";
}

// A manifest path's segments, or null when it could land outside its folder.
export function relSegments(rel: string): string[] | null {
  if (!rel || rel.startsWith("/") || rel.includes("\0")) return null;
  const parts = rel.split("/");
  return parts.some((p) => p === "" || p === "." || p === "..") ? null : parts;
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

export function joinPath(dir: string, rel: string): string {
  return dir.endsWith("/") ? dir + rel : `${dir}/${rel}`;
}

// The folder the picked items share — it decides "the same project" on the other Mac.
export function commonParent(paths: readonly string[]): string {
  const dirs = paths.map((p) => parentDir(p).split("/"));
  let common = dirs[0] ?? [""];
  for (const d of dirs.slice(1)) {
    let i = 0;
    while (i < common.length && i < d.length && common[i] === d[i]) i++;
    common = common.slice(0, i);
  }
  return common.join("/") || "/";
}

// Finder's Keep Both: "Report.pdf" → "Report 2.pdf", "NeonDrift.app" → "NeonDrift 2.app".
export function keepBothName(name: string, taken: (candidate: string) => boolean): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

// The selected items (rel without "/") with the bytes under each.
export function manifestRoots(items: readonly ManifestItem[]): TransferRoot[] {
  const roots = new Map<string, TransferRoot>();
  for (const it of items) {
    if (!it.rel.includes("/")) roots.set(it.rel, { name: it.rel, type: it.type, size: 0, mtimeMs: it.mtimeMs });
  }
  for (const it of items) {
    if (it.type !== "file") continue;
    const root = roots.get(it.rel.split("/", 1)[0]!);
    if (root) root.size += it.size;
  }
  return [...roots.values()];
}

export function conflictsOf(roots: readonly TransferRoot[], existing: readonly TransferExisting[]): TransferConflict[] {
  const byName = new Map(roots.map((r) => [r.name, r]));
  return existing.flatMap((e) => {
    const r = byName.get(e.name);
    return r ? [{ name: e.name, existing: { type: e.type, size: e.size, mtimeMs: e.mtimeMs }, incoming: { type: r.type, size: r.size, mtimeMs: r.mtimeMs } }] : [];
  });
}

const KiB = 1024;
const MiB = 1024 * KiB;
export const MIN_CHUNK = 256 * KiB;
const CHUNKS: Record<TransferRoute, { first: number; max: number }> = {
  local: { first: 16 * MiB, max: 16 * MiB },
  direct: { first: 4 * MiB, max: 16 * MiB },
  relay: { first: MiB, max: 4 * MiB },
  reverse: { first: MiB, max: 4 * MiB },
};

// About a second of what the link is doing, so every request stays short: a long
// upload would hit the servers' request timeout, and a deep queue on a slow relay
// would starve the link's liveness ping.
export function chunkLength(route: TransferRoute | null, rate: number): number {
  const c = CHUNKS[route ?? "relay"];
  if (rate <= 0) return c.first;
  return Math.max(MIN_CHUNK, Math.min(c.max, Math.round(rate)));
}

// Files in flight at once — fewer where every byte crosses the relay.
export function fileConcurrency(route: TransferRoute | null): number {
  return route === "local" || route === "direct" ? 4 : 2;
}

// Bytes per second, smoothed over half-second windows.
export class RateMeter {
  private readonly now: () => number;
  private windowStart: number;
  private bytes = 0;
  private value = 0;

  constructor(now: () => number) {
    this.now = now;
    this.windowStart = now();
  }

  add(n: number): void {
    this.bytes += n;
    this.tick();
  }

  rate(): number {
    this.tick();
    return this.value;
  }

  private tick(): void {
    const t = this.now();
    const dt = t - this.windowStart;
    if (dt < 500) return;
    const instant = (this.bytes * 1000) / dt;
    this.value = this.value === 0 ? instant : this.value * 0.6 + instant * 0.4;
    this.bytes = 0;
    this.windowStart = t;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export interface MachineName {
  id: string;
  names: readonly string[];
}

export type MachineMatch = { kind: "one"; id: string } | { kind: "none" } | { kind: "many"; ids: string[] };

// "macbook air", "Air", "the MacBook Air" → one paired Mac. Exact name first,
// then a unique word-prefix / substring match; never a guess between two.
export function matchMachine(query: string, machines: readonly MachineName[]): MachineMatch {
  const norm = (s: string): string => s.toLowerCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();
  const q = norm(query).replace(/^(the|my) /, "");
  if (!q) return { kind: "none" };
  const pick = (test: (name: string) => boolean): string[] =>
    [...new Set(machines.filter((m) => m.names.some((n) => test(norm(n)))).map((m) => m.id))];
  for (const test of [(n: string) => n === q, (n: string) => n.startsWith(q), (n: string) => n.includes(q)]) {
    const ids = pick(test);
    if (ids.length === 1) return { kind: "one", id: ids[0]! };
    if (ids.length > 1) return { kind: "many", ids };
  }
  return { kind: "none" };
}
