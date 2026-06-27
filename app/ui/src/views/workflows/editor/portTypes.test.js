import { describe, it, expect } from "vitest";
import { isPortTypeAssignable as mirror, PORT_TYPES } from "./portTypes.js";
// Import the REAL contract function — vitest transpiles TS + resolves contracts'
// own zod, so this is the single source of truth the UI mirror must match. If the
// contract rule ever changes, this test fails and the mirror must be updated.
import {
  isPortTypeAssignable as real,
  PORT_TYPES as REAL_TYPES,
} from "../../../../../../contracts/src/workflow-graph.ts";

describe("UI port-type rule mirrors contracts exactly", () => {
  it("PORT_TYPES matches the contract list", () => {
    expect(PORT_TYPES).toEqual([...REAL_TYPES]);
  });

  it("isPortTypeAssignable agrees with contracts for every (from,to) pair", () => {
    for (const from of REAL_TYPES) {
      for (const to of REAL_TYPES) {
        expect(mirror(from, to)).toBe(real(from, to));
      }
    }
  });

  it("rejects a concrete-type mismatch and allows `any`", () => {
    expect(mirror("number", "array")).toBe(false);
    expect(mirror("any", "array")).toBe(true);
    expect(mirror("json", "object")).toBe(true);
  });
});
