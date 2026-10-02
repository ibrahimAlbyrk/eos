// ScratchWorkspaces — the private folders behind "No folder" agents. Each agent
// gets its own folder that lives exactly as long as the agent row: created at
// spawn, deleted with the agent. Adapter is FsScratchWorkspaces in infra/filesystem/.

export interface ScratchWorkspaces {
  // Creates the agent's folder (a fresh git repo, so worktrees/diffs work) and returns its path.
  create(workerId: string): Promise<string>;
  // Deletes a folder made by create(), plus Claude's data for it. Ignores any
  // path that is not one of its own folders.
  remove(dir: string): Promise<void>;
  // Every folder currently on disk.
  list(): string[];
}
