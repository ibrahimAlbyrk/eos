import { createWorkerListStore } from "./workerListStore.js";

// Each worker's published claude.ai artifacts (lib/artifactLink.js
// collectArtifacts), published by its mounted transcript (Messages) for the
// Environment popover's Artifacts section.
const store = createWorkerListStore();

export const publishArtifacts = store.publish;
export const useArtifacts = store.useList;
