import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { _resetStreamFocus, focusQuery } from "../streamFocus.js";
import { applyEosEvent } from "./live.js";
import { _resetRunLive, release, retain, useRunLines } from "./runLiveStore.js";

const setStreamFocus = vi.hoisted(() => vi.fn(async () => ({ ok: true, body: { live: [] } })));
vi.mock("../../api/client.js", () => ({ api: { setStreamFocus } }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function linesOf(runId) {
  let read;
  function Probe() {
    read = useRunLines(runId);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return read;
}

const activity = (runId, workerId, line, agentKey = "reader") => applyEosEvent("run:activity", { runId, workerId, agentKey, line, at: 1 });

beforeEach(() => {
  _resetRunLive();
  _resetStreamFocus();
  setStreamFocus.mockClear();
});

describe("a run's live lines", () => {
  it("put the run in the stream focus while it is retained, and take it out with the last release", async () => {
    retain("rn-1");
    retain("rn-1");
    await flush();
    expect(setStreamFocus).toHaveBeenLastCalledWith({ workers: [], ptys: [], runs: ["rn-1"] });
    expect(focusQuery()).toBe("&focus=&ptys=&runs=rn-1");

    release("rn-1");
    await flush();
    expect(setStreamFocus).toHaveBeenCalledTimes(1);
    release("rn-1");
    await flush();
    expect(setStreamFocus).toHaveBeenLastCalledWith({ workers: [], ptys: [], runs: [] });
    expect(focusQuery()).toBe("&focus=&ptys=&runs=");
  });

  it("name at most 64 runs, the ones retained last", async () => {
    for (let i = 0; i < 70; i++) retain(`rn-${i}`);
    await flush();
    const { runs } = setStreamFocus.mock.lastCall[0];
    expect(runs).toHaveLength(64);
    expect(runs[0]).toBe("rn-6");
    expect(runs[63]).toBe("rn-69");
  });

  it("keep each agent's last three lines, by worker, the checker's too", () => {
    retain("rn-1");
    for (const line of ["one", "two", "three", "four"]) activity("rn-1", "w-lead", line);
    activity("rn-1", "w-check", "reading the result", null);
    expect(linesOf("rn-1")).toEqual({ "w-lead": ["two", "three", "four"], "w-check": ["reading the result"] });
  });

  it("show a line the agent just showed only once", () => {
    retain("rn-1");
    activity("rn-1", "w-lead", "reading main.rs");
    activity("rn-1", "w-lead", "reading main.rs");
    expect(linesOf("rn-1")).toEqual({ "w-lead": ["reading main.rs"] });
  });

  it("leave out a run nobody shows, and drop a run's lines with its last release", () => {
    activity("rn-2", "w-lead", "not shown");
    expect(linesOf("rn-2")).toEqual({});

    retain("rn-1");
    activity("rn-1", "w-lead", "working");
    release("rn-1");
    expect(linesOf("rn-1")).toEqual({});
    activity("rn-1", "w-lead", "after");
    expect(linesOf("rn-1")).toEqual({});
  });
});
