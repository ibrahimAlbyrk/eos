import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROUTES } from "../http.ts";

const EXPECTED_KEYS = [
  "health", "stream", "workers", "worker", "workerEvents", "workerMessage",
  "workerQueue", "workerQueueItem",
  "workerAction", "workerPush", "workerPushState", "workerPull",
  "orchestrators", "orchestratorMessage", "orchestratorIntegrate",
  "orchestratorLoop", "orchestratorLoopStop", "policyDecide", "policyRule",
  "pending", "pendingDecision", "metrics", "datetime", "uiConfig",
  "pickDirectory", "pickFile", "fsDefaultApp", "fsOpen", "fsIcon",
  "fsBranches", "fsUnpushed", "fsCommit", "fsRecents", "fsReveal", "fsRead", "fsList", "fsImage",
  "fsRaw", "pdfjs",
  "fsCheckout", "fsBranchCreate", "fsBranchRename", "fsBranchDelete", "fsFetch", "fsRemoteBranchDelete",
  "fsWrite", "fsPaste", "fsStat", "fsCreate", "fsRename", "fsMove", "fsTrash", "fsWatch", "fsUnwatch",
  "workerName", "workerRenameIntent", "workerOpen", "workerPermission",
  "workerModel", "workerBackend", "workerDiff", "workerChanges", "workerFileDiff", "workerChangesDiscard",
  "workerConflicts", "workerConflictFile", "workerConflictResolve",
  "workerMemory", "workerMemoryItem",
  "workerInterrupt", "workerResume", "workerKeystroke",
  "workerQuestion", "workerQuestionPoll", "workerQuestionAnswer",
  "workerPeers", "workerPeerRequest", "workerPeerRequestPoll", "workerPeerResponse",
  "workerNotify", "workerReport", "workerExport", "workerStepOutput", "workerRewindTargets", "workerRewind",
  "workerTerminal", "terminal", "terminalKill",
  "workerTryPreview", "workerTryState", "workerTry", "workerTryKeep", "workerTryDiscard",
  "commands",
  "templates", "template", "prompts", "promptPreview", "workerDefinitions",
  "workflows", "workflowCatalog", "workflowDefinitions", "workflowRuns", "workflowRun",
  "workflowRunSteps", "workflowDefinition", "settings",
  "updateStatus", "updateCheck", "updateApply", "updateDefer",
  "remotePair", "remoteStatus", "remoteArm",
  "apiBackends", "apiBackendPresets", "apiBackendModels",
] as const;

describe("ROUTES completeness", () => {
  it("has entries for all expected endpoints", () => {
    for (const key of EXPECTED_KEYS) {
      assert.ok(key in ROUTES, `missing ROUTES.${key}`);
    }
  });

  it("has no ROUTES key missing from EXPECTED_KEYS", () => {
    const expected = new Set<string>(EXPECTED_KEYS);
    for (const key of Object.keys(ROUTES)) {
      assert.ok(expected.has(key), `ROUTES.${key} added without updating EXPECTED_KEYS`);
    }
  });

  it("every value is a string starting with / (or a function returning one)", () => {
    for (const [key, val] of Object.entries(ROUTES)) {
      if (typeof val === "string") {
        assert.ok(val.startsWith("/"), `ROUTES.${key} = "${val}" does not start with /`);
      } else if (typeof val === "function") {
        const result = val("test-id");
        assert.equal(typeof result, "string", `ROUTES.${key}("test-id") did not return a string`);
        assert.ok(result.startsWith("/"), `ROUTES.${key}("test-id") = "${result}" does not start with /`);
      } else {
        assert.fail(`ROUTES.${key} is neither string nor function`);
      }
    }
  });

  it("no duplicate static values", () => {
    const statics = Object.entries(ROUTES)
      .filter(([, v]) => typeof v === "string")
      .map(([, v]) => v as string);
    const unique = new Set(statics);
    assert.equal(statics.length, unique.size, `duplicate static routes: ${statics.filter((v, i) => statics.indexOf(v) !== i)}`);
  });
});
