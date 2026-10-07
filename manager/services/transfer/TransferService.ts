// This Mac's file-transfer engine (the Transfer tab, a focused agent's
// send_to_machine). Owns the list: queue, one running transfer per paired Mac,
// pause / resume / cancel, conflict decisions, persistence, the live
// `transfer:change` feed and the banner when one finishes. The byte moving is
// core's runTransfer over two endpoints — this Mac's disk and a host's.

import { resolve } from "node:path";

import type {
  AgentTransferRequest, MachineRef, TransferConflict, TransferDecision, TransferDestinationResponse,
  TransferOrigin, TransferRecord, TransferRoute, TransferStartRequest,
} from "../../../contracts/src/transfer.ts";
import type { HostView } from "../../../contracts/src/peer.ts";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { TransferEndpoint } from "../../../core/src/ports/TransferEndpoint.ts";
import type { TransferRepo } from "../../../core/src/ports/TransferRepo.ts";
import { NotFoundError, ValidationError } from "../../../core/src/errors/index.ts";
import { TransferError, baseName, commonParent, formatBytes, isTransient, joinPath, matchMachine } from "../../../core/src/domain/transfer.ts";
import { runTransfer } from "../../../core/src/use-cases/RunTransfer.ts";

const DEFAULT_FOLDER = "Downloads/Eos";
const LIST_LIMIT = 100;
// The feed and the db follow progress at this pace; state changes go at once.
const PUBLISH_EVERY_MS = 250;
const SAVE_EVERY_MS = 2_000;

const ACTIVE = new Set<TransferRecord["status"]>(["queued", "scanning", "copying", "conflict", "committing"]);
const FINISHED = new Set<TransferRecord["status"]>(["done", "failed", "cancelled"]);
const RESUMABLE = new Set<TransferRecord["status"]>(["paused", "interrupted", "failed"]);

// Why a run's signal was aborted.
const PAUSE = Symbol("pause");
const CANCEL = Symbol("cancel");
const SHUTDOWN = Symbol("shutdown");

export interface NotificationFire {
  title: string;
  body: string;
  workerId: string;
  route?: string;
  ts: number;
}

