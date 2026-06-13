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
  "policy.yaml",
  "config.json",
] as const;
