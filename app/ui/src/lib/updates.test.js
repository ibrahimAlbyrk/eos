import { describe, expect, it } from "vitest";
import { beaconOf, noticeText, progressOf, releaseNotesUrl, statusCardOf, workingAgents } from "./updates.js";

const status = (phase, over = {}) => ({ phase, off: null, version: null, bytes: null, done: null, full: null, agents: null, error: null, ...over });
const state = (s, over = {}) => ({ current: "0.1.2", status: s, lastCheckedAt: null, autoDownload: true, notes: null, notice: null, ...over });

describe("update beacon", () => {
  it("stays hidden while up to date or after a quiet failed check", () => {
    expect(beaconOf(null)).toBe(null);
    expect(beaconOf(state(status("idle")))).toBe(null);
    expect(beaconOf(state(status("off", { off: "dev-build" })))).toBe(null);
    expect(beaconOf(state(status("error", { error: "offline" })))).toBe(null);
  });

  it("shows a download's progress, then the update", () => {
    expect(beaconOf(state(status("downloading", { version: "0.1.3", bytes: 200, done: 50 })))).toEqual({ kind: "downloading", label: "0.1.3", progress: 0.25 });
    expect(beaconOf(state(status("ready", { version: "0.1.3" })))).toEqual({ kind: "ready", label: "Update" });
    expect(beaconOf(state(status("checking", { version: "0.1.3" })))).toEqual({ kind: "ready", label: "Update" });
    expect(beaconOf(state(status("waiting", { version: "0.1.3", agents: 2 }))).label).toBe("After 2 agents");
  });

  it("reports how the last restart ended until dismissed", () => {
    expect(beaconOf(state(status("idle"), { notice: { kind: "updated", version: "0.1.3", from: "0.1.2" } }))).toEqual({ kind: "updated", label: "Updated to 0.1.3" });
    expect(beaconOf(state(status("idle"), { notice: { kind: "rolled-back", version: "0.1.3", from: "0.1.2" } })).kind).toBe("error");
    expect(noticeText({ kind: "rolled-back", version: "0.1.3", from: "0.1.2" }).title).toBe("Eos 0.1.3 didn't start");
  });
});

describe("settings status card", () => {
  it("explains why updates are off", () => {
    expect(statusCardOf(state(status("off", { off: "dev-build" }), { current: null })).detail).toMatch(/built from source/);
    expect(statusCardOf(state(status("off", { off: "read-only" }))).detail).toMatch(/Applications/);
  });

  it("offers the next step for each phase", () => {
    expect(statusCardOf(state(status("idle"))).action).toBe("check");
    expect(statusCardOf(state(status("available", { version: "0.1.3" }))).action).toBe("download");
    expect(statusCardOf(state(status("ready", { version: "0.1.3", bytes: 838_861 }))).detail).toBe("819 KB downloaded in the background — only what changed");
    expect(statusCardOf(state(status("downloading", { version: "0.1.3", bytes: 2_097_152, done: 1_048_576 }))).detail).toBe("1.0 MB of 2.0 MB · only what changed");
    expect(statusCardOf(state(status("error", { version: "0.1.3", error: "signature broke" }))).title).toBe("Couldn't update to 0.1.3");
  });
});

describe("update helpers", () => {
  it("counts only top-level agents in a turn", () => {
    expect(workingAgents([
      { id: "a", parent_id: null, state: "WORKING" },
      { id: "b", parent_id: "a", state: "WORKING" },
      { id: "c", parent_id: null, state: "IDLE" },
    ]).map((w) => w.id)).toEqual(["a"]);
  });

  it("links a version's release notes and measures progress", () => {
    expect(releaseNotesUrl("0.1.3")).toBe("https://github.com/ibrahimAlbyrk/eos/releases/tag/v0.1.3");
    expect(progressOf(status("staging"))).toBe(1);
    expect(progressOf(status("downloading", { bytes: 0 }))).toBe(0);
  });
});
