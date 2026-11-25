import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { ROUTES } from "../../../api/routes.js";
import { _resetRoutines, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { FormArrival, LinkDialog, formInput, linkText } from "./FormArrival.jsx";
import { parseLocation } from "../nav/eosNav.js";
import routines from "../gallery/sample/routines.json";

const routine = {
  id: "rt-1", slug: "pr-review", name: "PR Review", takes: { kind: "github.pull_request" },
  options: [{ key: "depth", type: "choice" }, { key: "tests", type: "bool" }],
};

beforeEach(() => _resetRoutines());
afterEach(() => setEosTransport(null));

describe("a link's form", () => {
  const location = parseLocation("eos:/form?routine=pr-review&item=470&opt.depth=deep&opt.tests=1&opt.other=x&showOnly=1&from=link");

  it("fills the run with the link's item, marked untrusted, and only the options the routine has", () => {
    expect(formInput(location, routine)).toEqual({
      item: { kind: "github.pull_request", text: "470", title: "470", untrusted: true },
      options: { depth: "deep", tests: true },
      result: "showOnly",
    });
    expect(linkText(location)).toBe("eos://run/pr-review?item=470&opt.depth=deep&opt.tests=1&opt.other=x&show-only=1");
  });

  it("asks first: the dialog shows what the link wants and starts nothing by itself", () => {
    const html = renderToStaticMarkup(<LinkDialog location={location} routine={routine} />);
    expect(html).toContain("A link wants to start a run");
    expect(html).toContain("PR Review");
    expect(html).toContain("Show me only");
    expect(html).toContain("<dt>Depth</dt><dd>Deep</dd>");
    expect(html).toContain("<dt>Tests</dt><dd>Yes</dd>");
    const later = parseLocation("eos:/form?routine=pr-review&at=2026-11-19T09%3A00%2B01%3A00&from=link");
    expect(renderToStaticMarkup(<LinkDialog location={later} routine={routine} />)).toContain("<dt>When</dt>");
    expect(html).toContain(">Run</button>");
    expect(html).toContain(">Cancel</button>");
  });

  it("says when the link names no routine of the user's", async () => {
    setEosTransport(fixtureTransport({ [ROUTES.routines]: routines }));
    await refreshRoutines();
    const html = renderToStaticMarkup(<FormArrival location={{ ...location, routine: "no-such" }} />);
    expect(html).toContain("There is no routine named no-such.");
    expect(html).not.toContain(">Run</button>");
  });
});
