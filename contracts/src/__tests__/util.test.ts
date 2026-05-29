import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { errMsg, WORKER_EXIT, isWorkerSuccessExit } from "../util.ts";

describe("errMsg", () => {
  it("returns the message from an Error instance", () => {
    assert.equal(errMsg(new Error("x")), "x");
  });

  it("returns a plain string unchanged", () => {
    assert.equal(errMsg("plain"), "plain");
  });

  it("stringifies a non-Error object without throwing", () => {
    assert.equal(errMsg({}), String({}));
  });

  it("stringifies undefined without throwing", () => {
    assert.equal(errMsg(undefined), String(undefined));
  });
});

describe("WORKER_EXIT", () => {
  it("maps exit codes to documented values", () => {
    assert.equal(WORKER_EXIT.SUCCESS, 0);
    assert.equal(WORKER_EXIT.GRACEFUL_SHUTDOWN, 129);
    assert.equal(WORKER_EXIT.KILLED, 143);
    assert.equal(WORKER_EXIT.INTERRUPTED, 130);
  });
});

describe("isWorkerSuccessExit", () => {
  it("treats SUCCESS (0) and GRACEFUL_SHUTDOWN (129) as success", () => {
    assert.equal(isWorkerSuccessExit(0), true);
    assert.equal(isWorkerSuccessExit(129), true);
  });

  it("treats KILLED (143), INTERRUPTED (130) and generic failure (1) as failure", () => {
    assert.equal(isWorkerSuccessExit(143), false);
    assert.equal(isWorkerSuccessExit(130), false);
    assert.equal(isWorkerSuccessExit(1), false);
  });
});
