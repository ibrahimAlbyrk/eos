import { describe, it, expect } from "vitest";
import { startRun, liveRunsFor, purge, pruneExcept } from "./terminalStore.js";

// Module-level state — keep worker ids unique per assertion to avoid bleed.
let n = 0;
const wid = () => `w${n++}`;

describe("terminalStore purge/pruneExcept", () => {
  it("purge drops a worker's runs and leaves others", () => {
    const a = wid();
    const b = wid();
    startRun(a, `r-${a}`, "ls");
    startRun(b, `r-${b}`, "ls");
    purge(a);
    expect(liveRunsFor(a)).toHaveLength(0);
    expect(liveRunsFor(b)).toHaveLength(1);
  });

  it("pruneExcept drops absent workers but keeps present ones and workspace runs", () => {
    const keep = wid();
    const gone = wid();
    startRun(keep, `r-${keep}`, "ls");
    startRun(gone, `r-${gone}`, "ls");
    startRun(null, "r-workspace", "ls"); // workspace run — no owning worker
    pruneExcept(new Set([keep]));
    expect(liveRunsFor(keep)).toHaveLength(1);
    expect(liveRunsFor(gone)).toHaveLength(0);
    expect(liveRunsFor(null)).toHaveLength(1); // workspace run untouched
  });
});
