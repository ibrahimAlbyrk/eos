import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import { SpawnOrchestratorRequestSchema, MessageRequestSchema, IntegrateWorkersRequestSchema } from "../../contracts/src/http.ts";
import type { IntegrateWorkerResult, IntegrateWorkersResponse } from "../../contracts/src/http.ts";
import { spawnWorker } from "../../core/src/use-cases/SpawnWorker.ts";
import { dispatchMessage } from "../../core/src/use-cases/DispatchMessage.ts";
import { randomOrchestratorName } from "../shared/names.ts";
import { expandPath } from "../shared/path.ts";
import { appendSynthesized } from "../shared/synthesized-events.ts";
import { resumeIfDead } from "./resume-helpers.ts";
import { dispatchDeps } from "./dispatch-deps.ts";
import { resolveSpawnBackend, spawnBackendError } from "../shared/spawn-backend.ts";

export function registerOrchestratorRoutes(r: Router, c: Container): void {
  r.get("/orchestrators", ({ res }) => {
    writeJson(res, 200, c.workers.listOrchestrators());
  });

  r.post("/orchestrators", async ({ req, res }) => {
    const body = validate(SpawnOrchestratorRequestSchema, await readBody(req));
    const name = (body.name ?? "").trim() || randomOrchestratorName();
    const cwd = expandPath(body.cwd);
    const id = c.ids.newOrchestratorId();
    const rb = await resolveSpawnBackend(c, { explicitKind: body.backendKind, isOrchestrator: true });
    const backend = c.backends.has(rb.kind) ? c.backends.get(rb.kind) : c.claudeCliBackend;
    const backendErr = spawnBackendError(backend, rb, !!body.backendKind);
    if (backendErr) { writeJson(res, 400, { error: backendErr }); return; }
    const result = await spawnWorker(
      {
        workers: c.workers, events: c.events, bus: c.bus,
        supervisor: c.supervisor, ports: c.portAllocator,
        clock: c.clock, ids: c.ids, log: c.log,
        buildArgs: c.buildArgs, buildEnv: c.buildEnv, logFileFor: c.logFileFor,
        backend,
        worktrees: c.worktrees,
        onAgentEvent: c.onAgentEvent,
        recents: c.recents,
        caps: c.modelCatalog,
      },
      {
        prompt: body.prompt ?? "",
        cwd,
        name,
        // A human-supplied name is 'user' (never auto-renamed); the random default
        // is 'default' — the auto-name micro-task's only eligible state.
        nameSource: body.name?.trim() ? "user" : "default",
        fixedId: id,
        persistent: true,
        claudePermissionMode: body.permissionMode ?? "acceptEdits",
        // Profile-model providers carry their own model; request-model providers
        // (claude-sdk/claude-cli) run the user-picked Claude model.
        model: backend.descriptor.modelSource === "profile" ? rb.model : (body.model ?? "opus"),
        effort: body.effort ?? "xhigh",
        isOrchestrator: true,
        backendProfile: rb.profileName ?? undefined,
      },
    );
    if (body.prompt) {
      appendSynthesized(c, id, "user_message", { text: body.prompt });
    }
    writeJson(res, 201, { ...result, name });
  });

  r.post(/^\/orchestrators\/(?<id>[^/]+)\/message$/, async ({ params, req, res }) => {
    const body = validate(MessageRequestSchema, await readBody(req));
    const target = c.workers.findById(params.id);
    if (target) await resumeIfDead(c, target);
    const result = await dispatchMessage(
      dispatchDeps(c, { requireOrchestrator: true, excerptLimit: 500 }),
      {
        workerId: params.id, text: body.text,
        clientMsgId: body.clientMsgId, queueWhenBusy: body.queueWhenBusy,
        origin: "dashboard",
      },
    );
    writeJson(res, result.status, result.body);
  });

  // Fan-in: merge the orchestrator's workers' worktree branches into its own
  // checkout. Disjoint work auto-merges as unstaged edits; a genuine overlap is
  // materialized with conflict markers + unmerged index → the dashboard conflict
  // view. Ownership-scoped (integrates :id's own workers), loopback-trusted like
  // the other agent-plane routes; nothing is committed, so it is reversible.
  r.post(/^\/orchestrators\/(?<id>[^/]+)\/integrate$/, async ({ params, req, res }) => {
    const orch = c.workers.findById(params.id);
    if (!orch) { writeJson(res, 404, { error: "orchestrator not found" }); return; }
    const checkout = orch.worktree_dir ?? orch.cwd ?? orch.worktree_from;
    if (!checkout) { writeJson(res, 400, { error: "orchestrator has no working directory" }); return; }
    const body = validate(IntegrateWorkersRequestSchema, await readBody(req));
    const filter = body.ids ? new Set(body.ids) : null;

    const busy = new Set(["SPAWNING", "WORKING", "KILLING", "ENDING"]);
    const children = c.workers.listByParent(params.id).filter((w) => !filter || filter.has(w.id));
    const nameById = new Map(children.map((w) => [w.id, w.name ?? null]));

    const refs: Array<{ repoRoot: string; worktreeDir: string | null; branch: string; workerId: string }> = [];
    const preSkipped: IntegrateWorkerResult[] = [];
    for (const w of children) {
      const skip = (reason: string): void => {
        preSkipped.push({ workerId: w.id, name: w.name ?? null, branch: w.branch ?? null, outcome: "skipped", files: [], reason });
      };
      if (!w.worktree_from || !w.branch) { skip("no worktree branch"); continue; }
      if (busy.has(w.state)) { skip("busy"); continue; }
      if (!w.worktree_dir || !w.workspace_ready) { skip("worktree not ready"); continue; }
      refs.push({ repoRoot: w.worktree_from, worktreeDir: w.worktree_dir, branch: w.branch, workerId: w.id });
    }

    const merge = await c.branchMerge.mergeAll(checkout, refs);
    const branch = await c.git.currentBranch(checkout);

    const workers: IntegrateWorkerResult[] = [
      ...merge.results.map((rr) => ({
        workerId: rr.workerId, name: nameById.get(rr.workerId) ?? null,
        branch: rr.branch, outcome: rr.outcome, files: rr.files, reason: rr.reason,
      })),
      ...preSkipped,
    ];

    const count = (o: string): number => workers.filter((w) => w.outcome === o).length;
    const mergedN = count("merged"); const conflictedN = count("conflicted");
    const pendingN = count("pending"); const skippedN = count("skipped");
    const parts: string[] = [];
    if (!merge.ok) {
      parts.push(`Integration failed: ${merge.detail ?? "git error"}`);
    } else if (mergedN === 0 && conflictedN === 0) {
      parts.push("Nothing to integrate.");
    } else {
      if (mergedN > 0) parts.push(`Merged ${mergedN} worker${mergedN === 1 ? "" : "s"} (${merge.mergedFiles.length} files)${branch ? ` into ${branch}` : ""}.`);
      if (conflictedN > 0) parts.push(`Conflict in ${merge.conflictedFiles.length} file(s) — resolve in the dashboard conflict view, then re-run.${pendingN > 0 ? ` ${pendingN} worker(s) pending behind it.` : ""}`);
    }
    if (skippedN > 0) parts.push(`${skippedN} skipped.`);

    const response: IntegrateWorkersResponse = {
      ok: merge.ok, checkout, branch, workers,
      mergedFiles: merge.mergedFiles, conflictedFiles: merge.conflictedFiles,
      message: parts.join(" "),
    };
    appendSynthesized(c, params.id, "workers_integrated", {
      merged: mergedN, conflicted: conflictedN, pending: pendingN, skipped: skippedN,
      mergedFiles: merge.mergedFiles, conflictedFiles: merge.conflictedFiles,
    });
    writeJson(res, 200, response);
  });
}
