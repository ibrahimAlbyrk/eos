// Sync domains over the data that has a service as its one write path: profile
// fields, the avatar, memories and pages. Each lists the portable form (project
// folders as project keys, no local revs or chat links) and applies it back through
// that service, so open views refresh off the usual change events.

import { z } from "zod";

import type { SyncDomain, SyncItem } from "../../../core/src/ports/SyncDomain.ts";
import type { PageService } from "../../../core/src/services/PageService.ts";
import type { SyncedProfileFields, UserProfileService } from "../../../core/src/services/UserProfileService.ts";
import type { UserMemorySyncTarget } from "../../../core/src/services/UserMemoryService.ts";
import { emptyUserProfile } from "../../../core/src/domain/user-profile.ts";
import { stableStringify } from "../../../core/src/domain/sync.ts";
import { PageSchema, type Page } from "../../../contracts/src/http.ts";
import { AvatarExtSchema, UserMemorySchema, UserProfileSchema, type UserMemory } from "../../../contracts/src/profile.ts";
import type { ProjectKeys } from "./project-keys.ts";

const ProjectRefSchema = z.object({ key: z.string().min(1), path: z.string().min(1) });
type ProjectRef = z.infer<typeof ProjectRefSchema>;

async function toRef(keys: ProjectKeys, path: string): Promise<ProjectRef> {
  return { key: await keys.toKey(path), path };
}

// ---- profile ------------------------------------------------------------------

// Each group is its own record, so edits to different groups on two Macs both land.
// A group at its empty default is "absent": a fresh Mac has nothing to conflict with.
const P = UserProfileSchema.shape;
const PROFILE_FIELDS = {
  identity: P.identity.omit({ avatar: true }),
  language: P.language,
  work: P.work,
  style: P.style,
  instructions: P.instructions,
  sharing: P.sharing,
  budgetTokens: P.budgetTokens,
  onboardedAt: P.onboardedAt,
} as const;
type ProfileField = keyof typeof PROFILE_FIELDS;

function isProfileField(id: string): id is ProfileField {
  return Object.hasOwn(PROFILE_FIELDS, id);
}

export function profileDomain(profile: UserProfileService): SyncDomain {
  const valueOf = (id: ProfileField): unknown => {
    const p = profile.get();
    if (id === "identity") return { fullName: p.identity.fullName, callName: p.identity.callName, handle: p.identity.handle };
    return p[id];
  };
  const fallback = emptyUserProfile();
  const defaults: Record<ProfileField, string> = Object.fromEntries(
    (Object.keys(PROFILE_FIELDS) as ProfileField[]).map((id) => {
      const d = id === "identity" ? { fullName: "", callName: "", handle: "" } : fallback[id];
      return [id, stableStringify(d)];
    }),
  ) as Record<ProfileField, string>;
  const item = (id: ProfileField): SyncItem | null => {
    const data = valueOf(id);
    return stableStringify(data) === defaults[id] ? null : { id, data, updatedAt: profile.get().updatedAt };
  };
  const set = (id: ProfileField, value: unknown): void => {
    profile.applySynced({ [id]: value } as SyncedProfileFields);
  };
  return {
    name: "profile",
    list: async () => (Object.keys(PROFILE_FIELDS) as ProfileField[]).map(item).filter((x): x is SyncItem => x !== null),
    get: async (id) => (isProfileField(id) ? item(id) : null),
    apply: async (id, data) => {
      if (!isProfileField(id)) throw new Error(`unknown profile field ${id}`);
      set(id, PROFILE_FIELDS[id].parse(data));
    },
    remove: async (id) => {
      if (!isProfileField(id)) return;
      set(id, id === "identity" ? { fullName: "", callName: "", handle: "" } : fallback[id]);
    },
  };
}

// ---- avatar -------------------------------------------------------------------

const AvatarSchema = z.object({ ext: AvatarExtSchema, b64: z.string().min(1) });

export function avatarDomain(profile: UserProfileService): SyncDomain {
  const item = (): SyncItem | null => {
    const a = profile.avatar();
    if (!a) return null;
    return { id: "avatar", data: { ext: a.ext, b64: Buffer.from(a.bytes).toString("base64") }, updatedAt: profile.get().updatedAt };
  };
  return {
    name: "avatar",
    list: async () => {
      const a = item();
      return a ? [a] : [];
    },
    get: async (id) => (id === "avatar" ? item() : null),
    apply: async (_id, data) => {
      profile.setAvatar(new Uint8Array(Buffer.from(AvatarSchema.parse(data).b64, "base64")));
    },
    remove: async () => {
      profile.clearAvatar();
    },
  };
}

// ---- memories -----------------------------------------------------------------

const PortableMemorySchema = UserMemorySchema.omit({ id: true, rev: true, scope: true }).extend({
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("global") }),
    z.object({ kind: z.literal("project"), project: ProjectRefSchema }),
  ]),
});

export function memoryDomain(memories: UserMemorySyncTarget, keys: ProjectKeys): SyncDomain {
  const item = async (m: UserMemory): Promise<SyncItem> => {
    const { id, rev: _rev, scope, ...rest } = m;
    const portableScope = scope.kind === "global" ? scope : { kind: "project" as const, project: await toRef(keys, scope.path) };
    return { id, data: { ...rest, scope: portableScope }, updatedAt: m.updatedAt };
  };
  return {
    name: "memory",
    list: async () => Promise.all(memories.list().map(item)),
    get: async (id) => {
      const m = memories.list().find((x) => x.id === id);
      return m ? item(m) : null;
    },
    apply: async (id, data) => {
      const p = PortableMemorySchema.parse(data);
      const scope = p.scope.kind === "global"
        ? p.scope
        : { kind: "project" as const, path: await keys.toPath(p.scope.project.key, p.scope.project.path) };
      memories.applySynced(UserMemorySchema.omit({ rev: true }).parse({ ...p, id, scope }));
    },
    remove: async (id) => memories.removeSynced(id),
  };
}

// ---- pages --------------------------------------------------------------------

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
