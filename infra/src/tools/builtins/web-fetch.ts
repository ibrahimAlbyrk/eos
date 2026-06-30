// WebFetch — fetch a URL and return its textual content (HTML reduced to text).
// Canonical fields: url, prompt. The bundled binary summarizes the page against
// `prompt` with a model; this lane has no side model on the tool path, so it returns
// the (truncated) extracted text and the model reasons over it in-loop. The fetch
// impl is injectable for tests.

import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";
import { requireString } from "./_shared.ts";

const MAX_CHARS = 50_000;

type FetchLike = (url: string, init?: { redirect?: "follow" }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers: { get(name: string): string | null } }>;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export function createWebFetchTool(fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.WebFetch,
    description: "Fetch a URL and return its content as text. Use `prompt` to note what you are looking for.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch (http/https)." },
        prompt: { type: "string", description: "What to extract or look for in the page." },
      },
      required: ["url", "prompt"],
    },
    async execute(input) {
      const url = requireString(input, "url");
      let resp;
      try {
        resp = await fetchImpl(url, { redirect: "follow" });
      } catch (e) {
        throw new Error(`failed to fetch ${url}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      if (!resp.ok) throw new Error(`fetch ${url} returned HTTP ${resp.status}`);
      const body = await resp.text();
      const contentType = resp.headers.get("content-type") ?? "";
      const text = contentType.includes("html") ? htmlToText(body) : body;
      return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…[truncated]` : text;
    },
  };
}
