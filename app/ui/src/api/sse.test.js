import { describe, it, expect, vi, beforeEach } from "vitest";

const opened = [];
vi.mock("./client.js", () => ({
  api: {
    newEventStream: (since) => {
      const listeners = {};
      const es = {
        since,
        closed: false,
        addEventListener: (type, fn) => { listeners[type] = fn; },
        close: () => { es.closed = true; },
        emit: (type, e) => listeners[type]?.(e),
      };
      opened.push(es);
      return es;
    },
  },
}));

const { createReconnectingStream } = await import("./sse.js");

describe("createReconnectingStream pause/resume", () => {
  beforeEach(() => { opened.length = 0; });

  it("pause closes the connection and resume reconnects from the last event id", () => {
    const onPause = vi.fn();
    const s = createReconnectingStream({ onPause });
    expect(opened).toHaveLength(1);
    opened[0].emit("change", { lastEventId: "e-7", data: "{}" });

    s.pause();
    expect(opened[0].closed).toBe(true);
    expect(onPause).toHaveBeenCalledTimes(1);

    s.resume();
    expect(opened).toHaveLength(2);
    expect(opened[1].since).toBe("e-7");
    s.close();
  });

  it("a paused stream does not reconnect on its own", () => {
    vi.useFakeTimers();
    const s = createReconnectingStream({});
    opened[0].onerror();
    s.pause();
    vi.advanceTimersByTime(10_000);
    expect(opened).toHaveLength(1);
    s.close();
    vi.useRealTimers();
  });
});
