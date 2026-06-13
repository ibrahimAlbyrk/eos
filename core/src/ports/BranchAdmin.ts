// BranchAdmin — narrow write port for local branch ref management (create /
// rename / delete). Kept separate from the read-only GitInfo and from the
// remote-facing RemoteSync (ISP): purely local ref mutation, no network. Never
// throws — failures come back as a classified result the route maps to HTTP.

export interface BranchOpResult {
  ok: boolean;
  branch?: string;   // resulting branch name on success
  error?: string;    // git stderr (trimmed) on failure
}

export interface BranchDeleteResult {
  ok: boolean;
  deleted?: boolean;
  notMerged?: boolean;  // safe delete (-d) refused: branch not fully merged → offer force
  error?: string;
}

export interface BranchAdmin {
  /** `git branch <name> [startPoint]`, or `git switch -c <name> [startPoint]`
   *  when checkout=true (create & switch). startPoint null → from current HEAD. */
  create(cwd: string, name: string, startPoint: string | null, opts: { checkout: boolean }): Promise<BranchOpResult>;
  /** `git branch -m <from> <to>`. */
  rename(cwd: string, from: string, to: string): Promise<BranchOpResult>;
  /** `git branch -d|-D <name>`. With force=false, a not-fully-merged branch
   *  comes back as { ok:false, notMerged:true } so the UI can offer force. */
  remove(cwd: string, name: string, opts: { force: boolean }): Promise<BranchDeleteResult>;
}
