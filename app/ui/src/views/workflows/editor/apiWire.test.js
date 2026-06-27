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

  it("runWorkflow POSTs a run-inline body carrying the graph + args", async () => {
    const fetchMock = stubFetch({ runId: "run-1", status: "running" });
    const graph = { name: "demo", version: 2, nodes: [], edges: [] };
    const r = await api.runWorkflow(graph, { x: 1 });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(ROUTES.workflows);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ mode: "run-inline", spec: graph, args: { x: 1 } });
    expect(r.body.runId).toBe("run-1");
  });

  it("getWorkflowCatalog GETs the catalog route", async () => {
    const fetchMock = stubFetch({ nodeKinds: [], transformFns: [] });
    await api.getWorkflowCatalog();
    expect(fetchMock.mock.calls[0][0]).toContain(ROUTES.workflowCatalog);
  });
});
