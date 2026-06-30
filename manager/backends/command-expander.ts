// createCommandTemplateExpander — the manager glue behind DispatchMessage's
// `expandTemplate` hook (§5c). Discovers a prompt-template `.md` slash-command,
// reads it, and runs the pure core expander (expandCommandTemplate) with file/shell
// seams bound to the worker's cwd. Used ONLY on lanes that don't expand natively
// (the in-process lane); the gating lives in DispatchMessage (on the capability).
//
// Discovery mirrors scanCommands' path convention: `/dir:bar` → `dir/bar.md`, project
// (<cwd>/.claude/commands) winning over user (~/.claude/commands). A non-`/` message,
// or a `/command` with no matching `.md`, returns null → DispatchMessage dispatches
// the raw text unchanged.

import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

import { expandCommandTemplate } from "../../core/src/domain/command-template.ts";
import type { ToolFileSystem } from "../../core/src/ports/ToolFileSystem.ts";
import type { ProcessRunner } from "../../core/src/ports/ProcessRunner.ts";

export interface CommandExpanderDeps {
  fs: ToolFileSystem;
  proc: ProcessRunner;
  // Override the home dir (tests). Defaults to os.homedir().
  home?: string;
  // !`cmd` timeout (ms). Default 30s.
  commandTimeoutMs?: number;
}

function stripFrontmatter(content: string): string {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? content.slice(m[0].length) : content;
}

export function createCommandTemplateExpander(
  deps: CommandExpanderDeps,
): (text: string, cwd: string | null) => Promise<string | null> {
  const home = deps.home ?? homedir();
  const timeoutMs = deps.commandTimeoutMs ?? 30_000;

  const candidatePaths = (name: string, cwd: string | null): string[] => {
    const rel = `${name.replace(/:/g, "/")}.md`;
    const paths: string[] = [];
    if (cwd) paths.push(join(cwd, ".claude", "commands", rel));
    paths.push(join(home, ".claude", "commands", rel));
    return paths;
  };

  return async (text: string, cwd: string | null): Promise<string | null> => {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;
    const sp = trimmed.indexOf(" ");
    const name = sp === -1 ? trimmed.slice(1) : trimmed.slice(1, sp);
    const args = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
    if (!name) return null;

    let mdPath: string | null = null;
    for (const candidate of candidatePaths(name, cwd)) {
      if (await deps.fs.exists(candidate)) { mdPath = candidate; break; }
    }
    if (!mdPath) return null;

    const body = stripFrontmatter(await deps.fs.readFile(mdPath));
    const base = cwd ?? home;
    return expandCommandTemplate(body, args, {
      run: async (command) => {
        const r = await deps.proc.run(command, { cwd: base, timeoutMs });
        return (r.stdout || r.stderr || "").replace(/\s+$/, "");
      },
      readFile: (p) => deps.fs.readFile(isAbsolute(p) ? p : resolve(base, p)),
    });
  };
}
