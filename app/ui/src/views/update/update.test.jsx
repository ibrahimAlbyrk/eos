import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../api/client.js", () => ({ api: { getUpdate: vi.fn(async () => null) } }));
vi.mock("../../state/ui.jsx", () => ({ useUi: () => ({ openPopover: null, openPop: () => {}, closeAllPops: () => {} }) }));
vi.mock("../../state/settings.jsx", () => ({ useSettings: () => ({ closeSettings: () => {} }) }));
vi.mock("./useOpenReleaseNotes.js", () => ({ useOpenReleaseNotes: () => () => {} }));

const { UpdateBeacon, UpdatePopoverBody } = await import("./UpdateBeacon.jsx");
const { UpdatesSettings } = await import("../../settings/UpdatesSettings.jsx");
const { setUpdateState } = await import("../../state/updateStore.js");

const status = (phase, over = {}) => ({ phase, off: null, version: null, bytes: null, done: null, full: null, agents: null, error: null, ...over });
const state = (s, over = {}) => ({ current: "0.1.2", status: s, lastCheckedAt: null, autoDownload: true, notes: null, notice: null, ...over });
const body = (st, agents = []) => renderToStaticMarkup(<UpdatePopoverBody state={st} agents={agents} close={() => {}} run={() => {}} openNotes={() => {}} />);

describe("update beacon", () => {
  it("is hidden while up to date and lit once a version is ready", () => {
    setUpdateState(state(status("idle")));
    expect(renderToStaticMarkup(<UpdateBeacon live={{ workers: [] }} />)).toBe("");
    setUpdateState(state(status("ready", { version: "0.1.3" })));
    const html = renderToStaticMarkup(<UpdateBeacon live={{ workers: [] }} />);
    expect(html).toContain('class="up-beacon is-ready"');
    expect(html).toContain("up-dot");
    expect(html).toContain(">Update<");
  });

  it("draws a progress ring while downloading", () => {
    setUpdateState(state(status("downloading", { version: "0.1.3", bytes: 100, done: 50 })));
    const html = renderToStaticMarkup(<UpdateBeacon live={{ workers: [] }} />);
    expect(html).toContain("up-ring__fill");
    expect(html).toContain('aria-label="Downloading Eos 0.1.3"');
  });
});

describe("update popover", () => {
  it("shows what came down next to a full download, and offers Restart now", () => {
    const html = body(state(status("ready", { version: "0.1.3", bytes: 838_861, full: 230_000_000 })));
    expect(html).toContain("Eos 0.1.3 is ready");
    expect(html).toContain("819 KB");
    expect(html).toContain("of 219 MB");
    expect(html).toContain("What’s new in 0.1.3");
    expect(html).toContain(">Later<");
    expect(html).toContain(">Restart now<");
  });

  it("offers to wait for working agents", () => {
    const html = body(state(status("ready", { version: "0.1.3" })), [{ id: "w1", name: "Fix PTY race", parent_id: null, state: "WORKING" }]);
    expect(html).toContain("1 agent is working");
    expect(html).toContain(">When they finish<");
  });

  it("explains a failed update and a version that was rolled back", () => {
    expect(body(state(status("error", { version: "0.1.3", error: "signature broke" })))).toContain("Couldn&#x27;t update to 0.1.3");
    const rolled = body(state(status("idle"), { notice: { kind: "rolled-back", version: "0.1.3", from: "0.1.2" } }));
    expect(rolled).toContain("Eos 0.1.3 didn&#x27;t start");
    expect(rolled).toContain("Eos went back to 0.1.2");
  });
});

describe("Settings › Updates", () => {
  it("shows the status card, the auto-download switch and the version", () => {
    setUpdateState(state(status("ready", { version: "0.1.3", bytes: 838_861 })));
    const html = renderToStaticMarkup(<UpdatesSettings />);
    expect(html).toContain("Eos 0.1.3 is ready");
    expect(html).toContain("Download updates automatically");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(">Restart now<");
    expect(html).toContain(">0.1.2<");
  });

  it("says why a build from source doesn't update", () => {
    setUpdateState(state(status("off", { off: "dev-build" }), { current: null }));
    const html = renderToStaticMarkup(<UpdatesSettings />);
    expect(html).toContain("built from source");
    expect(html).not.toContain("Download updates automatically");
    expect(html).toContain("Built from source");
  });
});
