// Morning Paper's issues as the core frames them (the golden renders of
// crates/eos-surface's Morning Paper test, with its runtime), so the gallery
// draws a Page's sheet. A version the page has not kept leaves out its
// Live ops stories, as version 3's note says.
import paper from "./sample/paper-pages.json";
import { movedDatelines } from "./samplePaper.js";

const LIVE_OPS = /<article class="story"[^>]*data-filter-value="live-ops">.*?<\/article>|<button type="button" data-filter="live-ops"[^>]*>live-ops<\/button>/g;

export function samplePageDocument(issueId, version) {
  const body = paper.bodies[issueId] ?? paper.bodies["si-7b3m1c000003"];
  const shown = movedDatelines(version === 3 ? body.replace(LIVE_OPS, "") : body);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${paper.base}</style><style>${paper.style}</style></head>`
    + `<body><div class="eos-page" role="document">${shown}</div><script>${paper.runtime}</script></body></html>`;
}

// What the gallery's frames load in place of the raw origin's page: one URL
// per issue and version, so a frame drawn again does not load again.
const urls = new Map();
export function samplePageUrl(_surfaceId, issueId, version) {
  const key = `${issueId}:${version ?? ""}`;
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(new Blob([samplePageDocument(issueId, version)], { type: "text/html" })));
  return urls.get(key);
}
