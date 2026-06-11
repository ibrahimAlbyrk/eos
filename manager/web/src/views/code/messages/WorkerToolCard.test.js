import { describe, it, expect } from "vitest";
import { workerToolDetailText } from "./WorkerToolCard.jsx";

const result = (v) => ({ result: { text: JSON.stringify(v) } });

describe("workerToolDetailText", () => {
  it("lists workers with resolved name, state and prompt", () => {
    const tool = {
      name: "mcp__orchestrator__list_workers",
      ...result([
        { id: "w1", state: "idle", prompt: "Add billing tests" },
        { id: "w2", state: "running", prompt: "Fix the auth bug" },
      ]),
    };
    const out = workerToolDetailText(tool, [{ id: "w1", name: "add-tests" }]);
    expect(out).toContain("add-tests · idle");
    expect(out).toContain("Add billing tests");
    expect(out).toContain("w2 · running");
  });

  it("prefers the name carried in the result over live resolution", () => {
    const tool = {
      name: "mcp__orchestrator__list_workers",
      ...result([{ id: "w9", name: "refactor-auth", state: "completed", prompt: "Rotate tokens" }]),
    };
    // No live worker for w9 — the embedded name must still show (not the id).
    const out = workerToolDetailText(tool, []);
    expect(out).toContain("refactor-auth · completed");
    expect(out).not.toContain("w9");
  });

  it("renders informative empty states for the list tools", () => {
    expect(workerToolDetailText({ name: "mcp__orchestrator__list_workers", ...result([]) }, [])).toBe("No workers.");
    expect(
      workerToolDetailText({ name: "mcp__orchestrator__list_pending_permissions", ...result([]) }, []),
    ).toBe("No pending permissions.");
  });

  it("summarizes get_worker state, cost, event count and prompt", () => {
    const tool = {
      name: "mcp__orchestrator__get_worker",
      ...result({ worker: { state: "idle", branch: "eos-x", cost_usd: 0.0421, prompt: "Do the thing" }, events: [1, 2, 3] }),
    };
    const out = workerToolDetailText(tool);
    expect(out).toContain("idle · eos-x");
    expect(out).toContain("$0.0421");
    expect(out).toContain("3 events");
    expect(out).toContain("Do the thing");
  });

  it("shows the final state for kill_worker", () => {
    const tool = { name: "mcp__orchestrator__kill_worker", ...result({ state: "killed", branch: "eos-x" }) };
    expect(workerToolDetailText(tool)).toBe("killed · eos-x");
  });

  it("summarizes pending permissions with name, tool and input", () => {
    const tool = {
      name: "mcp__orchestrator__list_pending_permissions",
      ...result([{ worker_id: "w1", tool: "Bash", input: { command: "rm -rf node_modules" } }]),
    };
    const out = workerToolDetailText(tool, [{ id: "w1", name: "cleaner" }]);
    expect(out).toContain("cleaner · Bash");
    expect(out).toContain("rm -rf node_modules");
  });

  it("returns the error text when the call failed", () => {
    const tool = { name: "mcp__orchestrator__get_worker", result: { isError: true, text: "worker not found" } };
    expect(workerToolDetailText(tool)).toBe("worker not found");
  });
});