export interface TransferServiceDeps {
  readonly repo: TransferRepo;
  readonly local: TransferEndpoint;
  readonly peer: (hostId: string) => TransferEndpoint;
  readonly hosts: { list(): HostView[]; get(id: string): HostView | null };
  readonly localName: () => string;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly log: Logger;
  readonly newId: () => string;
  readonly notify: (n: NotificationFire) => void;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class TransferService {
  private readonly deps: TransferServiceDeps;
  // Every transfer that's running or waiting to, as it stands right now.
  private readonly live = new Map<string, TransferRecord>();
  private readonly runs = new Map<string, AbortController>();
  private readonly waiting = new Map<string, () => void>();
  private readonly lastPublish = new Map<string, number>();
  private readonly lastSave = new Map<string, number>();

  constructor(deps: TransferServiceDeps) {
    this.deps = deps;
  }

  // A transfer that was running when the daemon stopped can be resumed, not continued.
  boot(): void {
    for (const t of this.deps.repo.list(LIST_LIMIT)) {
      if (ACTIVE.has(t.status)) this.deps.repo.save({ ...t, status: "interrupted", rate: 0 });
    }
  }

  stop(): void {
    for (const ctl of this.runs.values()) ctl.abort(SHUTDOWN);
  }

  list(): TransferRecord[] {
    return this.deps.repo.list(LIST_LIMIT).map((t) => this.live.get(t.id) ?? t);
  }

  get(id: string): TransferRecord {
    const t = this.live.get(id) ?? this.deps.repo.get(id);
    if (!t) throw new NotFoundError("transfer", id);
    return t;
  }

  // Where the picked items land when the user doesn't choose: the same project
  // on the other Mac (by git remote, keeping the sub-folder), else ~/Downloads/Eos.
  async destination(from: MachineRef, to: MachineRef, paths: readonly string[]): Promise<TransferDestinationResponse> {
    const source = this.endpoint(from);
    const dest = this.endpoint(to);
    const key = await source.projectKey(commonParent(paths)).catch(() => null);
    const found = key ? await dest.locate(key).catch(() => null) : null;
    if (found) return { destDir: found, reason: "project" };
    return { destDir: joinPath(await dest.home(), DEFAULT_FOLDER), reason: "default" };
  }

  async start(req: TransferStartRequest, origin: TransferOrigin = { kind: "user" }): Promise<TransferRecord> {
    this.checkPair(req.from, req.to);
    const dest = req.destDir
      ? { destDir: req.destDir, reason: "chosen" as const }
      : await this.destination(req.from, req.to, req.paths);
    const now = this.deps.clock.now();
    const t: TransferRecord = {
      id: this.deps.newId(), from: req.from, to: req.to, origin, sources: [...req.paths],
      destDir: dest.destDir, destReason: dest.reason, status: "queued", error: null,
      roots: req.paths.map((p) => ({ name: baseName(p), type: "file" as const, size: 0, mtimeMs: 0 })),
      fileCount: 0, totalBytes: 0, doneBytes: 0, rate: 0, route: null,
      conflicts: [], decisions: {}, placed: [],
      createdAt: now, startedAt: null, finishedAt: null,
    };
    this.live.set(t.id, t);
    this.commit(t);
    this.schedule();
    return t;
  }

  // A focused agent's send: this Mac → the named Mac's ~/Downloads/Eos, never
  // replacing anything there. Where bytes land is never the agent's choice.
  async sendForAgent(agent: { id: string; name: string; cwd: string | null }, req: AgentTransferRequest): Promise<TransferRecord> {
    const hosts = this.deps.hosts.list();
    const label = (h: HostView): string => h.alias || h.name;
    const listing = hosts.length
      ? `Paired Macs: ${hosts.map((h) => `${label(h)} (${h.link.state === "live" ? "online" : h.link.state})`).join(", ")}.`
      : "This Mac isn't paired with any other Mac.";
    const m = matchMachine(req.machine, hosts.map((h) => ({ id: h.id, names: [h.alias, h.name].filter((n): n is string => Boolean(n)) })));
    if (m.kind === "none") throw new ValidationError(`No paired Mac matches "${req.machine}". ${listing}`);
    if (m.kind === "many") throw new ValidationError(`"${req.machine}" could be ${m.ids.map((id) => label(hosts.find((h) => h.id === id)!)).join(" or ")} — name one. ${listing}`);
    const host = hosts.find((h) => h.id === m.id)!;
    if (["offline", "unauthorized", "incompatible"].includes(host.link.state)) {
      throw new ValidationError(`${label(host)} isn't reachable right now (${host.link.state}). ${listing}`);
    }
    const paths = req.paths.map((p) => (p.startsWith("/") ? p : agent.cwd ? resolve(agent.cwd, p) : p));
    const bad = paths.find((p) => !p.startsWith("/"));
    if (bad) throw new ValidationError(`"${bad}" isn't an absolute path, and this session has no folder to resolve it against`);
    const destDir = joinPath(await this.endpoint(host.id).home(), DEFAULT_FOLDER);
    return this.start({ from: "local", to: host.id, paths, destDir }, { kind: "agent", agentId: agent.id, agentName: agent.name });
  }

  pause(id: string): TransferRecord {
    const t = this.get(id);
    if (t.status === "queued") return this.update(id, { status: "paused" });
    this.runs.get(id)?.abort(PAUSE);
    return this.get(id);
  }

  resume(id: string): TransferRecord {
    const t = this.get(id);
    if (!RESUMABLE.has(t.status)) return t;
    this.live.set(id, t);
    const next = this.update(id, { status: "queued", error: null, finishedAt: null });
    this.schedule();
    return next;
  }

  cancel(id: string): TransferRecord {
    const t = this.get(id);
    const run = this.runs.get(id);
    if (run) {
      run.abort(CANCEL);
      return this.get(id);
    }
    if (FINISHED.has(t.status) && t.status !== "failed") return t;
    void this.endpoint(t.to).abort({ id, destDir: t.destDir }).catch(() => {});
    return this.finish(id, { status: "cancelled" });
  }

  decide(id: string, decisions: Record<string, TransferDecision>): TransferRecord {
    const t = this.get(id);
    const names = new Set(t.conflicts.map((c) => c.name));
    const picked = Object.fromEntries(Object.entries(decisions).filter(([name]) => names.has(name)));
    const next = this.update(id, { decisions: { ...t.decisions, ...picked } });
    if (t.conflicts.every((c) => next.decisions[c.name])) this.waiting.get(id)?.();
    return next;
  }

  clearFinished(): string[] {
    const ids = this.list().filter((t) => FINISHED.has(t.status)).map((t) => t.id);
    if (!ids.length) return ids;
    this.deps.repo.remove(ids);
    for (const id of ids) this.live.delete(id);
    this.deps.bus.publish("transfer:change", { removed: ids });
    return ids;
  }

  private endpoint(m: MachineRef): TransferEndpoint {
    return m === "local" ? this.deps.local : this.deps.peer(m);
  }

  private label(m: MachineRef): string {
    if (m === "local") return this.deps.localName();
    const h = this.deps.hosts.get(m);
    return h ? h.alias || h.name : "the other Mac";
  }

  private routeOf(t: TransferRecord): TransferRoute | null {
    const remote = t.from === "local" ? t.to : t.from;
    if (remote === "local") return "local";
    return this.deps.hosts.get(remote)?.link.route ?? null;
  }

  private checkPair(from: MachineRef, to: MachineRef): void {
    if (from === to) throw new ValidationError("pick two different computers");
    // v1: this Mac is one side — host ⇄ host would relay every byte through it.
    if (from !== "local" && to !== "local") throw new ValidationError("one side of a transfer must be this Mac");
    for (const m of [from, to]) {
      if (m !== "local" && !this.deps.hosts.get(m)) throw new ValidationError("that computer isn't paired with this Mac");
    }
  }

  // One running transfer per paired Mac; the rest wait their turn.
  private schedule(): void {
    const busy = new Set([...this.runs.keys()].map((id) => this.remoteOf(this.live.get(id))));
    const queued = [...this.live.values()].filter((t) => t.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
    for (const t of queued) {
      const remote = this.remoteOf(t);
      if (busy.has(remote)) continue;
      busy.add(remote);
      void this.execute(t.id);
    }
  }

  private remoteOf(t: TransferRecord | undefined): string {
    return !t ? "" : t.from === "local" ? t.to : t.from;
  }

  private async execute(id: string): Promise<void> {
    const ctl = new AbortController();
    this.runs.set(id, ctl);
    const t0 = this.update(id, { status: "scanning", startedAt: this.get(id).startedAt ?? this.deps.clock.now(), rate: 0, route: this.routeOf(this.get(id)) });
    const dest = this.endpoint(t0.to);
    try {
      const result = await runTransfer({
        source: this.endpoint(t0.from),
        dest,
        clock: this.deps.clock,
        sleep: this.deps.sleep ?? sleep,
        route: () => this.routeOf(this.get(id)),
        events: {
          scanned: (m) => { this.update(id, { roots: m.roots, fileCount: m.fileCount, totalBytes: m.totalBytes, status: "copying" }); },
          prepared: ({ conflicts, doneBytes }) => {
            const t = this.get(id);
            // An agent never replaces anything: whatever is there stays, side by side.
            const preset = t.origin.kind === "agent" ? Object.fromEntries(conflicts.map((c) => [c.name, "keep" as const])) : {};
            const kept = Object.fromEntries(Object.entries(t.decisions).filter(([n]) => conflicts.some((c) => c.name === n)));
            this.update(id, { conflicts, doneBytes, decisions: { ...preset, ...kept } });
          },
          progress: (doneBytes, rate) => { this.update(id, { doneBytes, rate, route: this.routeOf(this.get(id)) }, true); },
          decisions: (conflicts) => this.decisionsFor(id, conflicts),
          copied: () => {
            const t = this.get(id);
            if (t.conflicts.some((c) => !t.decisions[c.name])) this.update(id, { status: "conflict", rate: 0 });
          },
          committing: () => { this.update(id, { status: "committing", rate: 0 }); },
        },
      }, { id, sources: t0.sources, destDir: t0.destDir }, ctl.signal);
      const t = this.finish(id, { status: "done", placed: result.placed, doneBytes: this.get(id).totalBytes });
      this.banner(t, `Copied to ${this.label(t.to)}`, `${names(t)} · ${formatBytes(t.totalBytes)}`);
    } catch (e) {
      const why = ctl.signal.aborted ? ctl.signal.reason : null;
      if (why === PAUSE) this.update(id, { status: "paused", rate: 0 });
      else if (why === SHUTDOWN) this.update(id, { status: "interrupted", rate: 0 });
      else if (why === CANCEL) {
        void dest.abort({ id, destDir: t0.destDir }).catch(() => {});
        this.finish(id, { status: "cancelled" });
      } else {
        const error = { code: e instanceof TransferError ? e.code : "failed", message: e instanceof Error ? e.message : String(e) };
        if (isTransient(e)) {
          const t = this.update(id, { status: "interrupted", rate: 0, error });
          this.banner(t, "Transfer paused", `${this.label(this.remoteOf(t))} went out of reach — resume it from the Transfer tab.`);
        } else {
          // The staging goes; a retry starts over from a fresh scan.
          void dest.abort({ id, destDir: t0.destDir }).catch(() => {});
          const t = this.finish(id, { status: "failed", error });
          this.banner(t, "Transfer failed", `${names(t)}: ${error.message}`);
          this.deps.log.warn("transfer failed", { id, code: error.code, error: error.message });
        }
      }
    } finally {
      this.runs.delete(id);
      this.waiting.delete(id);
      const t = this.live.get(id);
      if (t && !ACTIVE.has(t.status)) this.live.delete(id);
      this.schedule();
    }
  }

  private decisionsFor(id: string, conflicts: TransferConflict[]): Promise<Record<string, TransferDecision>> {
    return new Promise((done) => {
      const check = (): boolean => {
        const d = this.get(id).decisions;
        if (!conflicts.every((c) => d[c.name])) return false;
        this.waiting.delete(id);
        done(d);
        return true;
      };
      if (!check()) this.waiting.set(id, () => { check(); });
    });
  }

  private finish(id: string, patch: Partial<TransferRecord>): TransferRecord {
    return this.update(id, { ...patch, rate: 0, finishedAt: this.deps.clock.now() });
  }

  // Progress (`quiet`) is published and saved at a pace; anything else at once.
  private update(id: string, patch: Partial<TransferRecord>, quiet = false): TransferRecord {
    const next = { ...this.get(id), ...patch };
    if (this.live.has(id) || ACTIVE.has(next.status)) this.live.set(id, next);
    const now = this.deps.clock.now();
    if (!quiet || now - (this.lastSave.get(id) ?? 0) >= SAVE_EVERY_MS) {
      this.deps.repo.save(next);
      this.lastSave.set(id, now);
    }
    if (!quiet || now - (this.lastPublish.get(id) ?? 0) >= PUBLISH_EVERY_MS) {
      this.deps.bus.publish("transfer:change", { transfer: next });
      this.lastPublish.set(id, now);
    }
    return next;
  }

  private commit(t: TransferRecord): void {
    this.deps.repo.save(t);
    this.deps.bus.publish("transfer:change", { transfer: t });
  }

  private banner(t: TransferRecord, title: string, body: string): void {
    this.deps.notify({ title, body, workerId: t.origin.agentId ?? "", route: "transfers", ts: this.deps.clock.now() });
  }
}

function names(t: TransferRecord): string {
  const all = t.roots.map((r) => r.name);
  return all.length <= 2 ? all.join(", ") : `${all[0]} and ${all.length - 1} more`;
}


function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    if (signal.aborted) { fail(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); done(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); fail(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
