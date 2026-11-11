import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeCwd } from "../../core/src/domain/claude-paths.ts";

// Where Claude Code keeps a session's transcript:
// ~/.claude/projects/<encodeCwd(realpath cwd)>/<sessionId>.jsonl. encodeCwd needs
// a realpath'd cwd; the raw cwd stands in when it can't be resolved.
//
// A session that entered a git worktree (EnterWorktree) has its transcript under
// the worktree's project folder, not the one it started in. Session ids are
// unique, so the file is looked up by id across every project folder; the copy
// written last is the live one. No file yet → the path it will get in `cwd`.
export function claudeTranscriptPath(
  cwd: string,
  sessionId: string,
  projectsDir: string = join(homedir(), ".claude", "projects"),
): string {
  let dir = cwd;
  try { dir = realpathSync(cwd); } catch { /* keep the raw cwd */ }
  const file = `${sessionId}.jsonl`;
  return lastWritten(projectsDir, file) ?? join(projectsDir, encodeCwd(dir), file);
}

function lastWritten(projectsDir: string, file: string): string | null {
  let folders: string[];
  try { folders = readdirSync(projectsDir); } catch { return null; }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const folder of folders) {
    const path = join(projectsDir, folder, file);
    let mtimeMs: number;
    try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
    if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
  }
  return best?.path ?? null;
}
