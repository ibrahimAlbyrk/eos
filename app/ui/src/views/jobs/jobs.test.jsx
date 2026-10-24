import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { JobRow } from "./JobRow.jsx";
import { JobStatus } from "./JobGlyph.jsx";

vi.mock("../../api/client.js", () => ({ api: { listJobs: vi.fn(async () => []) } }));

const job = (over) => ({
  id: "shell:w1:b1", kind: "shell", status: "running", workerId: "w1", title: "npm run dev", command: "npm run dev",
  detail: "VITE ready", startedAt: 0, endedAt: null, progress: null, exitCode: null, callId: "toolu_1", hasOutput: true, canStop: true, ...over,
});

describe("JobRow", () => {
  it("shows a command in mono, the chat and what is happening, the elapsed time and a spinner", () => {
    const html = renderToStaticMarkup(<JobRow job={job({})} now={724_000} source="Background jobs panel" />);
    expect(html).toContain('class="jb-row__title is-mono">npm run dev<');
    expect(html).toContain("Background jobs panel · VITE ready");
    expect(html).toContain(">12:04<");
    expect(html).toContain('aria-label="Running"');
  });

  it("draws a progress bar for a job with a share done, and only one line when compact", () => {
    const html = renderToStaticMarkup(<JobRow job={job({ kind: "transfer", title: "a.dmg → Air", command: null, progress: { done: 64, total: 100 } })} now={1} source="Eos" compact />);
    expect(html).toContain('style="width:64%"');
    expect(html).not.toContain("jb-row__sub");
  });

  it("marks a finished job by its status", () => {
    const html = renderToStaticMarkup(<JobRow job={job({ status: "failed", endedAt: 0, exitCode: 1 })} now={120_000} source="x" />);
    expect(html).toContain("is-done");
    expect(html).toContain('class="jb-row__meta is-err">2m ago<');
    expect(renderToStaticMarkup(<JobStatus status="stopped" />)).toContain('aria-label="Stopped"');
  });
});
