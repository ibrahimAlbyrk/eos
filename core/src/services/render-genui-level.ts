// {{GENUI_LEVEL}} in the visual-answers fragments: how readily this session
// answers with a view, from the user's `genui.level` setting. Fixed at spawn like
// every prompt variable, so a change reaches new and resumed sessions only — the
// present route enforces "text" at call time for the sessions already running.

import type { GenuiLevel } from "../../../contracts/src/genui/spec.ts";

export function normalizeGenuiLevel(v: unknown): GenuiLevel {
  return v === "rich" || v === "text" ? v : "balanced";
}

const LEVEL_TEXT: Record<GenuiLevel, string> = {
  rich: "The user set visual answers to **rich**: present whenever the answer has structure — options, a list, steps, numbers — even a small one. A one-line answer, code and reasoning stay text.",
  balanced: "The user set visual answers to **balanced**: present when a view clearly beats prose (the cases below); otherwise answer in text.",
  text: "The user turned visual answers **off**: answer in text and markdown, never with a view or an app.",
};

export function renderGenuiLevel(level: unknown): string {
  return LEVEL_TEXT[normalizeGenuiLevel(level)];
}
