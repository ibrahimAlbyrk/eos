// SkillCatalog — the discovery + body-load seam for Agent Skills on the
// in-process (metered API) lane. The claude lanes discover skills and auto-trigger
// them inside the bundled binary; the in-process lane has no binary, so it reaches
// skills through this port instead:
//   • listSkills(cwd) — the SKILL.md metadata (name + description) visible from a
//     worker's cwd (project + user + plugin scopes), folded into the assembled DPI
//     system prompt so the model knows which skills exist (§5c metadata injection).
//   • loadBody(name, cwd) — one skill's SKILL.md body AND its absolute directory,
//     returned by the `Skill` RuntimeTool on manual invocation. The dir is surfaced
//     alongside the body so Bash/Read can reach the skill's bundled scripts/assets.
//
// The infra adapter (FileSkillCatalog) generalizes the route-local scanSkills
// discovery; tests provide a fake. The port is tiny (ISP) and lane-neutral.
//
// v1 SCOPE (a deliberate cut, §2.2): discovery + metadata-in-prompt + MANUAL
// invocation — NOT the bundled binary's auto-trigger heuristics.

export interface SkillMeta {
  name: string;
  description: string;
}

export interface SkillBody {
  // The SKILL.md body (YAML frontmatter stripped) — the skill's instructions.
  body: string;
  // The skill's absolute directory. Bundled scripts/assets live under it, so the
  // Skill tool surfaces it for Bash/Read to reach them.
  dir: string;
}

export interface SkillCatalog {
  // Skills visible from this cwd (project .claude/skills, user ~/.claude/skills,
  // installed-plugin skills), de-duplicated by name (first scope wins). A null cwd
  // skips the project scope.
  listSkills(cwd: string | null): SkillMeta[];
  // One skill's body + dir, or null when no such skill is visible from this cwd.
  loadBody(name: string, cwd: string | null): SkillBody | null;
}
