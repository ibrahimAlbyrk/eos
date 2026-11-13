import { createWorkerListStore } from "./workerListStore.js";

// Each worker's subagents of the whole conversation in summary shape
// (lib/subagentSummary.js, each with its identity, spawn order), published by
// its mounted transcript (Messages). The side panel's Subagents tab and the
// Environment popover read the same list.
const store = createWorkerListStore();

export const publishSubagents = store.publish;
export const getSubagents = store.get;
export const useSubagents = store.useList;

// The same transcript's loaded window as full subagents (collectSubagents:
// prompt, report, every tool): a subagent's detail reads it from here when
// the window holds all of it.
const loaded = createWorkerListStore();

export const publishLoadedSubagents = loaded.publish;
export const useLoadedSubagents = loaded.useList;
