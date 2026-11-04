// File transfers between the user's Macs (transfer:change).

import type { TransferChangeEvent } from "../../../../contracts/src/transfer.ts";
import { transferJobFields } from "../../../../core/src/domain/background-jobs.ts";
import type { JobRegistry } from "../JobRegistry.ts";

export function transferJobs(jobs: JobRegistry, deps: { cancel(id: string): void; machineName(ref: string): string }) {
  return {
    onTransfer(change: TransferChangeEvent): void {
      for (const id of change.removed ?? []) jobs.get("transfer", null, id)?.drop();
      const t = change.transfer;
      if (!t) return;
      const fields = transferJobFields(t, deps.machineName);
      let h = jobs.get("transfer", null, t.id);
      // A transfer that ended before the registry saw it is history, not a job.
      if (!h && fields.status !== "running") return;
      const patch = { title: fields.title, detail: fields.detail, progress: fields.progress };
      if (!h) {
        h = jobs.start({
          kind: "transfer", workerId: null, ref: t.id, title: fields.title, startedAt: t.startedAt ?? t.createdAt,
          stop: () => {
            try { deps.cancel(t.id); return { ok: true }; }
            catch (err) { return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) }; }
          },
        });
        // Listed under the chat that sent it, when an agent did.
        Object.assign(patch, { workerId: t.origin.agentId ?? null });
      }
      if (fields.status === "running") h.update(patch);
      else h.finish(fields.status, { ...patch, progress: null });
    },
  };
}
