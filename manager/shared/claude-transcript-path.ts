import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeCwd } from "../../core/src/domain/claude-paths.ts";

// Where Claude Code keeps a session's transcript:
// ~/.claude/projects/<encodeCwd(realpath cwd)>/<sessionId>.jsonl. encodeCwd needs
// a realpath'd cwd; the raw cwd stands in when it can't be resolved.
export function claudeTranscriptPath(cwd: string, sessionId: string): string {
  let dir = cwd;
  try { dir = realpathSync(cwd); } catch { /* keep the raw cwd */ }
  return join(homedir(), ".claude", "projects", encodeCwd(dir), `${sessionId}.jsonl`);
}
