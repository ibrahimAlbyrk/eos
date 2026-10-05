import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SyncSettings } from "./SyncSettings.jsx";
import { setSyncStatus } from "../state/syncStore.js";

const render = (status) => {
  setSyncStatus(status);
  return renderToStaticMarkup(<SyncSettings />);
};

describe("SyncSettings", () => {
  it("off: offers to create a key or join with one, and never shows a key", () => {
    const html = render({ phase: "off", relay: null, lastSyncAt: null, error: null, counts: {} });
    expect(html).toContain("Create sync key");
    expect(html).toContain("Join with a key");
    expect(html).toContain('type="password"');
    expect(html).not.toContain("Copy key");
  });

  it("on: status, copy-only key, relay and what is synced", () => {
    const html = render({ phase: "idle", relay: "relay.example", lastSyncAt: Date.now(), error: null, counts: { profile: 3, memory: 12, page: 1, template: 0, worker: 2 } });
    expect(html).toContain("Synced just now");
    expect(html).toContain("Copy key");
    expect(html).toContain("relay.example");
    expect(html).toContain("12 memories · 1 page · 2 workers");
    expect(html).not.toContain("Create sync key");
  });

  it("error: says the relay is unreachable and why", () => {
    const html = render({ phase: "error", relay: "relay.example", lastSyncAt: null, error: "sync vault: 503 vault limit", counts: {} });
    expect(html).toContain("Can&#x27;t reach the relay");
    expect(html).toContain("503 vault limit");
  });
});
