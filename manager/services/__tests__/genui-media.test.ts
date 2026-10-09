import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGenuiMedia, genuiUserAgent, locationSharingOn } from "../genui/media.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";

const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };

describe("buildGenuiMedia", () => {
  it("wires media, map, geocoder, places and location under the home dir", () => {
    const home = mkdtempSync(join(tmpdir(), "eos-genui-"));
    const out = buildGenuiMedia({
      home,
      clock: { now: () => 0 },
      log,
      appHost: { isRegistered: () => false, rpc: async () => null },
      userSettings: { read: () => ({}) },
    });
    for (const k of ["media", "map", "geocoder", "places", "location"] as const) assert.ok(out[k], k);
    assert.equal(out.location.sharing(), false);
    assert.equal(out.location.connected(), false);
  });

  it("reads location sharing as off unless it is literally true", () => {
    assert.equal(locationSharingOn({ read: () => ({}) }), false);
    assert.equal(locationSharingOn({ read: () => ({ "location.share": "true" }) }), false);
    assert.equal(locationSharingOn({ read: () => ({ "location.share": true }) }), true);
  });

  it("identifies itself to OpenStreetMap", () => {
    assert.equal(genuiUserAgent("1.2.3"), "Eos/1.2.3 (+local desktop app)");
  });
});
