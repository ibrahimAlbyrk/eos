import { describe, it, expect } from "vitest";
import { ROUTES as webRoutes } from "./routes.js";
// Vitest transpiles TS on the fly and resolves the contracts package's own
// node_modules (for zod), so importing the source schema file works directly.
// This is the whole point of the test: catch drift between the duplicated web
// route table and the canonical contracts one (finding D5).
import { ROUTES as contractRoutes } from "../../../../contracts/src/http.ts";

// Resolve a route entry to a comparable path string. Function routes are
// path templates; invoke with a sentinel id so string and function entries
// compare on equal footing.
function resolve(entry) {
  return typeof entry === "function" ? entry(":id") : entry;
}

describe("web ROUTES parity with contracts ROUTES", () => {
  it("contracts ROUTES actually loaded (import did not silently no-op)", () => {
    expect(contractRoutes).toBeTruthy();
    expect(contractRoutes.health).toBe("/health");
  });

  it("every web ROUTES key exists in contracts ROUTES", () => {
    const missing = Object.keys(webRoutes).filter(
      (key) => !(key in contractRoutes),
    );
    expect(missing).toEqual([]);
  });

  it("every web ROUTES path matches the contracts path for that key", () => {
    const mismatched = [];
    for (const key of Object.keys(webRoutes)) {
      if (!(key in contractRoutes)) continue;
      const web = resolve(webRoutes[key]);
      const contract = resolve(contractRoutes[key]);
      if (web !== contract) mismatched.push({ key, web, contract });
    }
    expect(mismatched).toEqual([]);
  });
});
