import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  UserProfileSchema, UserProfilePatchSchema, UserMemorySchema, UserMemorySuggestRequestSchema,
  ProfileLanguageSchema,
} from "../profile.ts";

const PROFILE = {
  rev: 0, updatedAt: 0,
  identity: { fullName: "", callName: "", handle: "", avatar: null },
  language: { chat: null, code: null },
  work: { roles: [], stack: [], level: null },
  style: { replies: null, autonomy: null, whenUnclear: null, commits: null },
  instructions: "",
  sharing: { withholdFrom: [] },
  budgetTokens: 800,
  onboardedAt: null,
};

describe("profile contracts", () => {
  it("accepts an empty profile", () => {
    assert.ok(UserProfileSchema.safeParse(PROFILE).success);
  });

  it("accepts language codes and mirror, rejects free text", () => {
    for (const ok of ["tr", "en", "pt-BR", "mirror"]) assert.ok(ProfileLanguageSchema.safeParse(ok).success, ok);
    for (const bad of ["Turkish", "", "../x"]) assert.ok(!ProfileLanguageSchema.safeParse(bad).success, bad);
  });

  it("patch cannot set the avatar or unknown keys", () => {
    assert.ok(UserProfilePatchSchema.safeParse({ identity: { callName: "Ibrahim" } }).success);
    assert.ok(!UserProfilePatchSchema.safeParse({ identity: { avatar: "png" } }).success);
    assert.ok(!UserProfilePatchSchema.safeParse({ rev: 3 }).success);
  });

  it("memory ids are prefixed, text is bounded and trimmed", () => {
    const mem = {
      id: "um-abc12345", text: "  Call me Ibrahim.  ", category: "about", scope: { kind: "global" },
      tier: "always", status: "active", source: { kind: "user" }, rev: 0, createdAt: 1, updatedAt: 1,
    };
    const parsed = UserMemorySchema.parse(mem);
    assert.equal(parsed.text, "Call me Ibrahim.");
    assert.ok(!UserMemorySchema.safeParse({ ...mem, id: "pg-abc12345" }).success);
    assert.ok(!UserMemorySchema.safeParse({ ...mem, text: "x".repeat(501) }).success);
  });

  it("a profile saved before Dreaming loads with the nightly/opus defaults", () => {
    const p = UserProfileSchema.parse(PROFILE);
    assert.equal(p.dreaming.enabled, false);
    assert.equal(p.dreaming.schedule, "nightly");
    assert.equal(p.dreaming.nightlyAt, "03:00");
    assert.equal(p.dreaming.model, "opus");
    assert.ok(!UserProfileSchema.safeParse({ ...PROFILE, dreaming: { ...p.dreaming, nightlyAt: "25:00" } }).success);
    assert.ok(UserProfilePatchSchema.safeParse({ dreaming: { enabled: true } }).success);
    assert.ok(!UserProfilePatchSchema.safeParse({ dreaming: { bogus: 1 } }).success);
  });

  it("dream-made memories carry their proposal and evidence; dismissed is a status", () => {
    const mem = {
      id: "um-abc12345", text: "Prefers pnpm.", category: "stack", scope: { kind: "global" }, tier: "always",
      status: "dismissed", rev: 0, createdAt: 1, updatedAt: 1,
      source: { kind: "dream", dreamId: "dr-1", evidence: [{ quote: "use pnpm", workerId: "w-1", chat: "x", eventId: 4, by: "user" }] },
      proposal: { kind: "update", targets: ["um-old00000"], confidence: 2 },
    };
    assert.ok(UserMemorySchema.safeParse(mem).success);
    assert.ok(!UserMemorySchema.safeParse({ ...mem, proposal: { kind: "rename", targets: [], confidence: 2 } }).success);
  });

  it("an agent suggestion never names a project path", () => {
    assert.ok(UserMemorySuggestRequestSchema.safeParse({ text: "x", category: "stack", scope: "project" }).success);
    assert.ok(!UserMemorySuggestRequestSchema.safeParse({ text: "x", category: "stack", scope: { kind: "project", path: "/" } }).success);
  });
});
