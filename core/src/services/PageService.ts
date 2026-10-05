// PageService — the one write path for pages, shared by the UI routes and the
// agents' MCP tools. Every write bumps `rev` and publishes `pages:change`, so an
// open editor refetches. A full-body update carrying a stale baseRev is refused
// with the current page (StalePageError) instead of overwriting an edit the
// caller has not seen; targeted edits apply to the latest body.

import { ConflictError, NotFoundError } from "../errors/index.ts";
import type { Clock } from "../ports/Clock.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { PageStore } from "../ports/PageStore.ts";
import { applyPageEdit, pageExcerpt, pageTaskCounts } from "../domain/page.ts";
import type {
  Page, PageAuthor, PageChangeEvent, PageEditRequest, PageSummary,
} from "../../../contracts/src/http.ts";

export class StalePageError extends ConflictError {
  readonly page: Page;
  constructor(page: Page) {
    super(`page ${page.id} changed since the revision you edited (now rev ${page.rev})`);
    this.page = page;
  }
}

export interface PageServiceDeps {
  readonly store: PageStore;
  readonly clock: Clock;
  readonly bus: Pick<EventBus, "publish">;
  readonly newId: () => string;
}

export interface PageListFilter {
  // undefined = every page; a string or null = only pages of that project.
  readonly project?: string | null;
  readonly query?: string;
}

export interface PageCreateInput {
  readonly title: string;
  readonly body: string;
  readonly project: string | null;
  readonly agentId: string | null;
}

export function summarizePage(page: Page): PageSummary {
  const { body, ...meta } = page;
  return { ...meta, excerpt: pageExcerpt(body), tasks: pageTaskCounts(body) };
}

export class PageService {
  private readonly deps: PageServiceDeps;

  constructor(deps: PageServiceDeps) {
    this.deps = deps;
  }

  list(filter: PageListFilter = {}): PageSummary[] {
    const q = filter.query?.trim().toLowerCase();
    return this.deps.store.list()
      .filter((p) => filter.project === undefined || p.project === filter.project)
      .filter((p) => !q || p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(summarizePage);
  }

  get(id: string): Page {
    const page = this.deps.store.get(id);
    if (!page) throw new NotFoundError("page", id);
    return page;
  }

  create(input: PageCreateInput, by: PageAuthor): Page {
    const now = this.deps.clock.now();
    const page: Page = {
      id: this.deps.newId(),
      title: input.title.trim(),
      body: input.body,
      project: input.project,
      agentId: input.agentId,
      rev: 1,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    };
    this.deps.store.put(page);
    this.emit(page, "created", by);
    return page;
  }

  update(id: string, patch: { title?: string; body?: string; baseRev?: number }, by: PageAuthor): Page {
    const cur = this.get(id);
    if (patch.baseRev !== undefined && patch.baseRev !== cur.rev) throw new StalePageError(cur);
    return this.write(cur, { title: patch.title?.trim() ?? cur.title, body: patch.body ?? cur.body }, by);
  }

  edit(id: string, edit: PageEditRequest, by: PageAuthor): Page {
    const cur = this.get(id);
    return this.write(cur, { title: cur.title, body: applyPageEdit(cur.body, edit) }, by);
  }

  remove(id: string, by: PageAuthor): void {
    const cur = this.get(id);
    this.deps.store.remove(id);
    this.emit(cur, "deleted", by);
  }

  // The chat a page was linked to is gone — the page stays, unlinked.
  unlinkAgent(agentId: string): void {
    for (const p of this.deps.store.list()) {
      if (p.agentId !== agentId) continue;
      const page = { ...p, agentId: null, rev: p.rev + 1 };
      this.deps.store.put(page);
      this.emit(page, "updated", p.updatedBy);
    }
  }

  // Sync: the page as another Mac has it. The chat link stays this Mac's — chats
  // don't travel.
  applySynced(page: Omit<Page, "rev" | "agentId">): Page {
    const cur = this.deps.store.get(page.id);
    const saved: Page = { ...page, agentId: cur?.agentId ?? null, rev: (cur?.rev ?? 0) + 1 };
    this.deps.store.put(saved);
    this.emit(saved, cur ? "updated" : "created", saved.updatedBy);
    return saved;
  }

  removeSynced(id: string): void {
    const cur = this.deps.store.get(id);
    if (!cur) return;
    this.deps.store.remove(id);
    this.emit(cur, "deleted", cur.updatedBy);
  }

  private write(cur: Page, next: { title: string; body: string }, by: PageAuthor): Page {
    if (next.title === cur.title && next.body === cur.body) return cur;
    const page: Page = { ...cur, ...next, rev: cur.rev + 1, updatedAt: this.deps.clock.now(), updatedBy: by };
    this.deps.store.put(page);
    this.emit(page, "updated", by);
    return page;
  }

  private emit(page: Page, action: PageChangeEvent["action"], by: PageAuthor): void {
    const event: PageChangeEvent = { id: page.id, action, rev: page.rev, project: page.project, by };
    this.deps.bus.publish("pages:change", event);
  }
}
