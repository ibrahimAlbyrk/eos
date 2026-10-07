// Two Macs, one relay: real services, real files, real crypto and the real relay
// vault over HTTP — only the git lookup is faked.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { SyncService } from "../sync/SyncService.ts";
import { avatarDomain, memoryDomain, pageDomain, profileDomain } from "../sync/service-domains.ts";
import { fileDirDomain } from "../sync/file-dir-domain.ts";
import type { ProjectKeys } from "../sync/project-keys.ts";
import { UserProfileService } from "../../../core/src/services/UserProfileService.ts";
import { UserMemoryService } from "../../../core/src/services/UserMemoryService.ts";
import { PageService } from "../../../core/src/services/PageService.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import { FileUserAvatarStore, FileUserProfileStore } from "../../../infra/src/persistence/FileUserProfileStore.ts";
import { FileUserMemoryStore } from "../../../infra/src/persistence/FileUserMemoryStore.ts";
import { FilePageStore } from "../../../infra/src/persistence/FilePageStore.ts";
import { FileSyncIdentityStore, FileSyncStateStore } from "../../../infra/src/sync/stores.ts";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import { createRelay } from "../../../relay/server.ts";
import { loadConfig } from "../../../relay/config.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
const keys: ProjectKeys = { toKey: async (p) => `path:${p}`, toPath: async (k) => k.slice(5), findPath: async () => null };

function mac(relayUrl: string | null, name: string) {
  const home = mkdtempSync(join(tmpdir(), `eos-sync-${name}-`));
  const bus = createInMemoryEventBus();
  const clock = { now: () => Date.now() };
  let n = 0;
  const id = () => `${name}${String(++n).padStart(9, "0")}`;
  const profile = new UserProfileService({
    store: new FileUserProfileStore(join(home, "profile")),
    avatars: new FileUserAvatarStore(join(home, "profile")),
    clock, bus,
  });
  const memories = new UserMemoryService({ store: new FileUserMemoryStore(join(home, "profile", "memories")), clock, bus, newId: () => `um-${id()}` });
  const pages = new PageService({ store: new FilePageStore(join(home, "pages")), clock, bus, newId: () => `pg-${id()}` });
  const workersDir = join(home, "workers");
  const sync = new SyncService({
    identities: new FileSyncIdentityStore(join(home, "sync")),
    state: new FileSyncStateStore(join(home, "sync")),
    domains: [
      profileDomain(profile),
      avatarDomain(profile),
      memoryDomain(memories, keys),
      pageDomain(pages, keys),
      fileDirDomain({ name: "worker", dir: workersDir, idPattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }),
    ],
    relayUrl: () => relayUrl,
    device: name,
    bus,
    log: quiet,
    now: () => Date.now(),
  });
  for (const topic of ["pages:change", "profile:change"] as const) bus.subscribe(topic, () => sync.noteLocalChange());
  bus.subscribe("user-memory:change", (m) => {
    if ((m.payload as { by: string }).by !== "sync") sync.noteLocalChange();
  });
  return { home, profile, memories, pages, workersDir, sync };
}

async function until(what: string, ok: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function withRelay(fn: (url: string) => Promise<void>): Promise<void> {
  const { httpServer } = createRelay({ ...loadConfig({}), vaultPath: ":memory:" });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;
  try {
    await fn(url);
  } finally {
    httpServer.closeAllConnections();
    await new Promise<void>((r) => httpServer.close(() => r()));
  }
}

describe("SyncService across two Macs", () => {
  it("a joined Mac gets everything, and edits flow both ways live", async () => {
    await withRelay(async (url) => {
      const air = mac(url, "air");
      air.profile.update({ identity: { fullName: "Ibrahim" }, style: { replies: "terse" } });
      const kept = air.memories.create({ text: "Prefers pnpm", category: "stack", scope: { kind: "global" }, tier: "always" });
      air.pages.create({ title: "Plan", body: "hello", project: null, agentId: null }, { kind: "user", agentId: null, name: null });
      air.sync.create();
      await until("air's first push", () => air.sync.status().counts.memory === 1 && air.sync.status().phase === "idle");

      const pro = mac(null, "pro");
      pro.profile.update({ style: { replies: "thorough" } });
      pro.memories.create({ text: "Works on Unity", category: "stack", scope: { kind: "global" }, tier: "always" });
      pro.sync.join(air.sync.key()!);
      await until("pro catching up", () => pro.memories.list().length === 2 && pro.pages.list().length === 1);
      assert.equal(pro.profile.get().identity.fullName, "Ibrahim");
      assert.equal(pro.profile.get().style.replies, "terse", "joining adopts the account's profile");
      assert.ok(existsSync(join(pro.home, "sync", "conflicts", "profile")), "pro's own style is kept aside");

      await until("air seeing pro's memory", () => air.memories.list().length === 2);

      air.memories.update(kept.id, { text: "Prefers pnpm, never npm" });
      await until("the edit reaching pro", () => pro.memories.list().find((m) => m.id === kept.id)?.text === "Prefers pnpm, never npm");

      pro.memories.remove(kept.id);
      await until("the delete reaching air", () => !air.memories.list().some((m) => m.id === kept.id));

      air.sync.stop();
      pro.sync.stop();
    });
  });

  it("a Mac that was off catches up when it comes back", async () => {
    await withRelay(async (url) => {
      const air = mac(url, "air");
      air.sync.create();
      const pro = mac(null, "pro");
      pro.sync.join(air.sync.key()!);
      await until("both idle", () => air.sync.status().phase === "idle" && pro.sync.status().phase === "idle");
      pro.sync.stop();

      air.profile.update({ language: { chat: "tr" } });
      mkdirSync(air.workersDir, { recursive: true });
      writeFileSync(join(air.workersDir, "reviewer.md"), "---\nname: reviewer\n---\nReview.\n");
      air.sync.syncNow();
      await until("air pushing", () => air.sync.status().counts.worker === 1 && air.sync.status().counts.profile === 1);
      air.sync.stop();

      pro.sync.start();
      await until("pro catching up", () => pro.profile.get().language.chat === "tr" && existsSync(join(pro.workersDir, "reviewer.md")));
      pro.sync.stop();
    });
  });

  it("refuses to create without a relay and to join with a bad key; leaving keeps the data", async () => {
    const lone = mac(null, "lone");
    assert.throws(() => lone.sync.create(), /relay/);
    assert.throws(() => lone.sync.join("eos-sync1.nope.nope"), /sync key/);
    await withRelay(async (url) => {
      const air = mac(url, "air");
      air.memories.create({ text: "x", category: "other", scope: { kind: "global" }, tier: "always" });
      air.sync.create();
      assert.ok(air.sync.key());
      const status = air.sync.leave();
      assert.equal(status.phase, "off");
      assert.equal(air.sync.key(), null);
      assert.equal(air.memories.list().length, 1);
    });
  });
});
