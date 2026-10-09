// What a present / present_app tool call says, read the same way by the
// transcript parser, the ViewBlock and the side panel. Every lane names Eos
// tools mcp__orchestrator__<tool> or mcp__worker__<tool>.

import { parsePartialJson } from "../../../../../contracts/src/genui/partial-json.ts";

const TOOL_RE = /^mcp__(?:orchestrator|worker)__(present|present_app)$/;
const VIEW_ID_IN_TEXT = /\bview (v_[A-Za-z0-9]{12})\b/;

export const GENUI_OFF_TEXT = "Visual answers are off — answer in text";
// core/src/use-cases/PresentView.ts — present_app while apps are switched off.
export const GENUI_APPS_OFF_TEXT = "Apps are turned off in Settings — use present or plain text";

// "view" for present, "app" for present_app, else null.
export function genuiKindOf(name) {
  const m = TOOL_RE.exec(name ?? "");
  if (!m) return null;
  return m[1] === "present" ? "view" : "app";
}

export function isGenuiTool(name) {
  return genuiKindOf(name) !== null;
}

// The minted id from the tool's success text ("view v_… rendered · 6 places").
export function viewIdFromResult(result) {
  if (!result || result.isError) return null;
  return VIEW_ID_IN_TEXT.exec(result.text ?? "")?.[1] ?? null;
}

// Which switch refused the call: "views" (visual answers off), "apps" (apps
// off) or null. Both come back as plain results, so the model answers in text.
export function offKindOf(result) {
  const text = typeof result?.text === "string" ? result.text.trim() : "";
  if (text.startsWith(GENUI_OFF_TEXT)) return "views";
  if (text.startsWith(GENUI_APPS_OFF_TEXT)) return "apps";
  return null;
}

export function isOffResult(result) {
  return offKindOf(result) !== null;
}

// The complete input arrived (the finished call, not a running pulse's {}).
export function isFinalInput(input, kind) {
  if (!input || typeof input !== "object") return false;
  return kind === "app" ? typeof input.html === "string" && input.html.length > 0 : typeof input.ui === "string" && input.ui.length > 0;
}

// A growing input_json_delta prefix → whatever is settled. `ui` may be cut
// mid-string (the markup parser keeps only closed elements).
export function partialInput(text) {
  if (!text) return {};
  const r = parsePartialJson(text, { partialKeys: ["ui"] });
  return r.value && typeof r.value === "object" && !Array.isArray(r.value) ? r.value : {};
}

// The problems block of a rejected call, minus the trailing "fix and call…" hint.
export function problemLines(result) {
  const text = result?.text ?? "";
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("·"))
    .map((l) => l.replace(/^·\s*/, ""));
}
