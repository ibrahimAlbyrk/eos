// A sync pass (sync:change) — shown only once it outlasts showMs, so a quick
// pass never flickers in.

import type { SyncStatusResponse } from "../../../../contracts/src/sync.ts";
import type { JobRegistry } from "../JobRegistry.ts";

export function syncJobs(jobs: JobRegistry, deps: { showMs?: number } = {}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    onSync(status: SyncStatusResponse): void {
      if (status.phase !== "syncing") {
        if (timer) clearTimeout(timer);
        timer = null;
        jobs.get("sync", null, "sync")?.drop();
        return;
      }
      if (timer || jobs.get("sync", null, "sync")) return;
      timer = setTimeout(() => {
        timer = null;
        jobs.start({ kind: "sync", workerId: null, ref: "sync", title: "Syncing", ambient: true }).update({}, true);
      }, deps.showMs ?? 1500);
    },
    dispose(): void {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
