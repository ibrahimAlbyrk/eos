import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getGenuiView = vi.fn();
vi.mock("../../api/client.js", () => ({ api: { getGenuiView: (...a) => getGenuiView(...a) } }));

const { MISSING, _reset, fetchViewRecord, getViewRecord, getViewRecordError, retryViewRecord } = await import("./viewRecords.js");

const ID = "v_abcdefghijkl";
const REC = { id: ID, workerId: "w", title: "T", createdAt: 1, kind: "view", spec: { title: "T" } };

describe("view records for the side-panel tab", () => {
  beforeEach(() => { _reset(); getGenuiView.mockReset(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("a 404 is a missing view; a record is kept", async () => {
    getGenuiView.mockResolvedValueOnce(null);
    await fetchViewRecord(ID);
    expect(getViewRecord(ID)).toBe(MISSING);
    _reset();
    getGenuiView.mockResolvedValueOnce(REC);
    await fetchViewRecord(ID);
    expect(getViewRecord(ID)).toEqual(REC);
  });

  it("any other failure is an error the panel shows, retried with backoff until it loads", async () => {
    getGenuiView.mockRejectedValueOnce(new Error("daemon unreachable"));
    await fetchViewRecord(ID);
    expect(getViewRecord(ID)).toBe(null);
    expect(getViewRecordError(ID)).toBe("daemon unreachable");
    getGenuiView.mockResolvedValueOnce(REC);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getGenuiView).toHaveBeenCalledTimes(2);
    expect(getViewRecord(ID)).toEqual(REC);
    expect(getViewRecordError(ID)).toBe(null);
  });

  it("Retry fetches at once", async () => {
    getGenuiView.mockRejectedValueOnce(new Error("500"));
    await fetchViewRecord(ID);
    getGenuiView.mockResolvedValueOnce(REC);
    await retryViewRecord(ID);
    expect(getViewRecord(ID)).toEqual(REC);
  });
});
