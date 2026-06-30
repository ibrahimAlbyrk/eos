// Glob — match files against a glob pattern (e.g. "**/*.ts", "src/*.js"), returning
// absolute paths newest-first (by mtime), matching the bundled binary. Walks via the
// ToolFileSystem port (so it is fakeable); skips .git / node_modules to bound cost.
// Canonical fields: pattern, path?.

import { join, isAbsolute, resolve } from "node:path";
import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";
import type { ToolFileSystem } from "../../../../core/src/ports/ToolFileSystem.ts";
import { requireString } from "./_shared.ts";

const SKIP_DIRS = new Set([".git", "node_modules"]);

function globToRegExp(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") { re += "[^/]"; i++; continue; }
    if ("\\^$.|+()[]{}".includes(c)) { re += "\\" + c; i++; continue; }
    re += c;
    i++;
  }
  return new RegExp(re + "$");
}

export function createGlobTool(fs: ToolFileSystem): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.Glob,
    description: "Find files matching a glob pattern (supports ** and *), sorted by modification time (newest first).",
    schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob pattern, e.g. **/*.ts" },
        path: { type: "string", description: "Directory to search in (defaults to the working directory)." },
      },
      required: ["pattern"],
    },
    async execute(input, ctx) {
      const pattern = requireString(input, "pattern");
      const base = typeof input.path === "string" && input.path
        ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path))
        : ctx.cwd;
      const re = globToRegExp(pattern);
      const matches: Array<{ path: string; mtimeMs: number }> = [];

      const walk = async (dir: string, rel: string): Promise<void> => {
        let entries;
        try {
          entries = await fs.readDir(dir);
        } catch {
          return;
        }
        for (const e of entries) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          const childAbs = join(dir, e.name);
          if (e.type === "directory") {
            if (SKIP_DIRS.has(e.name)) continue;
            await walk(childAbs, childRel);
          } else if (re.test(childRel)) {
            try {
              const s = await fs.stat(childAbs);
              matches.push({ path: childAbs, mtimeMs: s.mtimeMs });
            } catch {
              matches.push({ path: childAbs, mtimeMs: 0 });
            }
          }
        }
      };
      await walk(base, "");
      matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return matches.length > 0 ? matches.map((m) => m.path).join("\n") : "(no matches)";
    },
  };
}
