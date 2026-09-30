import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLocalOnlyRoute } from "../route-planes.ts";

describe("isLocalOnlyRoute", () => {
  it("keeps the worker/hook plane and native pickers local", () => {
    assert.ok(isLocalOnlyRoute("POST", "/workers/w1/events"));
    assert.ok(isLocalOnlyRoute("POST", "/policy/decide"));
    assert.ok(isLocalOnlyRoute("GET", "/workers/w1/question/q9"));
    assert.ok(isLocalOnlyRoute("GET", "/pick-directory?start=/tmp"));
  });

  it("keeps peering management local, including chaining through /h/", () => {
    for (const [m, p] of [["GET", "/api/peer"], ["POST", "/api/peer/invite"], ["DELETE", "/api/peer/devices/ab"],
      ["GET", "/api/hosts"], ["POST", "/api/hosts/x/reconnect"], ["GET", "/h/abc/workers"], ["POST", "/peer/pair"], ["POST", "/peer/reverse"],
      ["PUT", "/api/remote/config"]] as const) {
      assert.ok(isLocalOnlyRoute(m, p), `${m} ${p}`);
    }
  });

  it("lets the UI plane through", () => {
    for (const [m, p] of [["GET", "/workers"], ["GET", "/stream?clientId=x"], ["POST", "/workers/w1/message"],
      ["GET", "/workers/w1/events"], ["POST", "/workers/w1/question-answer"], ["POST", "/pty/p1/input"],
      ["GET", "/api/host"], ["POST", "/workers/w1/keystroke"], ["GET", "/fs/raw/Users/me/a.png"]] as const) {
      assert.equal(isLocalOnlyRoute(m, p), false, `${m} ${p}`);
    }
  });

  it("matches the method, not just the path", () => {
    assert.equal(isLocalOnlyRoute("GET", "/workers/w1/report"), false);
    assert.ok(isLocalOnlyRoute("POST", "/workers/w1/report"));
  });
});
