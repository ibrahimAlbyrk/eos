// Permission-ask push (design: a pending ask no longer goes unnoticed). When a
// worker's tool call parks on a policy `ask` rule the gateway publishes
// "pending:created"; this injector nudges the asking worker's DIRECT parent — the
// session that can act on the ask — with a <system_message kind="permission_ask">.
// Mirrors the dynamic-loop / report-reminder injectors: it dispatches through the
// shared dispatchMessage chokepoint (queueWhenBusy so it never steers a mid-turn
// parent) with an idempotent clientMsgId.
//
// Target = asker.parent_id, matching list_pending_permissions' parentId scope (a
// session sees only its DIRECT children's asks). The push carries no resolve/expiry
// follow-up, so the prompt tells the receiver to confirm via list_pending_permissions.

import type { WorkerRow, PendingPermissionRow } from "../../contracts/src/worker.ts";
import type { DispatchMessageInput } from "../../core/src/use-cases/DispatchMessage.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";

export interface PermissionAskPushDeps {
  findWorker(id: string): WorkerRow | null;
  findPending(id: string): PendingPermissionRow | null;
  dispatch(input: DispatchMessageInput): Promise<unknown>;
  log: Logger;
}

// Collapse a pending row's JSON-encoded tool input into one short line for the tag
// attribute + body. Prefer the command (Bash-family) or file path when present;
// otherwise the raw input string. Kept single-line + truncated so it stays a clean
// attribute value.
export function summarizePendingInput(input: string): string {
  const clean = (s: string): string => truncate(s.replace(/\s+/g, " ").trim(), 160);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return clean(input);
  }
  if (parsed && typeof parsed === "object") {
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.command === "string" && rec.command.trim()) return clean(rec.command);
    if (typeof rec.file_path === "string" && rec.file_path.trim()) return clean(rec.file_path);
  }
  return clean(input);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// The bus handler for "pending:created" ({ id, workerId }). Resolves the direct
// parent, builds the body + envelope, and dispatches. A missing asker/parent/pending
// row is a silent skip (a dead asker, a top-level worker with no parent, or an ask
// resolved between publish and here) — a best-effort nudge, not a guarantee.
export function makePermissionAskPush(
  deps: PermissionAskPushDeps,
): (payload: { id?: string; workerId?: string }) => void {
  return (payload) => {
    if (!payload?.id || !payload.workerId) return;
    const asker = deps.findWorker(payload.workerId);
    const parentId = asker?.parent_id;
    if (!parentId || !deps.findWorker(parentId)) return;
    const row = deps.findPending(payload.id);
    if (!row) return;

    const askerName = asker?.name ?? payload.workerId;
    const summary = summarizePendingInput(row.input);
    const body =
      `Worker ${askerName} (${payload.workerId}) is blocked waiting for permission to run ${row.tool_name}` +
      `${summary ? `: ${summary}` : ""}. It cannot proceed until the ask is approved in the dashboard or ` +
      `cleared by a policy rule. Before surfacing it to the operator, confirm it is still pending with ` +
      `list_pending_permissions — by the time you read this the ask may already have been resolved or ` +
      `expired, and no further signal is sent when it clears.`;

    void deps
      .dispatch({
        workerId: parentId,
        text: body,
        displayText: body,
        envelope: {
          kind: "permission_ask",
          pendingId: payload.id,
          fromWorker: payload.workerId,
          ...(asker?.name ? { workerName: asker.name } : {}),
          toolName: row.tool_name,
          ...(summary ? { inputSummary: summary } : {}),
          expiresAt: row.expires_at,
        },
        queueWhenBusy: true,
        clientMsgId: `perm-ask:${payload.id}`,
        origin: "permission-ask",
      })
      .catch((e) =>
        deps.log.warn("permission-ask push failed", {
          pendingId: payload.id,
          parentId,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
  };
}
