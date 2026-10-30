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
    assert.equal(out.location.sharing(), true);
    assert.equal(out.location.connected(), false);
  });

  it("reads location sharing as on unless it is turned off", () => {
    assert.equal(locationSharingOn({ read: () => ({}) }), true);
    assert.equal(locationSharingOn({ read: () => ({ "location.share": "false" }) }), true);
    assert.equal(locationSharingOn({ read: () => ({ "location.share": false }) }), false);
  });

  it("identifies itself to OpenStreetMap", () => {
    assert.equal(genuiUserAgent("1.2.3"), "Eos/1.2.3 (+local desktop app)");
  });
});
