import { describe, it, expect, beforeEach, vi } from "vitest";
import { ROUTES } from "../../api/routes.js";
import { notify } from "../../lib/notify.js";
import { _resetRoutines, importRoutine, importRoutineFile, readRoutineFile, refreshRoutines } from "./routinesStore.js";
import { setEosTransport } from "./transport.js";

const ROW = { id: "rt-imported", name: "PR Review", state: "draft" };

describe("a routine file", () => {
  beforeEach(() => _resetRoutines());

  it("imports as a draft routine through the core, which answers its row", async () => {
    const send = vi.fn(async () => ({ ok: true, status: 201, body: { row: ROW, versionId: "rv-1", warnings: [] } }));
    setEosTransport({ get: async () => ({ ok: true, status: 200, body: [] }), send });
    await refreshRoutines();
    const file = { format: 1, routine: { name: "PR Review" }, versions: [] };
    expect(await importRoutine(JSON.stringify(file))).toBe("rt-imported");
    expect(send).toHaveBeenCalledWith("POST", ROUTES.routinesImport, file);
  });

  it("says why when the file is not one, or the core refuses it", async () => {
    const said = vi.spyOn(notify, "error").mockImplementation(() => {});
    const send = vi.fn(async () => ({ ok: false, status: 400, body: { error: "not a routine file this Eos can read" } }));
    setEosTransport({ get: async () => ({ ok: false, status: 404, body: {} }), send });
    expect(await importRoutine("not json")).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(await importRoutine('{"format": 7}')).toBeNull();
    expect(said.mock.calls.map((call) => call[0])).toEqual(["This is not a routine file.", "not a routine file this Eos can read"]);
    said.mockRestore();
  });

  it("is read before anything is sent: its routine's name and how many versions it carries", () => {
    expect(readRoutineFile('{"format":1,"routine":{"name":"PR Review"},"versions":[{},{}]}')).toEqual({
      file: { format: 1, routine: { name: "PR Review" }, versions: [{}, {}] }, name: "PR Review", versions: 2,
    });
    expect(readRoutineFile('{"format":7}')).toEqual({ file: { format: 7 }, name: null, versions: 0 });
    expect(readRoutineFile("Buy milk")).toBeNull();
    expect(readRoutineFile("[1, 2]")).toBeNull();
  });

  it("answers the core's reason to the dialog instead of a notification", async () => {
    const said = vi.spyOn(notify, "error").mockImplementation(() => {});
    setEosTransport({ get: async () => ({ ok: false, status: 404, body: {} }), send: async () => ({ ok: false, status: 400, body: { error: "this file was written by a newer Eos" } }) });
    expect(await importRoutineFile({ format: 9 })).toEqual({ error: "this file was written by a newer Eos" });
    expect(said).not.toHaveBeenCalled();
    said.mockRestore();
  });
});
