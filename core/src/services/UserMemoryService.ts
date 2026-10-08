// UserMemoryService — the one write path for the user's memories. Callers depend on
// the narrow face they need:
//   - UserMemoryReader         prompt assembly + search (agents and the UI)
//   - UserMemorySuggestionSink any producer proposing a memory (agents, dreams) —
//                              dedupe, declined ideas, cap and events live here
//                              once, for all of them
//   - UserMemoryEditor         the user (ui-token routes): keep, edit, delete
//   - UserMemorySyncTarget     sync: a memory exactly as another Mac has it
// Dismissing keeps a `dismissed` tombstone so the same idea is never suggested
// again. Every change publishes `user-memory:change`.

import { ConflictError, LimitExceededError, NotFoundError, ValidationError } from "../errors/index.ts";
import type { Clock } from "../ports/Clock.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { UserMemoryStore } from "../ports/UserMemoryStore.ts";
import {
  findDuplicateMemory, findDuplicateProposal, normalizeMemoryText, searchMemories,
} from "../domain/user-memory.ts";
import type {
  UserMemory, UserMemoryCategory, UserMemoryChangeEvent, UserMemoryDomain, UserMemoryProposal, UserMemoryScope,
  UserMemorySource, UserMemoryTier,
} from "../../../contracts/src/profile.ts";

export const DEFAULT_PENDING_PER_PRODUCER = 5;
// Dream proposals waiting for review, all dreams together (every Mac's): a morning
// review stays short, and an unreviewed one holds the next dream's back.
export const DREAM_PENDING_CAP = 4;

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
  readonly domain?: UserMemoryDomain;
  readonly scope: UserMemoryScope;
  readonly tier: UserMemoryTier;
}

export interface UserMemoryPatch {
  readonly text?: string;
  readonly category?: UserMemoryCategory;
  readonly domain?: UserMemoryDomain;
  readonly scope?: UserMemoryScope;
  readonly tier?: UserMemoryTier;
}

// A producer's suggestion; `proposal` = what keeping it changes (absent = a new memory).
export interface UserMemorySuggestion extends Omit<UserMemoryInput, "tier"> {
  readonly proposal?: UserMemoryProposal;
}

export interface UserMemorySuggestResult {
  readonly memory: UserMemory;
  readonly duplicate: boolean;
  // The match is one the user dismissed — the producer shouldn't try again.
  readonly declined: boolean;
}

export interface UserMemoryReader {
  list(): readonly UserMemory[];
  search(query: string, project: string | null, limit: number): UserMemory[];
}

export interface UserMemorySuggestionSink {
  suggest(input: UserMemorySuggestion, source: UserMemorySource): UserMemorySuggestResult;
}

export interface UserMemoryEditor {
  create(input: UserMemoryInput): UserMemory;
  update(id: string, patch: UserMemoryPatch, baseRev?: number): UserMemory;
  remove(id: string): void;
  // The memory the user ends up with (null when the proposal retired one).
  approve(id: string): UserMemory | null;
  dismiss(id: string): void;
  approveAll(): (UserMemory | null)[];
}

export interface UserMemorySyncTarget {
  list(): readonly UserMemory[];
  applySynced(memory: Omit<UserMemory, "rev">): UserMemory;
  removeSynced(id: string): void;
}

export interface UserMemoryServiceDeps {
  readonly store: UserMemoryStore;
  readonly clock: Clock;
  readonly bus: Pick<EventBus, "publish">;
  readonly newId: () => string;
  readonly maxPendingPerProducer?: number;
}

export class UserMemoryService implements UserMemoryReader, UserMemorySuggestionSink, UserMemoryEditor, UserMemorySyncTarget {
  private readonly deps: UserMemoryServiceDeps;

  constructor(deps: UserMemoryServiceDeps) {
    this.deps = deps;
  }

  // Every memory, tombstones included — readers filter by status.
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

