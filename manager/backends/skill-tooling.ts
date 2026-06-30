// Skill tooling for the in-process lane (§5c) — the `Skill` RuntimeTool surface +
// the DPI prompt metadata block. Mirrors the Task helpers in lane-tooling.ts: the
// static schema/item live here; the executor closes over the SkillCatalog + cwd.
//
// The Skill tool uses the BARE canonical name (BUILTIN_TOOL_NAMES.Skill) so the
// policy stack gates it like any other tool (it classifies "other", like Task). On
// invocation it loads the skill's SKILL.md body and surfaces the skill's directory
// alongside it, so Bash/Read can reach the skill's bundled scripts/assets.

import { BUILTIN_TOOL_NAMES } from "../../contracts/src/builtin-tools.ts";
import type { SkillCatalog, SkillMeta } from "../../core/src/ports/SkillCatalog.ts";
import type { RuntimeTool } from "../../core/src/use-cases/ToolRuntime.ts";
import type { LaneToolItem } from "./lane-tooling.ts";

export const SKILL_TOOL_NAME = BUILTIN_TOOL_NAMES.Skill;

export const SKILL_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    name: { type: "string", description: "The name of the skill to load (one of the skills listed in your instructions)." },
  },
  required: ["name"],
};

// The Skill surface item, overlaying its description from the rendered prompt-library
// map (falls back to the bare name when absent, e.g. unit tests).
export function skillToolItem(descriptions: Record<string, string> = {}): LaneToolItem {
  return { name: SKILL_TOOL_NAME, description: descriptions[SKILL_TOOL_NAME] ?? SKILL_TOOL_NAME, schema: SKILL_TOOL_SCHEMA };
}

// The Skill executor: {name} → the SKILL.md body, prefixed with the skill's
// directory so the model can reach bundled scripts/assets via Bash/Read. An unknown
// skill returns an error string (fed back to the model), never throws.
export function buildSkillTool(catalog: SkillCatalog, cwd: string | null): RuntimeTool {
  return {
    name: SKILL_TOOL_NAME,
    async execute(input) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) return "The `Skill` tool requires a `name`. Choose one of the skills listed in your instructions.";
      const loaded = catalog.loadBody(name, cwd);
      if (!loaded) return `Unknown skill: ${name}. Choose one of the skills listed in your instructions.`;
      return [
        `Skill: ${name}`,
        `Directory: ${loaded.dir}`,
        "(Bundled scripts and assets for this skill live under that directory — reach them with Bash or Read.)",
        "",
        loaded.body,
      ].join("\n");
    },
  };
}

// The skill-metadata block folded into the in-process DPI system prompt (the §5h
// slot). Lists each discovered skill's name + description so the model knows which
// skills exist and can invoke them manually via the Skill tool. Returns null when
// no skills are visible (no fragment to inject).
export function renderAvailableSkills(skills: SkillMeta[]): string | null {
  if (skills.length === 0) return null;
  const lines = skills.map((s) => (s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`));
  return [
    "## Available skills",
    "",
    "You have access to the skills below. A skill is a focused set of instructions you load on demand. When a task matches a skill's description, call the `Skill` tool with its `name` — it returns the skill's instructions plus the directory holding any bundled scripts/assets.",
    "",
    ...lines,
  ].join("\n");
}
