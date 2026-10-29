// ArtifactCatalogService — every claude.ai Artifact of every Eos Claude sign-in,
// kept in memory. get() answers from memory and re-reads in the background any
// sign-in never read or read more than staleMs ago; refresh() re-reads now;
// invalidate() re-reads shortly after an agent published (a burst is one read).
// One read per sign-in at a time. A failed read keeps the sign-in's last list
// and says why on its account. Every change publishes the whole catalog.

import type { Clock } from "../ports/Clock.ts";
import type { ArtifactSource } from "../ports/ArtifactSource.ts";
import { mergeArtifacts } from "../domain/artifact-catalog.ts";
import type { ArtifactAccount, ArtifactCatalog, ArtifactSummary } from "../../../contracts/src/artifacts.ts";
import { errMsg } from "../../../contracts/src/util.ts";

export interface ArtifactLogin {
  readonly id: string;
  readonly label: string;
  readonly email?: string;
}

export interface ArtifactCatalogDeps {
  source: ArtifactSource;
  // The Claude sign-ins, read on every use: one signed out drops out of the catalog.
  logins: () => readonly ArtifactLogin[];
  clock: Clock;
  publish: (catalog: ArtifactCatalog) => void;
  staleMs?: number;
  debounceMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
}

interface LoginState {
  artifacts: ArtifactSummary[];
  refreshedAt?: number;
  // When the last read ended, failed or not — what staleness counts from, so a
  // failing sign-in is retried once per staleMs rather than on every get().
  checkedAt?: number;
  error?: string;
}

const MAX_ERROR_CHARS = 200;

const shortError = (e: unknown): string =>
  errMsg(e).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS) || "Couldn't read this account's artifacts.";

export class ArtifactCatalogService {
  private readonly deps: ArtifactCatalogDeps;
  private readonly staleMs: number;
  private readonly debounceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly state = new Map<string, LoginState>();
  private readonly inFlight = new Map<string, Promise<void>>();
  // Invalidated while a read was in flight: that read may have started before
  // the publish, so another follows it.
  private readonly again = new Set<string>();
  // What the scheduled invalidation re-reads; null = nothing scheduled.
  private pending: Set<string> | "all" | null = null;

  constructor(deps: ArtifactCatalogDeps) {
    this.deps = deps;
    this.staleMs = deps.staleMs ?? 60_000;
    this.debounceMs = deps.debounceMs ?? 1500;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  get(): ArtifactCatalog {
    const now = this.deps.clock.now();
    for (const l of this.deps.logins()) {
      const checkedAt = this.state.get(l.id)?.checkedAt;
      if (!this.inFlight.has(l.id) && (checkedAt === undefined || now - checkedAt >= this.staleMs)) void this.read(l.id);
    }
    return this.snapshot();
  }

  async refresh(loginId?: string): Promise<ArtifactCatalog> {
    await Promise.all(this.idsOf(loginId === undefined ? "all" : new Set([loginId])).map((id) => this.read(id)));
    return this.snapshot();
  }

  invalidate(loginId?: string): void {
    const scheduled = this.pending !== null;
    if (loginId === undefined) this.pending = "all";
    else if (this.pending !== "all") this.pending = new Set([...(this.pending ?? []), loginId]);
    if (!scheduled) this.setTimer(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    for (const id of this.idsOf(pending)) {
      if (this.inFlight.has(id)) this.again.add(id);
      else void this.read(id);
    }
  }

  private idsOf(which: Set<string> | "all"): string[] {
    const ids = this.deps.logins().map((l) => l.id);
    return which === "all" ? ids : ids.filter((id) => which.has(id));
  }

  private read(loginId: string): Promise<void> {
    const running = this.inFlight.get(loginId);
    if (running) return running;
    const flips = this.inFlight.size === 0;
    const run = this.start(loginId);
    if (flips) this.emit();
    return run;
  }

  private start(loginId: string): Promise<void> {
    // Deferred a tick so the read is in flight before the source runs at all.
    const run = Promise.resolve().then(() => this.load(loginId));
    this.inFlight.set(loginId, run);
    return run;
  }

  private async load(loginId: string): Promise<void> {
    let artifacts: ArtifactSummary[] | null = null;
    let error: string | undefined;
    try {
      artifacts = await this.deps.source.list(loginId);
    } catch (e) {
      error = shortError(e);
    }
    this.inFlight.delete(loginId);
    const known = this.deps.logins().some((l) => l.id === loginId);
    if (known) {
      const now = this.deps.clock.now();
      const prev = this.state.get(loginId);
      this.state.set(loginId, artifacts
        ? { artifacts, refreshedAt: now, checkedAt: now }
        : { artifacts: prev?.artifacts ?? [], refreshedAt: prev?.refreshedAt, checkedAt: now, error });
    }
    if (this.again.delete(loginId) && known) void this.start(loginId);
    this.emit();
  }

  private emit(): void {
    this.deps.publish(this.snapshot());
  }

  private snapshot(): ArtifactCatalog {
    const logins = this.deps.logins();
    const ids = new Set(logins.map((l) => l.id));
    for (const id of this.state.keys()) if (!ids.has(id)) this.state.delete(id);
    const accounts: ArtifactAccount[] = logins.map((l) => {
      const s = this.state.get(l.id);
      return {
        loginId: l.id,
        label: l.label,
        ...(l.email ? { email: l.email } : {}),
        count: s?.artifacts.length ?? 0,
        ...(s?.refreshedAt !== undefined ? { refreshedAt: new Date(s.refreshedAt).toISOString() } : {}),
        ...(s?.error ? { error: s.error } : {}),
      };
    });
    return {
      artifacts: mergeArtifacts(logins.map((l) => this.state.get(l.id)?.artifacts ?? [])),
      accounts,
      refreshing: this.inFlight.size > 0,
    };
  }
}
