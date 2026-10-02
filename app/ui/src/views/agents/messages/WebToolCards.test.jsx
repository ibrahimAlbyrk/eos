import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WebSearchDetail, WebFetchDetail } from "./WebToolCards.jsx";

// DOMPurify needs a DOM; the node test env has none, so render unsanitized.
vi.mock("../../../lib/markdown.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, renderMarkdown: mod.markdownToHtml };
});

const searchResult = (links, summary = "Vernier thresholds are 2 to 5 arcseconds.") => [
  'Web search results for query: "vernier acuity"',
  "",
  `Links: ${JSON.stringify(links)}`,
  "",
  summary,
  "",
  "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.",
].join("\n");

const LINKS = [
  { title: "KITP", url: "https://online.itp.ucsb.edu/a.pdf" },
  { title: "KITP mirror", url: "https://on.kitp.ucsb.edu/a.pdf" },
  { title: "Vision hyperacuity", url: "https://www.academia.edu/2794523" },
  { title: "PMC", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC8523788" },
  { title: "Frontiers", url: "https://www.frontiersin.org/x/pdf" },
  { title: "SciELO", url: "https://www.scielo.br/j/pn" },
  { title: "Berkeley", url: "https://w.astro.berkeley.edu/g.txt" },
];

const search = (props) => renderToStaticMarkup(
  <WebSearchDetail tool={{ name: "WebSearch", input: { query: "vernier acuity", mode: "standard" }, ...props }} />,
);
const fetchCard = (props) => renderToStaticMarkup(
  <WebFetchDetail tool={{ name: "WebFetch", input: { url: "https://pubmed.ncbi.nlm.nih.gov/8976999/", prompt: "Give the citation" }, ...props }} />,
);

describe("WebSearchDetail", () => {
  it("shows the query bar, site chips and the summary without the model-facing lines", () => {
    const html = search({ result: { text: searchResult(LINKS) } });
    expect(html).toContain("ws-query");
    expect(html).toContain(">standard<");
    expect(html).toContain("ucsb.edu");
    // a site with several links is a button with a count; one link is a plain anchor
    expect(html).toMatch(/<button[^>]*class="ws-site"[^>]*>.*?ucsb\.edu<span class="ws-site-count">2<\/span>/);
    expect(html).toContain('href="https://www.academia.edu/2794523"');
    // 6 sites: 4 shown, the rest behind "+2"
    expect(html).toContain("+2");
    expect(html).not.toContain("berkeley.edu<");
    expect(html).not.toContain("REMINDER");
    expect(html).not.toContain("Web search results for query");
  });

  it("sweeps the bar while running and shows no body yet", () => {
    const html = search({ running: true });
    expect(html).toContain("ws-bar is-running");
    expect(html).not.toContain("web-body");
    expect(html).not.toContain("web-empty");
  });

  it("says so when no sources came back", () => {
    expect(search({ result: { text: searchResult([], "") } })).toContain("No sources came back");
  });

  it("shows the failure instead of a body", () => {
    const html = search({ result: { isError: true, text: "Search unavailable" } });
    expect(html).toContain("Search unavailable");
    expect(html).not.toContain("web-body");
  });
});

describe("WebFetchDetail", () => {
  it("splits the address and shows prompt and result", () => {
    const html = fetchCard({ result: { text: "The abstract is not present." } });
    expect(html).toContain('<span class="fetch-host">pubmed.ncbi.nlm.nih.gov</span>/8976999/');
    expect(html).toContain('href="https://pubmed.ncbi.nlm.nih.gov/8976999/"');
    expect(html).toContain("Give the citation");
    expect(html).toContain(">Result<");
  });

  it("runs a progress bar under the address while fetching", () => {
    const html = fetchCard({ running: true });
    expect(html).toContain("fetch-bar is-running");
    expect(html).not.toContain(">Result<");
  });

  it("shows the failure in place of the result", () => {
    const html = fetchCard({ result: { isError: true, text: "Request failed with status code 403" } });
    expect(html).toContain("Request failed with status code 403");
    expect(html).not.toContain(">Result<");
  });
});
