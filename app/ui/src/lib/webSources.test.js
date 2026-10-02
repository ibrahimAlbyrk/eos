import { describe, it, expect } from "vitest";
import { parseWebSearch, splitUrl, siteOf, groupBySite, siteHue } from "./webSources.js";

const RESULT = [
  'Web search results for query: "vernier acuity"',
  "",
  'Links: [{"title":"Vision hyperacuity","url":"https://www.academia.edu/2794523/Vision_hyperacuity"},{"title":"pmc","url":"https://pmc.ncbi.nlm.nih.gov/articles/PMC8523788"}]',
  "",
  "Based on the search results:",
  "",
  "## Vernier Acuity",
  "",
  "As low as 2 to 5 arcseconds.",
  "",
  "",
  "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.",
].join("\n");

describe("parseWebSearch", () => {
  it("splits links from the summary and drops the model-facing lines", () => {
    const { links, summary } = parseWebSearch(RESULT);
    expect(links).toEqual([
      { title: "Vision hyperacuity", url: "https://www.academia.edu/2794523/Vision_hyperacuity" },
      { title: "pmc", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC8523788" },
    ]);
    expect(summary).toBe("Based on the search results:\n\n## Vernier Acuity\n\nAs low as 2 to 5 arcseconds.");
  });

  it("collects every Links block of a multi-round search", () => {
    const text = 'Links: [{"title":"a","url":"https://a.com"}]\nmid\nLinks: [{"title":"b","url":"https://b.com"}]';
    const { links, summary } = parseWebSearch(text);
    expect(links.map((l) => l.title)).toEqual(["a", "b"]);
    expect(summary).toBe("mid");
  });

  it("drops a malformed Links line and entries without a url", () => {
    expect(parseWebSearch('Links: [{"title":"a",')).toEqual({ links: [], summary: "" });
    expect(parseWebSearch('Links: [{"title":"a"},{"url":"https://b.com"}]').links).toEqual([{ title: "", url: "https://b.com" }]);
  });

  it("handles a missing result", () => {
    expect(parseWebSearch(undefined)).toEqual({ links: [], summary: "" });
  });
});

describe("splitUrl", () => {
  it("splits host from the rest, without www", () => {
    expect(splitUrl("https://www.x.com/a/b?q=1#h")).toEqual({ host: "x.com", rest: "/a/b?q=1#h", secure: true });
    expect(splitUrl("http://x.com/")).toEqual({ host: "x.com", rest: "", secure: false });
    expect(splitUrl("not a url")).toBe(null);
  });
});

describe("siteOf", () => {
  it("keeps the registrable domain", () => {
    expect(siteOf("docs.cocos.com")).toBe("cocos.com");
    expect(siteOf("pmc.ncbi.nlm.nih.gov")).toBe("nih.gov");
    expect(siteOf("minerva-access.unimelb.edu.au")).toBe("unimelb.edu.au");
    expect(siteOf("scielo.br")).toBe("scielo.br");
    expect(siteOf("localhost")).toBe("localhost");
  });
});

describe("groupBySite", () => {
  it("groups in first-seen order and drops repeated urls", () => {
    const sites = groupBySite([
      { title: "a", url: "https://online.itp.ucsb.edu/a.pdf" },
      { title: "b", url: "https://academia.edu/b" },
      { title: "a2", url: "https://www.on.kitp.ucsb.edu/a.pdf" },
      { title: "b", url: "https://academia.edu/b" },
      { title: "bad", url: "::" },
    ]);
    expect(sites.map((s) => [s.name, s.links.length])).toEqual([["ucsb.edu", 2], ["academia.edu", 1]]);
  });
});

describe("siteHue", () => {
  it("is stable and in range", () => {
    expect(siteHue("nih.gov")).toBe(siteHue("nih.gov"));
    expect(siteHue("nih.gov")).toBeGreaterThanOrEqual(0);
    expect(siteHue("nih.gov")).toBeLessThan(360);
  });
});
