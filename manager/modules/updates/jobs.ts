// A new version downloading or being prepared, in the Jobs list; gone once it's
// ready or failed (the update beacon carries it from there).

import type { UpdateState } from "../../../contracts/src/update.ts";
import type { JobRegistry } from "../../services/jobs/JobRegistry.ts";

export function updateJobs(jobs: JobRegistry) {
  return {
    onUpdate(state: UpdateState): void {
      const { phase, version, done, bytes } = state.status;
      const existing = jobs.get("update", null, "update");
      if (phase !== "downloading" && phase !== "staging") {
        existing?.drop();
        return;
      }
      const h = existing ?? jobs.start({ kind: "update", workerId: null, ref: "update", title: `Downloading Eos ${version}`, ambient: true });
      h.update({
        title: phase === "staging" ? `Preparing Eos ${version}` : `Downloading Eos ${version}`,
        detail: phase === "staging" ? "Building the new version beside this one" : null,
        progress: phase === "downloading" && bytes ? { done: done ?? 0, total: bytes } : null,
      }, !existing);
    },
  };
}
