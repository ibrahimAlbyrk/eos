import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isWorkerLive } from "../worker-liveness.ts";
import type { Container } from "../../container.ts";

function fakeContainer(opts: {
  supervised?: Set<string>;
  backendKind?: string | null;
  processModel?: "in-process" | "out-of-process";
  alive?: boolean;
}): Container {
  const { supervised = new Set(), backendKind = null, processModel = "out-of-process", alive = false } = opts;
  const backend = {
    descriptor: { processModel },
    attach: () => ({ isAlive: () => alive }),
  };
  return {
    supervisor: { has: (id: string) => supervised.has(id) },
    workers: { findById: () => ({ backend_kind: backendKind }) },
    backends: { has: (k: string) => k === backendKind, get: () => backend },
  } as unknown as Container;
}

describe("isWorkerLive — backend-agnostic liveness", () => {
  it("a supervised PTY child is live", () => {
    assert.equal(isWorkerLive(fakeContainer({ supervised: new Set(["w1"]) }), "w1"), true);
  });

  it("an in-process backend with a live session is live (no supervised child)", () => {
    const c = fakeContainer({ backendKind: "claude-sdk", processModel: "in-process", alive: true });
    assert.equal(isWorkerLive(c, "w1"), true);
  });

  it("an in-process backend with a dead session is not live", () => {
    const c = fakeContainer({ backendKind: "claude-sdk", processModel: "in-process", alive: false });
    assert.equal(isWorkerLive(c, "w1"), false);
  });

  it("an out-of-process backend not in the supervisor is not live", () => {
    const c = fakeContainer({ backendKind: "claude-cli", processModel: "out-of-process" });
    assert.equal(isWorkerLive(c, "w1"), false);
  });

  it("a missing backend_kind, unsupervised, is not live", () => {
    assert.equal(isWorkerLive(fakeContainer({ backendKind: null }), "w1"), false);
  });
});
