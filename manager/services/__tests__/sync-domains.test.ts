import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileDirDomain } from "../sync/file-dir-domain.ts";
import { createProjectKeys, normalizeRemote, type ProjectKeys } from "../sync/project-keys.ts";
import { memoryDomain, pageDomain, profileDomain } from "../sync/service-domains.ts";
import { UserProfileService } from "../../../core/src/services/UserProfileService.ts";
import { UserMemoryService } from "../../../core/src/services/UserMemoryService.ts";
import { PageService } from "../../../core/src/services/PageService.ts";
import type { UserMemory, UserProfile } from "../../../contracts/src/profile.ts";
import type { Page } from "../../../contracts/src/http.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "eos-sync-dom-"));
const bus = { publish: () => {} };
const clock = { now: () => 1000 };

// Air keeps the repo at /air/eos, Pro at /pro/eos — the key is what they share.
const keysOf = (root: string): ProjectKeys => ({
  toKey: async (path) => (path.startsWith(root) ? `git:github.com/o/eos${path.slice(root.length).replace(/^\//, "#")}` : `path:${path}`),
  toPath: async (key, hint) => (key.startsWith("git:github.com/o/eos") ? root + key.slice("git:github.com/o/eos".length).replace("#", "/") : hint),
});

function profileService(): UserProfileService {
  let p: UserProfile | null = null;
  return new UserProfileService({
    store: { get: () => p, put: (x) => { p = x; } },
    avatars: { read: () => null, write: () => {}, remove: () => {} },
    clock,
    bus,
  });
}

describe("sync project keys", () => {
  it("normalizes every remote spelling of one repo to one key", () => {
    for (const url of [
      "git@github.com:Owner/eos.git",
      "https://github.com/Owner/eos",
      "https://user@GitHub.com/Owner/eos.git/",
      "ssh://git@github.com:22/Owner/eos.git",
    ]) assert.equal(normalizeRemote(url), "github.com/Owner/eos", url);
    assert.equal(normalizeRemote("not a url"), null);
  });

  it("finds this Mac's checkout of a repo, and remembers paths it could not place", async () => {
    const home = tmp();
    const air = join(home, "air-eos");
    const pro = join(home, "pro-eos");
    mkdirSync(join(air, "app"), { recursive: true });
    mkdirSync(pro, { recursive: true });
    // Each Mac's git sees only its own checkout.
    const gitAt = (root: string) => ({
      gitDirs: async (p: string) => (p.startsWith(root) ? { toplevel: root, gitDir: join(root, ".git"), commonDir: join(root, ".git") } : null),
      remoteUrl: async () => "git@github.com:o/eos.git",
    });
    const onAir = createProjectKeys({ git: gitAt(air), candidates: () => [], learnedPath: join(home, "air.json") });
    const onPro = createProjectKeys({ git: gitAt(pro), candidates: () => [pro], learnedPath: join(home, "pro.json") });
    const key = await onAir.toKey(join(air, "app"));
    assert.equal(key, "git:github.com/o/eos#app");
    assert.equal(await onPro.toPath(key, join(air, "app")), join(pro, "app"));
    assert.equal(await onAir.toKey("/nowhere"), "path:/nowhere");

    const lonely = createProjectKeys({ git: { gitDirs: async () => null, remoteUrl: async () => null }, candidates: () => [], learnedPath: join(home, "l.json") });
    assert.equal(await lonely.toPath("git:github.com/o/other", "/x/other"), "/x/other");
    assert.equal(await lonely.toKey("/x/other"), "git:github.com/o/other");
  });
});

