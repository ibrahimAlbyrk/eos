import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangesHeader } from "./ChangesHeader.jsx";
import { PatchBody } from "../messages/PatchBody.jsx";

const noop = () => {};
const base = {
  cwd: "/repo", onScope: noop, onStash: noop, view: { split: false, tree: true }, onView: noop,
  onRefresh: noop, onExpandAll: noop, onCollapseAll: noop, agent: null, pager: null,
};
const changes = { insertions: 414, deletions: 96, headLabel: "feature/stance-ik", baseLabel: "origin/main", files: [] };

describe("ChangesHeader", () => {
  it("shows the branch scope with totals and head → base", () => {
    const html = renderToStaticMarkup(<ChangesHeader {...base} scope={{ kind: "branch", base: null }} changes={changes} />);
    expect(html).toContain("Branch");
    expect(html).toContain("+414");
    expect(html).toContain("−96");
    expect(html).toContain("feature/stance-ik");
    expect(html).toContain("origin/main");
    expect(html).not.toContain("Ask for review");
  });

  it("offers review and commit beside an agent, and pages a large diff", () => {
    const agent = { onReview: noop, onAction: noop, busy: false };
    const pager = { index: 1, count: 5, go: noop };
    const html = renderToStaticMarkup(<ChangesHeader {...base} scope={{ kind: "all" }} changes={changes} agent={agent} pager={pager} />);
    expect(html).toContain("Uncommitted");
    expect(html).toContain("Ask for review");
    expect(html).toContain(">Commit<");
    expect(html).toContain("2 / 5");
  });

  it("labels a stash scope and hides commit actions for history", () => {
    const agent = { onReview: noop, onAction: noop, busy: false };
    const html = renderToStaticMarkup(<ChangesHeader {...base} scope={{ kind: "commit", sha: "abcdef1234", subject: "wip", stash: 0 }} changes={changes} agent={agent} />);
    expect(html).toContain("Stash");
    expect(html).toContain("stash@{0}");
    expect(html).not.toContain(">Commit<");
  });
});

describe("PatchBody", () => {
  const patch = { data: { path: "a.ts", patch: "@@ -10,2 +10,3 @@ solve()\n ctx\n-old\n+new\n+more\n", binary: false } };
  it("folds the unchanged lines before a hunk and offers line comments", () => {
    const html = renderToStaticMarkup(<PatchBody file={{ path: "a.ts" }} patch={patch} loadNewLines={async () => []} onComment={async () => true} />);
    expect(html).toContain("9 unmodified lines");
    expect(html).toContain("solve()");
    expect(html).toContain("Comment on line 11");
  });

  it("lays rows side by side in split view", () => {
    const html = renderToStaticMarkup(<PatchBody file={{ path: "a.ts" }} patch={patch} split />);
    expect(html).toContain("dv-patch--split");
    expect(html).not.toContain("Comment on line");
  });
});
