// Renders a worker's event stream into a markdown transcript suitable for
// pasting into a PR description, an issue, or saving as a session log.
// Export carries the full payload of every block — if a transcript turns out
// huge, that's the user's signal to either grep the file or filter beforehand.

import { stripMcpPrefix } from "./format.js";
import { groupEvents, turnBlocks } from "./groupEvents.js";

/**
 * Builds a markdown transcript for the given worker.
 *
 * @param {object} agent  Agent metadata (name, model, etc).
 * @param {Array}  events Events filtered to this worker (chronological).
 * @returns {string} Markdown content. Caller is responsible for download/save.
 */
export function exportWorkerMarkdown(agent, events) {
  const lines = [];
  const started = agent.startedTs ? new Date(agent.startedTs).toISOString() : "?";
  lines.push(`# ${agent.name} — session transcript`);
  lines.push("");
  lines.push(`- **id:** \`${agent.id}\``);
  lines.push(`- **model:** ${agent.model}`);
  lines.push(`- **status:** ${agent.status}`);
  lines.push(`- **started:** ${started}`);
  if (agent.branch) lines.push(`- **branch:** \`${agent.branch}\``);
  if (agent.cwd) lines.push(`- **cwd:** \`${agent.cwd}\``);
  if (agent.cost) lines.push(`- **cost:** $${Number(agent.cost).toFixed(3)}`);
  lines.push("");

  const turns = groupEvents(events);
  for (const t of turns) {
    if (t.kind === "user") {
      lines.push("---");
      lines.push("");
      lines.push("## User");
      lines.push("");
      lines.push(String(t.events[0].body || ""));
      lines.push("");
      continue;
    }
    if (t.kind === "system") {
      lines.push(`> _system:_ ${t.events[0].body || ""}`);
      lines.push("");
      continue;
    }
    // Agent turn
    lines.push("---");
    lines.push("");
    lines.push(`## ${agent.name} (${agent.model})`);
    lines.push("");
    const blocks = turnBlocks(t);
    for (const b of blocks) {
      if (b.kind === "thought") {
        // Extended-thinking block — rendered as a blockquote so the model's
        // internal reasoning stays visually distinct from its actual prose.
        lines.push(`> 💭 ${String(b.e.body || "").replace(/\n/g, "\n> ")}`);
        lines.push("");
      } else if (b.kind === "text") {
        // Plain assistant response — emitted as regular paragraphs.
        lines.push(String(b.e.body || ""));
        lines.push("");
      } else if (b.kind === "tool" || b.kind === "toolpair") {
        const name = stripMcpPrefix(b.tool.tool);
        lines.push(`**Tool: \`${name}\`**`);
        lines.push("");
        lines.push("```json");
        lines.push(String(b.tool.args || ""));
        lines.push("```");
        if (b.kind === "toolpair" && b.result?.body) {
          const isError = b.result.type === "error";
          lines.push(isError ? "_error:_" : "_output:_");
          lines.push("");
          lines.push("```");
          lines.push(String(b.result.body));
          lines.push("```");
        }
        lines.push("");
      } else if (b.kind === "result") {
        if (!b.result.body) continue;
        const isError = b.result.type === "error";
        lines.push(isError ? "_error:_" : "_result:_");
        lines.push("");
        lines.push("```");
        lines.push(String(b.result.body));
        lines.push("```");
        lines.push("");
      }
    }
  }
  return lines.join("\n");
}

/**
 * Triggers a browser download of `content` as a .md file with the given name.
 * Pure DOM — no daemon round-trip.
 */
export function downloadAsFile(filename, content) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
