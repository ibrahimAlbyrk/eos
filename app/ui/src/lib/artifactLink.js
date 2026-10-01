// claude.ai Artifact links (pages published with Claude Code's Artifact tool)
// rendered as a small glass chip: in the Artifact tool's row and in place of an
// artifact link in assistant prose. Hover peeks (ArtifactPeek.jsx), click opens.
import { escapeHtml } from "./markdown.js";

const ARTIFACT_URL = /https:\/\/(?:preview\.)?claude\.(?:ai|com)\/(?:code\/)?artifact\/[A-Za-z0-9-]+/;
const ARTIFACT_HREF = new RegExp(`^${ARTIFACT_URL.source}(?:[/?#][^\\s]*)?$`);
const PAGE_FILE = /([^/]+)\.(?:html?|md)$/i;

export function isArtifactUrl(href) {
  return ARTIFACT_HREF.test(href ?? "");
}

// "claude.ai/artifact/YBc8tWaK…" — host + path with the id cut short.
export function artifactLabel(url) {
  const m = /^https:\/\/([^/]+\/(?:code\/)?artifact\/)([A-Za-z0-9-]+)/.exec(url ?? "");
  if (!m) return url ?? "";
  return m[1] + (m[2].length > 8 ? m[2].slice(0, 8) + "…" : m[2]);
}

// The page an Artifact tool call points at, or null. Only `publish` (the default
// action) and `open` name a page — quickstart/list/read results also carry
// claude.ai/artifact links (types, other pages) that must not become chips.
export function artifactFromTool(t) {
  const input = t?.input ?? {};
  const action = input.action ?? "publish";
  if (t?.result?.isError || input.asset) return null;
  if (action !== "publish" && action !== "open") return null;
  const resultText = t?.result?.text ?? "";
  const url = input.url ?? (action === "publish" ? ARTIFACT_URL.exec(resultText)?.[0] : null);
  if (!url) return null;
  const verb = action === "open" ? "Opened" : /^\s*Updated\b/.test(resultText) ? "Updated" : "Published";
  // a plain page's basename is its title when none is given; a typed artifact's
  // file_path (under `root`) is a data file, not a name
  const title = input.title ?? (input.root ? null : PAGE_FILE.exec(input.file_path ?? "")?.[1]) ?? null;
  return { url, title, verb };
}

// Every artifact this transcript published or opened — its own Artifact calls
// and its subagents' — one entry per page, newest activity first. A page keeps
// the first title it was given (later updates of a typed artifact carry none).
export function collectArtifacts(blocks) {
  const byUrl = new Map();
  const visit = (tool) => {
    if (tool?.name !== "Artifact") return;
    const artifact = artifactFromTool(tool);
    if (!artifact) return;
    const prev = byUrl.get(artifact.url);
    byUrl.set(artifact.url, { url: artifact.url, title: prev?.title ?? artifact.title, ts: tool.ts ?? prev?.ts ?? 0 });
  };
  for (const b of blocks) {
    if (b.kind === "tool") visit(b.tool);
    else if (b.kind === "toolGroup" || b.kind === "agentRun") b.tools?.forEach(visit);
  }
  return [...byUrl.values()].sort((a, b) => b.ts - a.ts);
}

const WINDOW_ICON =
  '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25"/><path d="M1.75 6h12.5"/></svg>';
const ARROW_ICON =
  '<svg class="art-chip-arrow" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 11.5l7-7M5.5 4.5h6v6"/></svg>';

const escapeAttr = (s) => escapeHtml(s).replace(/"/g, "&quot;");

// The one chip markup, shared by the tool row (React) and prose (HTML string).
export function artifactChipHtml({ url, title }) {
  const dataTitle = title ? ` data-title="${escapeAttr(title)}"` : "";
  return `<a class="art-chip" href="${escapeAttr(url)}"${dataTitle}>`
    + `<span class="art-chip-thumb">${WINDOW_ICON}</span>`
    + `<span class="art-chip-title">${escapeHtml(title || artifactLabel(url))}</span>`
    + `${ARROW_ICON}</a>`;
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const decodeHtml = (s) => s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]);
const looksLikeUrl = (text) => /^(?:https?:\/\/)?(?:preview\.)?claude\.(?:ai|com)\//.test(text);

// Swaps each artifact <a> in sanitized markdown HTML for a chip. The link text
// becomes the chip title unless it is just the URL again (an autolink). Anchors
// never nest, so a non-greedy match per anchor is safe.
export function withArtifactChips(html) {
  if (!html || !html.includes("/artifact/")) return html;
  return html.replace(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (anchor, rawHref, inner) => {
    const url = decodeHtml(rawHref);
    if (!isArtifactUrl(url)) return anchor;
    const text = decodeHtml(inner.replace(/<[^>]*>/g, "")).trim();
    return artifactChipHtml({ url, title: text && !looksLikeUrl(text) ? text : null });
  });
}
