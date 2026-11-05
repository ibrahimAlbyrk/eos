// What the daemon refuses to let cross to another computer, composed the way the
// container does it: the kernel's rules plus each feature module's own.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeRouteAccess } from "../routes/route-access.ts";
import { ARTIFACT_ROUTE_ACCESS } from "../modules/artifacts/routes.ts";
import { LOCATION_ROUTE_ACCESS } from "../modules/genui/location-routes.ts";
import { SYNC_ROUTE_ACCESS } from "../modules/sync/routes.ts";
import { TRANSFER_ROUTE_ACCESS } from "../modules/transfer/routes.ts";
import { UPDATE_ROUTE_ACCESS } from "../modules/updates/routes.ts";
import { WORKFLOW_RUN_ROUTE_ACCESS } from "../modules/workflow-runs/routes.ts";

const access = composeRouteAccess([
  ARTIFACT_ROUTE_ACCESS, LOCATION_ROUTE_ACCESS, SYNC_ROUTE_ACCESS, TRANSFER_ROUTE_ACCESS, UPDATE_ROUTE_ACCESS, WORKFLOW_RUN_ROUTE_ACCESS,
]);
const { isLocalOnly, classifyRemote } = access;

describe("route access — local-only", () => {
  it("keeps the kernel's worker/hook plane and peering local", () => {
    assert.ok(isLocalOnly("POST", "/workers/w1/events"));
    assert.ok(isLocalOnly("GET", "/api/hosts"));
  });

  it("keeps this Mac's own updates local: no other computer updates or restarts it", () => {
    for (const [m, p] of [["GET", "/api/update"], ["POST", "/api/update/check"], ["POST", "/api/update/restart"],
      ["POST", "/api/update/dismiss"], ["PUT", "/api/settings/updates"]] as const) {
      assert.ok(isLocalOnly(m, p), `${m} ${p}`);
    }
    assert.equal(isLocalOnly("PUT", "/api/settings/archive"), false);
  });

  it("keeps this Mac's transfer engine local; each Mac's own endpoint crosses", () => {
    for (const [m, p] of [["GET", "/api/transfers"], ["POST", "/api/transfers"], ["POST", "/api/transfers/tr-abcdefgh/cancel"],
      ["POST", "/api/transfers/destination"], ["POST", "/workers/w1/transfers"], ["GET", "/workers/w1/transfers/tr-abcdefgh"]] as const) {
      assert.ok(isLocalOnly(m, p), `${m} ${p}`);
    }
    for (const [m, p] of [["GET", "/transfer/list?path=/Users"], ["PUT", "/transfer/write?id=tr-abcdefgh"], ["POST", "/transfer/commit"]] as const) {
      assert.equal(isLocalOnly(m, p), false, `${m} ${p}`);
    }
  });

  it("keeps the sync key, artifacts and this Mac's location local; visual-answer routes cross", () => {
    for (const [m, p] of [["GET", "/api/sync"], ["POST", "/api/sync/join"], ["GET", "/api/artifacts"], ["POST", "/api/artifacts/refresh"],
      ["GET", "/api/location"]] as const) {
      assert.ok(isLocalOnly(m, p), `${m} ${p}`);
    }
    for (const [m, p] of [["POST", "/api/genui/views"], ["GET", "/api/genui/views/v_7Hq2abcdEFGH"], ["PUT", "/api/genui/views/v_7Hq2abcdEFGH/state"],
      ["GET", "/api/genui/media/img?src=https://a.example/x.jpg"], ["GET", "/api/genui/map/t/planet/1/2/3.pbf"], ["POST", "/api/genui/places"]] as const) {
      assert.equal(isLocalOnly(m, p), false, `${m} ${p}`);
    }
  });
});

describe("route access — the phone's tiers", () => {
  it("keeps the kernel's table", () => {
    assert.deepEqual(classifyRemote("POST", "/workers/abc/message"), { tier: "LOW", uiToken: false });
    assert.equal(classifyRemote("POST", "/workers/abc/events").tier, "REFUSED");
  });

  it("adds a feature's routes, and refuses what no one listed", () => {
    assert.deepEqual(classifyRemote("GET", "/workers/w1/workflow-runs/c1/agents/a1"), { tier: "READ", uiToken: false });
    assert.deepEqual(classifyRemote("POST", "/workers/w1/workflow-runs/c1/stop"), { tier: "LOW", uiToken: true });
    assert.equal(classifyRemote("GET", "/api/transfers").tier, "REFUSED");
  });
});
