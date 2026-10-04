import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SuggestionInbox } from "./SuggestionInbox.jsx";
import { MemoryItem } from "./MemoryItem.jsx";
import { MemoryReviewRow } from "../../components/profile/ProfileMenuHeader.jsx";

const suggestion = (id, over = {}) => ({
  id, text: "Prefers 4–5 design directions before committing.", category: "work-style",
  scope: { kind: "global" }, tier: "always", status: "suggested",
  source: { kind: "agent", agentId: "w-1", agentName: "profile-design", why: "asked for variations" },
  rev: 0, createdAt: 1, updatedAt: 1, ...over,
});

describe("SuggestionInbox", () => {
  it("nothing pending → nothing rendered", () => {
    expect(renderToStaticMarkup(<SuggestionInbox pending={[]} />)).toBe("");
  });

  it("each suggestion shows who, why, scope, and Keep / Dismiss; Keep all only for several", () => {
    const one = renderToStaticMarkup(<SuggestionInbox pending={[suggestion("um-1")]} />);
    expect(one).toContain("An agent noticed something");
    expect(one).toContain("profile-design");
    expect(one).toContain("asked for variations");
    expect(one).toContain("All projects");
    expect(one).toContain(">Keep<");
    expect(one).toContain(">Dismiss<");
    expect(one).not.toContain("Keep all");
    const two = renderToStaticMarkup(
      <SuggestionInbox pending={[suggestion("um-1"), suggestion("um-2", { scope: { kind: "project", path: "/x/eos" } })]} />,
    );
    expect(two).toContain("Agents noticed 2 things");
    expect(two).toContain("Keep all");
    expect(two).toContain(">eos<");
  });
});

describe("MemoryItem", () => {
  it("shows the text, its source and tier", () => {
    const html = renderToStaticMarkup(<MemoryItem memory={suggestion("um-1", { status: "active" })} />);
    expect(html).toContain("Prefers 4–5 design directions");
    expect(html).toContain("Learned · profile-design");
    expect(html).toContain("Always on");
    expect(html).toContain('aria-label="Delete memory"');
    const od = renderToStaticMarkup(<MemoryItem memory={suggestion("um-2", { status: "active", tier: "on-demand" })} />);
    expect(od).toContain("On demand");
  });
});

describe("MemoryReviewRow", () => {
  it("counts what is waiting", () => {
    expect(renderToStaticMarkup(<MemoryReviewRow count={3} onOpen={() => {}} />)).toContain("Agents noticed 3 things");
  });
});
