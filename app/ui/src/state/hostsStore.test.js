import { describe, it, expect } from "vitest";
import { routeLabel } from "./hostsStore.js";

const offline = (error) => ({ state: "offline", route: null, rttMs: null, since: 0, attempt: 0, error });

describe("routeLabel", () => {
  it("a copy that dials no other computer says so instead of plain Offline", () => {
    expect(routeLabel(offline("off-network"))).toBe("Off for this copy");
  });

  it("a link that is down for no known reason is Offline", () => {
    expect(routeLabel(offline(null))).toBe("Offline");
    expect(routeLabel(offline("local-network"))).toBe("Local network blocked");
  });
});
