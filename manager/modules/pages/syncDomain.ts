// Pages follow the user to every Mac holding the same sync key (Settings ›
// Sync). A page's project travels as its git-remote key, so it lands in the
// same project on the other Mac.

import type { SyncDomain, SyncItem } from "../../../core/src/ports/SyncDomain.ts";
import type { PageService } from "../../../core/src/services/PageService.ts";
import { PageSchema, type Page } from "../../../contracts/src/http.ts";
import { ProjectRefSchema, toRef, type ProjectKeys } from "../../services/project-keys.ts";

const PortablePageSchema = PageSchema.omit({ id: true, rev: true, agentId: true, project: true }).extend({
  project: ProjectRefSchema.nullable(),
});

export function pageDomain(pages: PageService, keys: ProjectKeys): SyncDomain {
  const item = async (p: Page): Promise<SyncItem> => {
    const { id, rev: _rev, agentId: _agentId, project, ...rest } = p;
    return { id, data: { ...rest, project: project ? await toRef(keys, project) : null }, updatedAt: p.updatedAt };
  };
  const find = (id: string): Page | null => {
    try {
      return pages.get(id);
    } catch {
      return null;
    }
  };
  return {
    name: "page",
    list: async () => Promise.all(pages.list().map((s) => pages.get(s.id)).map(item)),
    get: async (id) => {
      const p = find(id);
      return p ? item(p) : null;
    },
    apply: async (id, data) => {
      const p = PortablePageSchema.parse(data);
      const project = p.project ? await keys.toPath(p.project.key, p.project.path) : null;
      pages.applySynced(PageSchema.omit({ rev: true, agentId: true }).parse({ ...p, id, project }));
    },
    remove: async (id) => pages.removeSynced(id),
  };
}
