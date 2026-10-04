import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StaleProfileError, UserProfileService } from "../services/UserProfileService.ts";
import { buildUserProfileBlock, receivedMemoryLines } from "../use-cases/BuildUserProfileBlock.ts";
import { DEFAULT_USER_PREFERENCES } from "../services/render-user-profile.ts";
import { sniffAvatarExt } from "../domain/user-profile.ts";
import { ValidationError } from "../errors/index.ts";
import type { UserAvatar } from "../ports/UserProfileStore.ts";
import type { UserProfile } from "../../../contracts/src/profile.ts";
import type { MemorySnapshot } from "../ports/MemoryProvider.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

function makeService() {
  let saved: UserProfile | null = null;
  let avatar: UserAvatar | null = null;
  const events: unknown[] = [];
  let now = 100;
  const svc = new UserProfileService({
    store: { get: () => saved, put: (p) => { saved = p; } },
    avatars: { read: () => avatar, write: (a) => { avatar = a; }, remove: () => { avatar = null; } },
    clock: { now: () => (now += 1) },
    bus: { publish: (topic, payload) => { events.push({ topic, payload }); } },
  });
  return { svc, events, stored: () => saved, avatar: () => avatar };
}

describe("UserProfileService", () => {
  it("starts empty at rev 0 without writing", () => {
    const { svc, stored } = makeService();
    assert.equal(svc.get().rev, 0);
    assert.equal(stored(), null);
  });

  it("a real change bumps rev, stamps time, persists and publishes", () => {
    const { svc, events, stored } = makeService();
    const p = svc.update({ identity: { callName: "Ibrahim" } });
    assert.equal(p.rev, 1);
    assert.equal(p.updatedAt, 101);
    assert.equal(stored()?.identity.callName, "Ibrahim");
    assert.deepEqual(events, [{ topic: "profile:change", payload: { rev: 1 } }]);
  });

  it("a no-op save keeps the revision and publishes nothing", () => {
    const { svc, events } = makeService();
    svc.update({ identity: { callName: "Ibrahim" } });
    const again = svc.update({ identity: { callName: " Ibrahim " } });
    assert.equal(again.rev, 1);
    assert.equal(events.length, 1);
  });

  it("a stale baseRev is refused with the current profile", () => {
    const { svc } = makeService();
    svc.update({ instructions: "a" }, 0);
    assert.throws(() => svc.update({ instructions: "b" }, 0), (e: unknown) => e instanceof StaleProfileError && e.profile.rev === 1);
  });

  it("avatar: sniffs the type, rejects non-images, records the extension", () => {
    const { svc, avatar } = makeService();
    assert.throws(() => svc.setAvatar(new TextEncoder().encode("<svg/>")), ValidationError);
    assert.throws(() => svc.setAvatar(new Uint8Array()), ValidationError);
    const p = svc.setAvatar(JPEG);
    assert.equal(p.identity.avatar, "jpeg");
    assert.equal(avatar()?.ext, "jpeg");
    assert.equal(svc.clearAvatar().identity.avatar, null);
    assert.equal(avatar(), null);
  });

  it("sniffs png / jpeg / webp", () => {
    assert.equal(sniffAvatarExt(PNG), "png");
    assert.equal(sniffAvatarExt(JPEG), "jpeg");
    assert.equal(sniffAvatarExt(WEBP), "webp");
    assert.equal(sniffAvatarExt(new Uint8Array([1, 2, 3])), null);
  });
});

describe("buildUserProfileBlock", () => {
  const SNAP: MemorySnapshot = {
    docs: [
      { sourceId: "claude", sourceLabel: "CLAUDE.md", nativeFor: ["claude"], path: "/u/CLAUDE.md", level: "user", content: "Be terse.\nUse pnpm." },
    ],
  };

  it("a withheld kind gets the stock preferences", () => {
    const { svc } = makeService();
    svc.update({ identity: { callName: "Ibrahim" }, sharing: { withholdFrom: ["gemini-cli"] } });
    const deps = { profile: svc, memories: () => [] };
    const gem = buildUserProfileBlock(deps, { kind: "gemini-cli", project: null, knownLines: [], searchToolName: null });
    assert.equal(gem.text, DEFAULT_USER_PREFERENCES);
    assert.ok(gem.withheld);
    const cla = buildUserProfileBlock(deps, { kind: "claude", project: null, knownLines: [], searchToolName: null });
    assert.match(cla.text, /Ibrahim/);
    assert.ok(!cla.withheld);
  });

  it("known lines = native docs always, injected docs only when injection is on", () => {
    assert.deepEqual(receivedMemoryLines(SNAP, "claude", false), ["Be terse.", "Use pnpm."]);
    assert.deepEqual(receivedMemoryLines(SNAP, "codex-cli", false), []);
    assert.deepEqual(receivedMemoryLines(SNAP, "codex-cli", true), ["Be terse.", "Use pnpm."]);
  });
});
