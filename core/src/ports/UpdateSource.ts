// UpdateSource — read-only detection of whether the dedicated server has a
// newer build than the local install. Deliberately narrow (one method) so a
// second implementation (an HTTP release manifest) can replace the git one
// without the service changing. The git adapter fetches and compares the
// current checkout to its upstream.

export interface UpdateRevision {
  sha: string;
  subject: string;
}

export interface UpdateCheck {
  branch: string;
  currentSha: string;
  latestSha: string;
  /** How many commits the local checkout is behind its upstream (0 = current). */
  behind: number;
  /** Working tree has uncommitted changes — the service refuses auto-apply so a
   *  developer's checkout is never clobbered (ff-only would fail anyway). */
  dirty: boolean;
  /** Commits that would be pulled, newest first. */
  notes: UpdateRevision[];
}

export interface UpdateSource {
  /** Fetches from the remote, then compares. Returns null when the path is not
   *  a git repo, has no upstream, or the remote is unreachable — null means
   *  "can't offer an update", never a stale positive. */
  check(repoRoot: string): Promise<UpdateCheck | null>;
}
