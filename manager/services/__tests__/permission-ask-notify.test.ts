import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import { makePermissionAskNotify, type NotificationFire, type PermissionAskNotifyDeps } from "../permission-ask-notify.ts";
import type { WorkerRow, PendingPermissionRow } from "../../../contracts/src/worker.ts";

const orchestrator = { id: "w-top", name: "Orchestrator", parent_id: null } as unknown as WorkerRow;
const pending = {
  id: "p-1", worker_id: "w-top", tool_name: "Bash",
  input: JSON.stringify({ command: "git push origin main" }),
  created_at: 1, expires_at: 999, resolved: 0,
} as unknown as PendingPermissionRow;

function build(over: Partial<PermissionAskNotifyDeps> = {}) {
  const fired: NotificationFire[] = [];
  const notify = makePermissionAskNotify({
    findWorker: (id) => (id === "w-top" ? orchestrator : null),
    findPending: (id) => (id === "p-1" ? pending : null),
    fire: (n) => fired.push(n),
    now: () => 42,
    ...over,
  });
  const bus = createInMemoryEventBus();
  // The exact daemon subscriber predicate.
  bus.subscribe("pending:created", (msg) => notify(msg.payload as { id?: string; workerId?: string }));
  return { bus, fired };
}

describe("permission-ask notification (pending:created → notification:fire)", () => {
  it("names the asker, the tool and its command — top-level workers included", () => {
    const { bus, fired } = build();
    bus.publish("pending:created", { id: "p-1", workerId: "w-top" });
    assert.deepEqual(fired, [{
      title: "Approval needed",
      body: "Orchestrator wants to run Bash: git push origin main",
      workerId: "w-top",
      ts: 42,
    }]);
  });

  it("falls back to the worker id when the asker row is gone", () => {
    const { bus, fired } = build({ findWorker: () => null });
    bus.publish("pending:created", { id: "p-1", workerId: "w-top" });
    assert.equal(fired[0]?.body, "w-top wants to run Bash: git push origin main");
  });

  it("skips an ask that was already resolved, and a malformed payload", () => {
    const { bus, fired } = build({ findPending: () => null });
    bus.publish("pending:created", { id: "p-1", workerId: "w-top" });
    bus.publish("pending:created", { workerId: "w-top" });
    bus.publish("pending:created", { id: "p-1" });
    assert.equal(fired.length, 0);
  });
});
