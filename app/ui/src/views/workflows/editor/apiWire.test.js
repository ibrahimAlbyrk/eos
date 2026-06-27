import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "../../../api/client.js";
import { ROUTES } from "../../../api/routes.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body = { ok: true }) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("workflow editor API wire contract", () => {
  it("saveWorkflow PUTs the v2 graph to /workflows?owner=operator", async () => {
    const fetchMock = stubFetch({ name: "demo" });
    const graph = { name: "demo", version: 2, nodes: [{ id: "input", kind: "input" }], edges: [] };
    await api.saveWorkflow(graph);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(`${ROUTES.workflows}?owner=operator`);
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual(graph);
  });

  it("exposes NO runWorkflow client method — the editor only saves; runs are agent/CLI-launched", () => {
    // Run-removal contract: the UI never launches a workflow. The only run-write op
    // the UI keeps is stopWorkflowRun (the Runs view's Stop).
    expect(api.runWorkflow).toBeUndefined();
    expect(typeof api.saveWorkflow).toBe("function");
    expect(typeof api.stopWorkflowRun).toBe("function");
  });

  it("getWorkflowCatalog GETs the catalog route", async () => {
    const fetchMock = stubFetch({ nodeKinds: [], transformFns: [] });
    await api.getWorkflowCatalog();
    expect(fetchMock.mock.calls[0][0]).toContain(ROUTES.workflowCatalog);
  });

  it("listWorkflowDefinitions GETs the definitions route with the owner query", async () => {
    const fetchMock = stubFetch([]);
    const body = await api.listWorkflowDefinitions();
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain(ROUTES.workflowDefinitions);
    expect(url).toContain("owner=operator");
    expect(body).toEqual([]);
  });

  it("deleteWorkflow DELETEs the by-name definition route with the owner query", async () => {
    const fetchMock = stubFetch({ name: "demo" });
    const r = await api.deleteWorkflow("demo");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(ROUTES.workflowDefinition("demo"));
    expect(url).toContain("owner=operator");
    expect(opts.method).toBe("DELETE");
    expect(r.body.name).toBe("demo");
  });

  it("deleteWorkflow encodes a name with URL-unsafe characters", async () => {
    const fetchMock = stubFetch({ name: "a/b copy" });
    await api.deleteWorkflow("a/b copy");
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("a%2Fb%20copy");
  });

  it("listWorkflowRuns GETs the runs route with the scope query", async () => {
    const fetchMock = stubFetch([]);
    await api.listWorkflowRuns("recent");
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain(ROUTES.workflowRuns);
    expect(url).toContain("scope=recent");
  });

  it("getWorkflowRunSteps GETs the two-segment steps route for a run", async () => {
    const fetchMock = stubFetch([]);
    await api.getWorkflowRunSteps("run-1");
    expect(fetchMock.mock.calls[0][0]).toContain(ROUTES.workflowRunSteps("run-1"));
  });

  it("listWorkerDefinitions GETs the worker-definitions route (for the `from` selector)", async () => {
    const fetchMock = stubFetch([{ name: "general-purpose" }]);
    const body = await api.listWorkerDefinitions();
    expect(fetchMock.mock.calls[0][0]).toContain(ROUTES.workerDefinitions);
    expect(body).toEqual([{ name: "general-purpose" }]);
  });
});
