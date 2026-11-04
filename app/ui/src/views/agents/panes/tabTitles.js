// Pill-title hooks for side-panel tabs whose text comes from data (a page's
// title, a view's, …). Each re-renders its pill when that data changes and
// fetches what a restored session reopened before the tab is first shown.

import { useEffect } from "react";
import { DELETED, getPage, usePagesVersion } from "../../../state/pagesStore.js";
import { fetchViewRecord, getViewRecord, useViewRecordsVersion, viewTitleOf } from "../../../genui/panel/viewRecords.js";
import { fetchWorkflowRun, getWorkflowRun, useWorkflowRunsVersion } from "../../../state/workflowRunsStore.js";
import { ensureArtifactCatalog, useArtifactCatalog } from "../../../state/artifactCatalogStore.js";
import { workflowNameOf } from "../../../lib/workflowRuns.js";
import { pageIdOf, viewIdOf, workflowRefOf, artifactSlugOf } from "../../../lib/panelTabs.js";

export function usePageTitle(id) {
  usePagesVersion();
  const page = getPage(pageIdOf(id));
  if (!page) return null;
  return page === DELETED ? "Deleted page" : page.title || "Untitled";
}

export function useViewTitle(id) {
  useViewRecordsVersion();
  const viewId = viewIdOf(id);
  useEffect(() => { if (!getViewRecord(viewId)) void fetchViewRecord(viewId); }, [viewId]);
  const title = viewTitleOf(viewId);
  return title ? `View · ${title}` : null;
}

export function useWorkflowTitle(id) {
  useWorkflowRunsVersion();
  const { workerId, callId } = workflowRefOf(id) ?? {};
  useEffect(() => { if (workerId) void fetchWorkflowRun(workerId, callId); }, [workerId, callId]);
  const r = workerId ? getWorkflowRun(workerId, callId) : null;
  const name = r?.detail?.name ?? (r?.tool ? workflowNameOf(r.tool.input) : null);
  return name ? `Workflow · ${name}` : null;
}

export function useArtifactTitle(id, panelData) {
  const { artifacts } = useArtifactCatalog({ load: false });
  useEffect(() => { ensureArtifactCatalog(); }, []);
  const slug = artifactSlugOf(id);
  return artifacts.find((a) => a.slug === slug)?.title || panelData?.[id]?.title || null;
}
