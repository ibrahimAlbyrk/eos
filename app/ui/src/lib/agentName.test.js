import { describe, it, expect } from "vitest";
import { definitionOf, shortNameOf } from "./agentName.js";

describe("shortNameOf", () => {
  it("drops the auto-namer's Orchestrator suffix from orchestrators", () => {
    expect(shortNameOf({ is_orchestrator: 1, name: "Kafka Consumer Orchestrator" })).toBe("Kafka Consumer");
    expect(shortNameOf({ is_orchestrator: 1, name: "swift-762-orchestrator" })).toBe("swift-762");
  });

  it("keeps a name that is only the role, and every worker name", () => {
    expect(shortNameOf({ is_orchestrator: 1, id: "o1" })).toBe("Orchestrator");
    expect(shortNameOf({ id: "w1", name: "Docs Orchestrator" })).toBe("Docs Orchestrator");
  });
});

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