describe("sync domains", () => {
  it("profile groups at their defaults are absent; a tombstone resets one", async () => {
    const svc = profileService();
    const dom = profileDomain(svc);
    assert.deepEqual(await dom.list(), []);
    svc.update({ style: { replies: "terse" }, language: { chat: "tr" } });
    assert.deepEqual((await dom.list()).map((i) => i.id).sort(), ["language", "style"]);

    const other = profileService();
    const od = profileDomain(other);
    await od.apply("style", (await dom.get("style"))!.data);
    assert.equal(other.get().style.replies, "terse");
    await assert.rejects(od.apply("style", { replies: "loud" }));
    await assert.rejects(od.apply("dreaming", {}));
    await od.remove("style");
    assert.equal(other.get().style.replies, null);
  });

  it("memories travel with their project as a key and land in this Mac's folder", async () => {
    const store = new Map<string, UserMemory>();
    const mem = (): UserMemoryService => new UserMemoryService({
      store: { list: () => [...store.values()], get: (id) => store.get(id) ?? null, put: (m) => { store.set(m.id, m); }, remove: (id) => store.delete(id) },
      clock, bus, newId: () => "um-abcdef123456",
    });
    const air = mem();
    const m = air.create({ text: "Use tabs here", category: "work-style", scope: { kind: "project", path: "/air/eos" }, tier: "always" });
    const item = await memoryDomain(air, keysOf("/air/eos")).get(m.id);
    assert.deepEqual((item!.data as { scope: unknown }).scope, { kind: "project", project: { key: "git:github.com/o/eos", path: "/air/eos" } });
    assert.equal("rev" in (item!.data as object), false);

    const proStore = new Map<string, UserMemory>();
    const pro = new UserMemoryService({
      store: { list: () => [...proStore.values()], get: (id) => proStore.get(id) ?? null, put: (x) => { proStore.set(x.id, x); }, remove: (id) => proStore.delete(id) },
      clock, bus, newId: () => "um-x",
    });
    await memoryDomain(pro, keysOf("/pro/eos")).apply(m.id, item!.data);
    assert.deepEqual(proStore.get(m.id)?.scope, { kind: "project", path: "/pro/eos" });
    assert.equal(proStore.get(m.id)?.text, "Use tabs here");
  });

  it("pages keep this Mac's chat link and map their project", async () => {
    const pageStore = (): { svc: PageService; rows: Map<string, Page> } => {
      const rows = new Map<string, Page>();
      const svc = new PageService({
        store: { list: () => [...rows.values()], get: (id) => rows.get(id) ?? null, put: (p) => { rows.set(p.id, p); }, remove: (id) => rows.delete(id) },
        clock, bus, newId: () => "pg-abcdef123456",
      });
      return { svc, rows };
    };
    const air = pageStore();
    const page = air.svc.create({ title: "Plan", body: "- [ ] x", project: "/air/eos", agentId: "w-air" }, { kind: "user", agentId: null, name: null });
    const item = await pageDomain(air.svc, keysOf("/air/eos")).get(page.id);
    assert.equal("agentId" in (item!.data as object), false);

    const pro = pageStore();
    pro.rows.set(page.id, { ...page, project: "/pro/eos", agentId: "w-pro", body: "old" });
    await pageDomain(pro.svc, keysOf("/pro/eos")).apply(page.id, item!.data);
    const got = pro.rows.get(page.id)!;
    assert.equal(got.body, "- [ ] x");
    assert.equal(got.agentId, "w-pro");
    assert.equal(got.project, "/pro/eos");
  });

  it("a folder domain carries files and assets, refuses unsafe names, deletes softly", async () => {
    const src = tmp();
    const dst = tmp();
    mkdirSync(join(src, "assets", "review"), { recursive: true });
    writeFileSync(join(src, "review.md"), "---\ndescription: d\n---\n\nbody\n");
    writeFileSync(join(src, "assets", "review", "shot.png"), Buffer.from([1, 2, 3]));
    writeFileSync(join(src, "notes.txt"), "ignored");
    const a = fileDirDomain({ name: "template", dir: src, idPattern: /^[a-z0-9][a-z0-9-]*$/, withAssets: true });
    const b = fileDirDomain({ name: "template", dir: dst, idPattern: /^[a-z0-9][a-z0-9-]*$/, withAssets: true });
    const items = await a.list();
    assert.deepEqual(items.map((i) => i.id), ["review"]);
    await b.apply("review", items[0]!.data);
    assert.equal(readFileSync(join(dst, "review.md"), "utf8"), "---\ndescription: d\n---\n\nbody\n");
    assert.deepEqual([...readFileSync(join(dst, "assets", "review", "shot.png"))], [1, 2, 3]);

    await assert.rejects(b.apply("../escape", { md: "x" }));
    await assert.rejects(b.apply("ok", { md: "x", assets: { "../x": "AA==" } }));
    await b.remove("review");
    assert.equal(existsSync(join(dst, "review.md")), false);
    assert.equal(readdirSync(join(dst, ".trash")).some((f) => f.startsWith("review.")), true);
  });
});
