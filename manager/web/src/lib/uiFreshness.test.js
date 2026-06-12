import { describe, it, expect } from "vitest";
import { bundleSrcFromHtml, checkUiFresh } from "./uiFreshness.js";

const INDEX = (src) => `<!doctype html><html><head>
<script>window.x=1</script>
<script type="module" crossorigin src="${src}"></script>
</head><body></body></html>`;

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};

const deps = (over = {}) => {
  const calls = { reloads: 0 };
  return {
    calls,
    opts: {
      getCurrentSrc: () => "/web/assets/index-OLD.js",
      fetchIndex: async () => INDEX("/web/assets/index-NEW.js"),
      reload: () => { calls.reloads++; },
      storage: memStorage(),
      ...over,
    },
  };
};

describe("bundleSrcFromHtml", () => {
  it("extracts the entry bundle src", () => {
    expect(bundleSrcFromHtml(INDEX("/web/assets/index-Abc123.js"))).toBe("/web/assets/index-Abc123.js");
  });

  it("ignores html without an entry bundle", () => {
    expect(bundleSrcFromHtml("<html>not found — run npm run build</html>")).toBeNull();
    expect(bundleSrcFromHtml("")).toBeNull();
  });
});

describe("checkUiFresh", () => {
  it("reloads when the served bundle differs from the loaded one", async () => {
    const { calls, opts } = deps();
    expect(await checkUiFresh(opts)).toBe(true);
    expect(calls.reloads).toBe(1);
  });

  it("does nothing when bundles match", async () => {
    const { calls, opts } = deps({ fetchIndex: async () => INDEX("/web/assets/index-OLD.js") });
    expect(await checkUiFresh(opts)).toBe(false);
    expect(calls.reloads).toBe(0);
  });

  it("does nothing when the index can't be fetched or parsed", async () => {
    const { calls, opts } = deps({ fetchIndex: async () => null });
    expect(await checkUiFresh(opts)).toBe(false);
    const { calls: c2, opts: o2 } = deps({ fetchIndex: async () => "<html>404</html>" });
    expect(await checkUiFresh(o2)).toBe(false);
    expect(calls.reloads + c2.reloads).toBe(0);
  });

  it("reloads at most once per target bundle (no reload loop)", async () => {
    const { calls, opts } = deps();
    expect(await checkUiFresh(opts)).toBe(true);
    expect(await checkUiFresh(opts)).toBe(false);
    expect(calls.reloads).toBe(1);
  });
});
