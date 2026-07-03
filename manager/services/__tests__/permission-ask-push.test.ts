import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import { makePermissionAskPush, summarizePendingInput, type PermissionAskPushDeps } from "../permission-ask-push.ts";
import type { WorkerRow, PendingPermissionRow } from "../../../contracts/src/worker.ts";
import type { DispatchMessageInput } from "../../../core/src/use-cases/DispatchMessage.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

const child = { id: "w-child", name: "Alice", parent_id: "w-parent" } as unknown as WorkerRow;
const parent = { id: "w-parent", name: "Boss", parent_id: null } as unknown as WorkerRow;
const pending = {
  id: "p-1", worker_id: "w-child", tool_name: "Bash",
  input: JSON.stringify({ command: "git push origin main" }),
  created_at: 1, expires_at: 999, resolved: 0,
} as unknown as PendingPermissionRow;

function build(over: Partial<PermissionAskPushDeps> = {}) {
  const dispatched: DispatchMessageInput[] = [];
  const workers: Record<string, WorkerRow> = { "w-child": child, "w-parent": parent };
  const deps: PermissionAskPushDeps = {
    findWorker: (id) => workers[id] ?? null,
    findPending: (id) => (id === "p-1" ? pending : null),
    dispatch: async (input) => { dispatched.push(input); return {}; },
    log: noopLog,
    ...over,
  };
  const push = makePermissionAskPush(deps);
  const bus = createInMemoryEventBus();
  // The exact daemon subscriber predicate.
  bus.subscribe("pending:created", (msg) => push(msg.payload as { id?: string; workerId?: string }));
  return { bus, dispatched };
}

describe("summarizePendingInput", () => {
  it("prefers the command for Bash-family input, collapsed to one line", () => {
    assert.equal(summarizePendingInput(JSON.stringify({ command: "git\n  push" })), "git push");
  });
  it("falls back to file_path, then to the raw string", () => {
    assert.equal(summarizePendingInput(JSON.stringify({ file_path: "/a/b.ts" })), "/a/b.ts");
    assert.equal(summarizePendingInput("not json"), "not json");
  });
});

describe("permission-ask push (pending:created injector)", () => {
  it("pushes to the asker's DIRECT parent as a permission_ask envelope", async () => {
    const { bus, dispatched } = build();
    bus.publish("pending:created", { id: "p-1", workerId: "w-child" });
    await flush();
    assert.equal(dispatched.length, 1);
    const d = dispatched[0];
    assert.equal(d.workerId, "w-parent");
    assert.equal(d.queueWhenBusy, true);
    assert.equal(d.clientMsgId, "perm-ask:p-1");
    assert.equal(d.origin, "permission-ask");
    assert.deepEqual(d.envelope, {
      kind: "permission_ask", pendingId: "p-1", fromWorker: "w-child", workerName: "Alice",
      toolName: "Bash", inputSummary: "git push origin main", expiresAt: 999,
    });
    // The body names the asker + tool and points at list_pending_permissions.
    assert.match(d.text, /Alice \(w-child\).*Bash/s);
    assert.match(d.text, /list_pending_permissions/);
  });

  it("skips when the asker has no parent (top-level worker)", async () => {
    const { bus, dispatched } = build({ findWorker: (id) => (id === "w-child" ? ({ ...child, parent_id: null } as WorkerRow) : null) });
    bus.publish("pending:created", { id: "p-1", workerId: "w-child" });
    await flush();
    assert.equal(dispatched.length, 0);
  });

  it("skips when the parent row is gone", async () => {
    const { bus, dispatched } = build({ findWorker: (id) => (id === "w-child" ? child : null) });
    bus.publish("pending:created", { id: "p-1", workerId: "w-child" });
    await flush();
    assert.equal(dispatched.length, 0);
  });

  it("skips when the pending row was already resolved/expired away", async () => {
    const { bus, dispatched } = build({ findPending: () => null });
    bus.publish("pending:created", { id: "p-1", workerId: "w-child" });
    await flush();
    assert.equal(dispatched.length, 0);
  });

  it("ignores a malformed payload (missing id or workerId)", async () => {
    const { bus, dispatched } = build();
    bus.publish("pending:created", { workerId: "w-child" });
    bus.publish("pending:created", { id: "p-1" });
    await flush();
    assert.equal(dispatched.length, 0);
  });
});