  suggest(input: UserMemorySuggestion, source: UserMemorySource): UserMemorySuggestResult {
    const text = normalizeMemoryText(input.text);
    const all = this.deps.store.list();
    const p = input.proposal;
    if (p && p.kind !== "new") this.requireKept(p.targets);
    const dup = p && p.kind !== "new" ? findDuplicateProposal(text, p, all) : findDuplicateMemory(text, input.scope, all);
    if (dup) return { memory: dup, duplicate: true, declined: dup.status === "dismissed" };
    const cap = source.kind === "dream" ? DREAM_PENDING_CAP : (this.deps.maxPendingPerProducer ?? DEFAULT_PENDING_PER_PRODUCER);
    const key = producerKey(source);
    if (all.filter((m) => m.status === "suggested" && producerKey(m.source) === key).length >= cap) {
      throw new LimitExceededError(`${cap} suggestions are already waiting for the user's review`);
    }
    const memory = this.insert({ text, category: input.category, domain: input.domain, scope: input.scope, tier: "always" }, "suggested", source, p);
    return { memory, duplicate: false, declined: false };
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
      ...withDomain(patch.domain ?? cur.domain),
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

  approve(id: string): UserMemory | null {
    const cur = this.get(id);
    if (cur.status === "active") return cur;
    if (cur.status === "dismissed") throw new ValidationError(`memory ${id} was dismissed`);
    const p = cur.proposal;
    if (!p || p.kind === "new") return this.commit({ ...withoutProposal(cur), status: "active" }, "approved", "user");
    const targets = this.requireKept(p.targets);
    switch (p.kind) {
      case "update":
        this.consume(cur);
        return this.commit({ ...targets[0]!, text: cur.text, ...withDomain(cur.domain ?? targets[0]!.domain) }, "updated", "user");
      case "promote":
        this.consume(cur);
        return this.commit({ ...targets[0]!, scope: { kind: "global" } }, "updated", "user");
      case "retire":
        this.consume(cur);
        this.drop(targets[0]!);
        return null;
      case "merge":
        for (const t of targets) this.drop(t);
        return this.commit({ ...withoutProposal(cur), status: "active" }, "approved", "user");
    }
  }

  dismiss(id: string): void {
    const cur = this.get(id);
    if (cur.status !== "suggested") throw new ValidationError(`memory ${id} is not waiting for review`);
    this.commit({ ...cur, status: "dismissed" }, "dismissed", "user");
  }

  // Keeps what still applies — a proposal whose target an earlier one removed is left.
  approveAll(): (UserMemory | null)[] {
    const out: (UserMemory | null)[] = [];
    for (const m of this.deps.store.list().filter((x) => x.status === "suggested")) {
      try {
        out.push(this.approve(m.id));
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    }
    return out;
  }

  // Stored as given (timestamps included); only rev is this Mac's own.
  applySynced(memory: Omit<UserMemory, "rev">): UserMemory {
    const cur = this.deps.store.get(memory.id);
    const saved: UserMemory = { ...memory, rev: cur ? cur.rev + 1 : 0 };
    this.deps.store.put(saved);
    this.emit(saved, cur ? "updated" : "created", "sync");
    return saved;
  }

  removeSynced(id: string): void {
    const cur = this.deps.store.get(id);
    if (!cur) return;
    this.deps.store.remove(id);
    this.emit(cur, "deleted", "sync");
  }

  private requireKept(ids: readonly string[]): UserMemory[] {
    return ids.map((id) => {
      const t = this.deps.store.get(id);
      if (!t || t.status !== "active") throw new ConflictError(`the memory this changes is gone (${id})`);
      return t;
    });
  }

  private insert(
    input: UserMemoryInput, status: UserMemory["status"], source: UserMemorySource, proposal?: UserMemoryProposal,
  ): UserMemory {
    const now = this.deps.clock.now();
    const { domain, ...rest } = input;
    const memory: UserMemory = {
      id: this.deps.newId(), ...rest, ...withDomain(domain), status, source, ...(proposal ? { proposal } : {}), rev: 0, createdAt: now, updatedAt: now,
    };
    this.deps.store.put(memory);
    this.emit(memory, "created", source.kind === "agent" ? "agent" : source.kind === "dream" ? "dream" : "user");
    return memory;
  }

  private commit(next: UserMemory, action: UserMemoryChangeEvent["action"], by: UserMemoryChangeEvent["by"]): UserMemory {
    const saved: UserMemory = { ...next, rev: next.rev + 1, updatedAt: this.deps.clock.now() };
    this.deps.store.put(saved);
    this.emit(saved, action, by);
    return saved;
  }

  // A kept proposal is spent once applied to its target.
  private consume(suggestion: UserMemory): void {
    this.deps.store.remove(suggestion.id);
    this.emit(suggestion, "approved", "user");
  }

  private drop(memory: UserMemory): void {
    this.deps.store.remove(memory.id);
    this.emit(memory, "deleted", "user");
  }

  private emit(m: UserMemory, action: UserMemoryChangeEvent["action"], by: UserMemoryChangeEvent["by"]): void {
    const evt: UserMemoryChangeEvent = { id: m.id, action, status: m.status, by };
    this.deps.bus.publish("user-memory:change", evt);
  }
}

// An absent domain stays absent (no `domain: undefined` key in the stored record).
function withDomain(domain: UserMemoryDomain | undefined): { domain?: UserMemoryDomain } {
  return domain ? { domain } : {};
}

function withoutProposal(m: UserMemory): UserMemory {
  const copy = { ...m };
  delete copy.proposal;
  return copy;
}

// One pending budget per producer: an agent can't crowd out the others; dreams
// share one.
function producerKey(source: UserMemorySource): string {
  if (source.kind === "agent") return `agent:${source.agentId}`;
  if (source.kind === "import") return `import:${source.from}`;
  if (source.kind === "dream") return "dream";
  return "user";
}
