// FileSkillCatalog — the Node SkillCatalog adapter, generalizing the route-local
// scanSkills discovery (manager/routes/commands.ts) into a reusable catalog the
// in-process lane consumes. Discovers Agent Skills from three scopes, project
// winning on a name clash:
//   • project — <cwd>/.claude/skills/<name>/SKILL.md
//   • user    — ~/.claude/skills/<name>/SKILL.md
//   • plugin  — installed-plugin skills/ dirs (~/.claude/plugins/installed_plugins.json)
//
// listSkills returns the metadata (name + description) folded into the DPI prompt;
// loadBody returns one skill's SKILL.md body (frontmatter stripped) AND its absolute
// directory, so the Skill RuntimeTool can point Bash/Read at bundled scripts/assets.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

import type { SkillCatalog, SkillMeta, SkillBody } from "../../../core/src/ports/SkillCatalog.ts";

interface DiscoveredSkill {
  name: string;
  description: string;
  dir: string;
}

function parseFrontmatter(content: string): { fm: Record<string, unknown>; bodyStart: number } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { fm: {}, bodyStart: 0 };
  let fm: Record<string, unknown> = {};
  try {
    fm = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
  } catch {
    // Malformed YAML: pull simple `key: value` lines so name/description survive.
    for (const line of match[1].split("\n")) {
      const m = line.match(/^(\w[\w-]*):\s*(.+)/);
      if (m) fm[m[1]] = m[2].trim();
    }
  }
  return { fm, bodyStart: match[0].length };
}

// One scope dir's skills: each immediate subdir with a SKILL.md.
function scanSkillDir(dir: string): DiscoveredSkill[] {
  if (!existsSync(dir)) return [];
  const out: DiscoveredSkill[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillDir = join(dir, entry.name);
      const skillFile = join(skillDir, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      try {
        const { fm } = parseFrontmatter(readFileSync(skillFile, "utf8"));
        out.push({
          name: typeof fm.name === "string" ? fm.name : entry.name,
          description: typeof fm.description === "string" ? fm.description : "",
          dir: skillDir,
        });
      } catch {}
    }
  } catch {}
  return out;
}

function pluginSkillDirs(home: string): string[] {
  const manifestPath = join(home, ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(manifestPath)) return [];
  const dirs: string[] = [];
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const plugins = manifest.plugins ?? {};
    for (const entries of Object.values(plugins) as unknown[]) {
      for (const entry of entries as Array<{ installPath?: string }>) {
        if (entry.installPath && existsSync(entry.installPath)) {
          dirs.push(join(entry.installPath, "skills"));
        }
      }
    }
  } catch {}
  return dirs;
}

export interface FileSkillCatalogOpts {
  // Override the home dir (tests). Defaults to os.homedir().
  home?: string;
}

export function createFileSkillCatalog(opts: FileSkillCatalogOpts = {}): SkillCatalog {
  const home = opts.home ?? homedir();

  // All scopes in precedence order (project → user → plugin). De-dup by name,
  // first occurrence wins — matching the /commands route's dedup.
  const discover = (cwd: string | null): DiscoveredSkill[] => {
    const scopes: DiscoveredSkill[] = [];
    if (cwd) scopes.push(...scanSkillDir(join(cwd, ".claude", "skills")));
    scopes.push(...scanSkillDir(join(home, ".claude", "skills")));
    for (const d of pluginSkillDirs(home)) scopes.push(...scanSkillDir(d));
    const seen = new Set<string>();
    return scopes.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));
  };

  return {
    listSkills(cwd: string | null): SkillMeta[] {
      return discover(cwd).map((s) => ({ name: s.name, description: s.description }));
    },
    loadBody(name: string, cwd: string | null): SkillBody | null {
      const found = discover(cwd).find((s) => s.name === name);
      if (!found) return null;
      try {
        const content = readFileSync(join(found.dir, "SKILL.md"), "utf8");
        const { bodyStart } = parseFrontmatter(content);
        return { body: content.slice(bodyStart).trim(), dir: found.dir };
      } catch {
        return null;
      }
    },
  };
}
