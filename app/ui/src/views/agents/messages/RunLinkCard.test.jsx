import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UiProvider } from "../../../state/ui.jsx";
import { buildBlocks } from "../../../lib/messageParser.js";
import { RUN_TOOL_VIEWS, RunLinkCard, cardState, runAnswer } from "./RunLinkCard.jsx";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const card = { runId: "rn-1", routineId: "rt-1", routineName: "PR Review", state: "done", headline: "Two issues found" };

beforeEach(() => store.clear());

describe("a routine's run in a chat", () => {
  it("draws the run card with the routine, its state and headline", () => {
    const html = renderToStaticMarkup(<UiProvider><RunLinkCard card={card} /></UiProvider>);
    expect(html).toContain("PR Review");
    expect(html).toContain("Done");
    expect(html).toContain("Two issues found");
    expect(html).toContain('aria-label="Open the run of PR Review"');
    expect(cardState("waiting_for_user").text).toBe("Waiting for you");
  });

  it("reads a routine note row as a card, not as the user's words", () => {
    const row = { id: 9, type: "user_message", ts: 5, payload: JSON.stringify({ text: "PR Review finished", eosNote: true, routineNote: card }) };
    const blocks = buildBlocks([row]);
    expect(blocks).toEqual([{ kind: "runCard", card, ts: 5, rowId: 9 }]);
  });

  it("says what run_routine came to, and offers Review and run only for a proposal", () => {
    const view = RUN_TOOL_VIEWS.run_routine;
    const proposed = { input: { routine: "pr-review", item: "482" }, result: { isError: false, text: JSON.stringify({ state: "proposed", routineId: "rt-1", routine: "PR Review" }) } };
    const started = { input: { routine: "digest" }, result: { isError: false, text: JSON.stringify({ state: "started", runId: "rn-2", routine: "Digest" }) } };
    expect(view.label(proposed)).toEqual({ verb: "Proposed a run of", file: "PR Review" });
    expect(view.label(started)).toEqual({ verb: "Started", file: "Digest" });
    expect(renderToStaticMarkup(view.headerBadge(proposed))).toContain("Review and run");
    expect(renderToStaticMarkup(view.headerBadge(started))).toBe("");
    expect(runAnswer({ running: true })).toBeNull();
  });
});
