// artifacts:open — an agent's artifact comes up beside its chat, only where a
// live view can show it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyArtifactOpen, registerArtifactPanes } from "./artifactViewStore.js";

const SLUG = "0f8e2a9c-1b3d-4e5f-8a7b-6c5d4e3f2a1b";
const open = { workerId: "w-1", slug: SLUG, url: "https://claude.ai/artifact/YBc8tWaK41fiYSKdCZ88EM", title: "Notes" };

afterEach(() => {
  vi.unstubAllGlobals();
  registerArtifactPanes(null);
});

describe("applyArtifactOpen", () => {
  it("opens the artifact's tab beside the worker's chat", () => {
    vi.stubGlobal("window", { eosArtifacts: {} });
    const panes = vi.fn();
    registerArtifactPanes(panes);
    applyArtifactOpen(open);
    expect(panes).toHaveBeenCalledWith("w-1", `artifact:${SLUG}`, { title: "Notes", loginId: null, url: open.url });
  });

  it("does nothing without the shell's artifact views or a slug", () => {
    const panes = vi.fn();
    registerArtifactPanes(panes);
    vi.stubGlobal("window", {});
    applyArtifactOpen(open);
    vi.stubGlobal("window", { eosArtifacts: {} });
    applyArtifactOpen({ ...open, slug: null });
    expect(panes).not.toHaveBeenCalled();
  });
});
