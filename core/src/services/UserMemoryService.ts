// UserMemoryService — the one write path for the user's memories. Callers depend on
// the narrow face they need:
//   - UserMemoryReader         prompt assembly + search (agents and the UI)
//   - UserMemorySuggestionSink any producer proposing a memory (agents today; a
//                              background reviewer later) — dedupe, cap, events
//                              and notification live here once, for all of them
//   - UserMemoryEditor         the user (ui-token routes): keep, edit, delete
// Every change publishes `user-memory:change`.

import { ConflictError, LimitExceededError, NotFoundError, ValidationError } from "../errors/index.ts";
import type { Clock } from "../ports/Clock.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { UserMemoryStore } from "../ports/UserMemoryStore.ts";
import { findDuplicateMemory, normalizeMemoryText, searchMemories } from "../domain/user-memory.ts";
import type {
  UserMemory, UserMemoryCategory, UserMemoryChangeEvent, UserMemoryScope, UserMemorySource, UserMemoryTier,
} from "../../../contracts/src/profile.ts";

export const DEFAULT_PENDING_PER_PRODUCER = 5;

export class StaleMemoryError extends ConflictError {
  readonly memory: UserMemory;
  constructor(memory: UserMemory) {
    super(`memory ${memory.id} changed since the revision you edited (now rev ${memory.rev})`);
    this.memory = memory;
  }
}

export interface UserMemoryInput {
  readonly text: string;
  readonly category: UserMemoryCategory;
  readonly scope: UserMemoryScope;
  readonly tier: UserMemoryTier;
}

export interface UserMemoryPatch {
  readonly text?: string;
  readonly category?: UserMemoryCategory;
  readonly scope?: UserMemoryScope;
  readonly tier?: UserMemoryTier;
}

export interface UserMemoryReader {
  list(): readonly UserMemory[];
  search(query: string, project: string | null, limit: number): UserMemory[];
}

export interface UserMemorySuggestionSink {
  suggest(input: Omit<UserMemoryInput, "tier">, source: UserMemorySource): { memory: UserMemory; duplicate: boolean };
}

export interface UserMemoryEditor {
  create(input: UserMemoryInput): UserMemory;
  update(id: string, patch: UserMemoryPatch, baseRev?: number): UserMemory;
  remove(id: string): void;
  approve(id: string): UserMemory;
  dismiss(id: string): void;
  approveAll(): UserMemory[];
}

export interface UserMemoryServiceDeps {
  readonly store: UserMemoryStore;
  readonly clock: Clock;
  readonly bus: Pick<EventBus, "publish">;
  readonly newId: () => string;
  readonly maxPendingPerProducer?: number;
}

export class UserMemoryService implements UserMemoryReader, UserMemorySuggestionSink, UserMemoryEditor {
  private readonly deps: UserMemoryServiceDeps;

  constructor(deps: UserMemoryServiceDeps) {
    this.deps = deps;
  }

  list(): readonly UserMemory[] {
    return this.deps.store.list();
  }

  get(id: string): UserMemory {
    const m = this.deps.store.get(id);
    if (!m) throw new NotFoundError("memory", id);
    return m;
  }

  search(query: string, project: string | null, limit: number): UserMemory[] {
    return searchMemories(this.deps.store.list(), query, project, limit);
  }

  suggest(input: Omit<UserMemoryInput, "tier">, source: UserMemorySource): { memory: UserMemory; duplicate: boolean } {
    const text = normalizeMemoryText(input.text);
    const all = this.deps.store.list();
    const dup = findDuplicateMemory(text, input.scope, all);
    if (dup) return { memory: dup, duplicate: true };
    const cap = this.deps.maxPendingPerProducer ?? DEFAULT_PENDING_PER_PRODUCER;
    const key = producerKey(source);
    if (all.filter((m) => m.status === "suggested" && producerKey(m.source) === key).length >= cap) {
      throw new LimitExceededError(`${cap} suggestions are already waiting for the user's review`);
    }
    const memory = this.insert({ ...input, text, tier: "always" }, "suggested", source);
    return { memory, duplicate: false };
  }

  create(input: UserMemoryInput): UserMemory {
    return this.insert({ ...input, text: normalizeMemoryText(input.text) }, "active", { kind: "user" });
  }

  update(id: string, patch: UserMemoryPatch, baseRev?: number): UserMemory {
    const cur = this.get(id);
    if (baseRev !== undefined && baseRev !== cur.rev) throw new StaleMemoryError(cur);
    const next: UserMemory = {
      ...cur,
      text: patch.text !== undefined ? normalizeMemoryText(patch.text) : cur.text,
      category: patch.category ?? cur.category,
      scope: patch.scope ?? cur.scope,
      tier: patch.tier ?? cur.tier,
    };
    if (JSON.stringify(next) === JSON.stringify(cur)) return cur;
    return this.commit(next, "updated", "user");
  }

  remove(id: string): void {
    const cur = this.get(id);
    this.deps.store.remove(id);
    this.emit(cur, "deleted", "user");
  }

  approve(id: string): UserMemory {
    const cur = this.get(id);
    if (cur.status === "active") return cur;
    return this.commit({ ...cur, status: "active" }, "approved", "user");
  }

  dismiss(id: string): void {
    const cur = this.get(id);
    if (cur.status !== "suggested") throw new ValidationError(`memory ${id} is kept — delete it instead`);
    this.deps.store.remove(id);
    this.emit(cur, "dismissed", "user");
  }

  approveAll(): UserMemory[] {
    return this.deps.store.list().filter((m) => m.status === "suggested").map((m) => this.approve(m.id));
  }

  private insert(input: UserMemoryInput, status: UserMemory["status"], source: UserMemorySource): UserMemory {
    const now = this.deps.clock.now();
    const memory: UserMemory = {
      id: this.deps.newId(), ...input, status, source, rev: 0, createdAt: now, updatedAt: now,
    };
    this.deps.store.put(memory);
    this.emit(memory, "created", source.kind === "agent" ? "agent" : "user");
    return memory;
  }

  private commit(next: UserMemory, action: UserMemoryChangeEvent["action"], by: UserMemoryChangeEvent["by"]): UserMemory {
    const saved: UserMemory = { ...next, rev: next.rev + 1, updatedAt: this.deps.clock.now() };
    this.deps.store.put(saved);
    this.emit(saved, action, by);
    return saved;
  }

  private emit(m: UserMemory, action: UserMemoryChangeEvent["action"], by: UserMemoryChangeEvent["by"]): void {
    const evt: UserMemoryChangeEvent = { id: m.id, action, status: m.status, by };
    this.deps.bus.publish("user-memory:change", evt);
  }
}

// One pending-suggestion budget per producer: an agent can't crowd out the others.
function producerKey(source: UserMemorySource): string {
  if (source.kind === "agent") return `agent:${source.agentId}`;
  if (source.kind === "import") return `import:${source.from}`;
  return "user";
}
