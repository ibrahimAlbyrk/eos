import { describe, it, expect } from "vitest";
import { definitionOf } from "./agentName.js";

describe("definitionOf", () => {
  it("suppresses the general-purpose default (every plain worker resolves to it)", () => {
    expect(definitionOf({ worker_definition: "general-purpose" })).toBe(null);
  });

  it("shows an actual specialist definition", () => {
    expect(definitionOf({ worker_definition: "git" })).toBe("git");
  });

  it("returns null for orchestrators", () => {
    expect(definitionOf({ is_orchestrator: true, worker_definition: "git" })).toBe(null);
  });

  it("returns null when the definition is empty or the worker is missing", () => {
    expect(definitionOf({ worker_definition: "" })).toBe(null);
    expect(definitionOf({})).toBe(null);
    expect(definitionOf(null)).toBe(null);
  });
});
