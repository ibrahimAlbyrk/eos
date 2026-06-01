import { describe, it, expect } from "vitest";
import { derivePendingQuestions } from "./pendingQuestions.js";

const q = (label) => ({ question: label, options: [{ label: "a" }] });

describe("derivePendingQuestions", () => {
  it("keeps a question OPEN when a stray tool_done arrives (B3 premature-close repro)", () => {
    const events = [
      { type: "question_pending", payload: { toolUseId: "tu1", questions: [q("Q1")] } },
      { type: "tool_done", payload: { toolUseId: "other" } },
    ];
    const open = derivePendingQuestions(events);
    expect(open.map((e) => e.toolUseId)).toEqual(["tu1"]);
  });

  it("closes a question once a matching question_answered arrives", () => {
    const events = [
      { type: "question_pending", payload: { toolUseId: "tu1", questions: [q("Q1")] } },
      { type: "question_answered", payload: { toolUseId: "tu1", answers: { Q1: "a" } } },
    ];
    expect(derivePendingQuestions(events)).toEqual([]);
  });

  it("tracks multiple concurrent pending questions (B7-Sub-B)", () => {
    const events = [
      { type: "question_pending", payload: { toolUseId: "tu1", questions: [q("Q1")] } },
      { type: "question_pending", payload: { toolUseId: "tu2", questions: [q("Q2")] } },
    ];
    expect(derivePendingQuestions(events).map((e) => e.toolUseId)).toEqual(["tu1", "tu2"]);
  });

  it("closes only the answered toolUseId, leaving siblings open", () => {
    const events = [
      { type: "question_pending", payload: { toolUseId: "tu1", questions: [q("Q1")] } },
      { type: "question_pending", payload: { toolUseId: "tu2", questions: [q("Q2")] } },
      { type: "question_answered", payload: { toolUseId: "tu1", answers: { Q1: "a" } } },
    ];
    expect(derivePendingQuestions(events).map((e) => e.toolUseId)).toEqual(["tu2"]);
  });

  it("ignores a question_pending with no questions", () => {
    const events = [
      { type: "question_pending", payload: { toolUseId: "tu1", questions: [] } },
    ];
    expect(derivePendingQuestions(events)).toEqual([]);
  });

  it("parses string-encoded payloads", () => {
    const events = [
      { type: "question_pending", payload: JSON.stringify({ toolUseId: "tu1", questions: [q("Q1")] }) },
    ];
    expect(derivePendingQuestions(events).map((e) => e.toolUseId)).toEqual(["tu1"]);
  });
});
