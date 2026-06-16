// The skill body is the SKILL.md content Claude injects on launch, carried in
// the transcript (the only source that works for built-in/plugin skills too —
// those aren't resolvable on disk by name). It opens with an orienting line
// ("Base directory for this skill: <path>") and may carry the SKILL.md
// frontmatter; this module is the single owner of that injected format.

const BASE_DIR_RE = /^Base directory for this skill: (.*)\r?\n+/;

export function skillFilePath(skillPath) {
  return skillPath ? skillPath + "/SKILL.md" : null;
}

export function parseSkillBody(raw) {
  let text = stripFrontmatter(raw ?? "");
  const m = text.match(BASE_DIR_RE);
  const path = m ? m[1].trim() : null;
  if (m) text = stripFrontmatter(text.slice(m[0].length));
  return { path: path || null, body: text };
}

function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? text.slice(m[0].length) : text).replace(/^\s*\n+/, "");
}
