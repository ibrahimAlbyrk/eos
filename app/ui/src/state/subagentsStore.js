import { createWorkerListStore } from "./workerListStore.js";

// Each worker's subagents (identity-carrying agentRuns, spawn order), published
// by its mounted transcript (Messages). The side panel's Subagents tab and the
// Environment popover read the same list.
const store = createWorkerListStore();

export const publishSubagents = store.publish;
export const getSubagents = store.get;
export const useSubagents = store.useList;
