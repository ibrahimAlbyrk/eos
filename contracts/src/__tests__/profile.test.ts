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

  it("an agent suggestion never names a project path", () => {
    assert.ok(UserMemorySuggestRequestSchema.safeParse({ text: "x", category: "stack", scope: "project" }).success);
    assert.ok(!UserMemorySuggestRequestSchema.safeParse({ text: "x", category: "stack", scope: { kind: "project", path: "/" } }).success);
  });
});
