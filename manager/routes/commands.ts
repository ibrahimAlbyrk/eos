import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import type { CommandItem } from "../../contracts/src/http.ts";

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try { return parseYaml(match[1]) ?? {}; } catch { return {}; }
}

function scanCommands(dir: string, source: "user" | "project"): CommandItem[] {
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
          argumentHint: typeof fm["argument-hint"] === "string" ? fm["argument-hint"] : undefined,
        });
      } catch {}
    }
  }

  walk(dir);
  return results;
}

export function registerCommandRoutes(r: Router, _c: Container): void {
  r.get("/commands", ({ url, res }) => {
    const cwd = url.searchParams.get("cwd") ?? undefined;

    const userDir = join(homedir(), ".claude", "commands");
    const commands: CommandItem[] = scanCommands(userDir, "user");

    if (cwd) {
      const projectDir = join(cwd, ".claude", "commands");
      const projectCmds = scanCommands(projectDir, "project");
      const seen = new Set(projectCmds.map((c) => c.name));
      commands.unshift(...projectCmds);
      // deduplicate: project commands override user commands with same name
      const deduped = commands.filter((c, i) => {
        if (c.source === "project") return true;
        return !seen.has(c.name);
      });
      writeJson(res, 200, { commands: deduped });
    } else {
      writeJson(res, 200, { commands });
    }
  });
}
