import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../api/client.js", () => ({
  api: {
    listFiles: vi.fn(async () => ({ entries: [] })),
    watchDir: vi.fn(async () => ({})),
    unwatchDir: vi.fn(async () => ({})),
    unwatchAll: vi.fn(async () => ({})),
  },
}));

import { explorer, _resetForTest } from "../../state/explorerStore.js";
import { openFolder } from "./openFolder.js";

const ui = { openPanel: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTest();
  explorer.setRoot("/project");
});

describe("openFolder", () => {
  it("roots the explorer at the folder even when a root is already open", () => {
    openFolder(ui, "/project/assets/66");
    expect(explorer.getState().root).toBe("/project/assets/66");
    expect(ui.openPanel).toHaveBeenCalledWith("files");
  });

  it("keeps the expanded folders when the folder is already the root", () => {
    explorer.setRoot("/f", { expanded: ["/f/sub"] });
    openFolder(ui, "/f");
    expect([...explorer.getState().expanded]).toEqual(["/f/sub"]);
  });
});
