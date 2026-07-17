import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Effect-order guard for the agent-switch scroll restore (in the spirit of
// manager's backend-kind-literal-guard). React runs a component's layout
// effects in declaration order within one commit, so "reset runs before
// restore, pre-paint" holds only while BOTH stay true in the source:
//   (a) the reset is a useLayoutEffect — as a passive useEffect it ran
//       post-paint, the restore effect bailed on the previous agent's stale
//       initialScrollDone=true, and the switch frame painted at the old
//       scrollTop (the in-place split-pane jump);
//   (b) the reset is declared ABOVE the restore effect.
// The suite has no DOM/renderer, so this pins the source shape the commit
// ordering depends on.

const src = readFileSync(
  fileURLToPath(new URL("./Messages.jsx", import.meta.url)),
  "utf8",
);

// The effect opener nearest above an index. "useEffect(" is not a substring
// of "useLayoutEffect(", so the two lastIndexOf probes are independent.
function effectOpenerBefore(idx) {
  const head = src.slice(0, idx);
  return head.lastIndexOf("useLayoutEffect(") > head.lastIndexOf("useEffect(")
    ? "useLayoutEffect"
    : "useEffect";
}

describe("Messages reset→restore commit ordering", () => {
  const resetIdx = src.indexOf("initialScrollDone.current = false");
  const restoreIdx = src.indexOf("loadScrollPos(selectedId)");

  it("finds both effects (markers still present)", () => {
    expect(resetIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(-1);
  });

  it("the reset is a layout effect (pre-paint)", () => {
    expect(effectOpenerBefore(resetIdx)).toBe("useLayoutEffect");
  });

  it("the reset is declared before the restore effect", () => {
    expect(resetIdx).toBeLessThan(restoreIdx);
  });

  it("the restore is a layout effect too (restore before first paint)", () => {
    expect(effectOpenerBefore(restoreIdx)).toBe("useLayoutEffect");
  });
});
