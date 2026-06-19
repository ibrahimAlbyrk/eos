// Single declared set of non-regenerable user data under the daemon home.
// Every protection mechanism (StartupBackupService, future home migrations)
// consumes this list — when a new user-data file/dir is added to the home,
// it MUST be added here or it silently falls outside every safety net.
// Entries missing on disk are skipped, so listing optional files is safe.
export const USER_DATA_ENTRIES = [
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "templates",
  "prompts",
  // User-authored worker types (~/.eos/workers/*.md) — new non-regenerable
  // user data; without this they fall outside every backup/migration safety net.
  "workers",
  "policy.yaml",
  "config.json",
  // Files-explorer trash fallback (used only when the macOS Finder Trash is
  // unavailable, or on non-darwin). Usually absent → skipped by backups.
  ".eos-trash",
] as const;
