import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import type { CommandItem } from "../../contracts/src/http.ts";

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try { return parseYaml(match[1]) ?? {}; } catch {
    // fallback: line-by-line extraction for malformed YAML
    const result: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const m = line.match(/^(\w[\w-]*):\s*(.+)/);
      if (m) result[m[1]] = m[2].trim();
    }
    return result;
  }
}

function scanCommands(dir: string, source: CommandItem["source"]): CommandItem[] {
  if (!existsSync(dir)) return [];
  const results: CommandItem[] = [];

  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".md")) continue;

      const rel = relative(dir, full);
      const pathName = rel
        .replace(/\.md$/, "")
        .replace(/\//g, ":");

      try {
        const content = readFileSync(full, "utf8");
        const fm = parseFrontmatter(content);
        const name = typeof fm.name === "string" ? fm.name : pathName;
        const finalName = pathName.includes(":") && typeof fm.name === "string"
          ? pathName.replace(/:[^:]+$/, `:${fm.name}`)
          : name;

        results.push({
          name: finalName,
          description: typeof fm.description === "string" ? fm.description : "",
          source,
          argumentHint: typeof fm["argument-hint"] === "string"
            ? fm["argument-hint"]
            : Array.isArray(fm["argument-hint"])
              ? `[${fm["argument-hint"].join(" | ")}]`
              : undefined,
        });
      } catch {}
    }
  }

  walk(dir);
  return results;
}

function scanSkills(dir: string, source: CommandItem["source"]): CommandItem[] {
  if (!existsSync(dir)) return [];
  const results: CommandItem[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillFile = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      try {
        const content = readFileSync(skillFile, "utf8");
        const fm = parseFrontmatter(content);
        results.push({
          name: typeof fm.name === "string" ? fm.name : entry.name,
          description: typeof fm.description === "string" ? fm.description : "",
          source,
        });
      } catch {}
    }
  } catch {}
  return results;
}

function scanInstalledPluginSkills(): CommandItem[] {
  const manifestPath = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(manifestPath)) return [];
  const results: CommandItem[] = [];
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const plugins = manifest.plugins ?? {};
    for (const entries of Object.values(plugins) as any[]) {
      for (const entry of entries) {
        const installPath = entry.installPath;
        if (!installPath || !existsSync(installPath)) continue;
        const skillsDir = join(installPath, "skills");
        results.push(...scanSkills(skillsDir, "plugin"));
      }
    }
  } catch {}
  return results;
}

type SkillHit = { path: string; content: string };

function findSkillInDir(dir: string, name: string): SkillHit | null {
  if (!existsSync(dir)) return null;
  const direct = join(dir, name, "SKILL.md");
  if (existsSync(direct)) {
    try { return { path: direct, content: readFileSync(direct, "utf8") }; } catch { return null; }
  }
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillFile = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      try {
        const content = readFileSync(skillFile, "utf8");
        if (parseFrontmatter(content).name === name) return { path: skillFile, content };
      } catch {}
    }
  } catch {}
  return null;
}

function findSkillInPlugins(name: string): SkillHit | null {
  const manifestPath = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const entries of Object.values(manifest.plugins ?? {}) as any[]) {
      for (const entry of entries) {
        if (!entry.installPath) continue;
        const hit = findSkillInDir(join(entry.installPath, "skills"), name);
        if (hit) return hit;
      }
    }
  } catch {}
  return null;
}

function resolveSkill(name: string, cwd: string | undefined): { hit: SkillHit; source: "project" | "user" | "plugin" } | null {
  if (cwd) {
    const projectHit = findSkillInDir(join(cwd, ".claude", "skills"), name);
    if (projectHit) return { hit: projectHit, source: "project" };
  }
  const userHit = findSkillInDir(join(homedir(), ".claude", "skills"), name);
  if (userHit) return { hit: userHit, source: "user" };
  const pluginHit = findSkillInPlugins(name);
  if (pluginHit) return { hit: pluginHit, source: "plugin" };
  return null;
}

export function registerCommandRoutes(r: Router, _c: Container): void {
  r.get("/skills/read", ({ url, res }) => {
    const name = url.searchParams.get("name");
    if (!name) { writeJson(res, 400, { error: "name required" }); return; }
    const cwd = url.searchParams.get("cwd") ?? undefined;
    const found = resolveSkill(name, cwd);
    if (!found) { writeJson(res, 404, { error: "skill not found" }); return; }
    writeJson(res, 200, {
      name,
      path: found.hit.path,
      content: found.hit.content,
      source: found.source,
      lines: found.hit.content.split("\n").length,
    });
  });

  r.get("/commands", ({ url, res }) => {
    const cwd = url.searchParams.get("cwd") ?? undefined;
    const home = homedir();

    const items: CommandItem[] = [];

    // project commands + skills (highest priority)
    if (cwd) {
      items.push(...scanCommands(join(cwd, ".claude", "commands"), "project"));
      items.push(...scanSkills(join(cwd, ".claude", "skills"), "project"));
    }

    // user commands
    items.push(...scanCommands(join(home, ".claude", "commands"), "user"));

    // user skills
    items.push(...scanSkills(join(home, ".claude", "skills"), "skill"));

    // installed plugin skills
    items.push(...scanInstalledPluginSkills());

    // deduplicate: first occurrence wins (project > user > skill > plugin)
    const seen = new Set<string>();
    const deduped = items.filter((c) => {
      if (seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    });

    writeJson(res, 200, { commands: deduped });
  });
}
