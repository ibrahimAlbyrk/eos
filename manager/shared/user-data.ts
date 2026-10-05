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
  // User-authored worker definitions (~/.eos/workers/*.md) — non-regenerable user
  // data; without this they fall outside every backup/migration safety net.
  "workers",
  // Pages (~/.eos/pages/*.md) — notes the user and agents write together.
  // Non-regenerable: kept out of state.db so a --db wipe never takes them.
  "pages",
  // The user's profile, avatar and memories (~/.eos/profile/) — what every agent is
  // told about the user. Non-regenerable, kept out of state.db for the same reason.
  "profile",
  // Durable in-process conversations (~/.eos/conversations/<sessionId>.jsonl) — a
  // metered/API worker's transcript, replayed on resume. Non-regenerable: losing
  // it closes a SUSPENDED worker that could have resumed (M3 durability).
  "conversations",
  // Browser profiles (~/.eos/browser/) — cookies/logins, one subdir per
  // session ("profile" = the global session, <sessionKey> = per-session
  // Chromes). Non-regenerable: losing it logs the user out everywhere.
  "browser",
  // Eos's own CLI sign-ins (~/.eos/accounts/{claude,codex,gemini}) — the Codex
  // and Gemini logins plus their session history. Non-regenerable: losing it
  // signs Eos out of every plan.
  "accounts",
  // Eos ↔ Eos peering (~/.eos/peer/): this device's identity key + cert, the
  // devices allowed to control it and the hosts it controls. Non-regenerable:
  // losing it forces every paired computer to pair again.
  "peer",
  // Sync (~/.eos/sync/): the sync key (on a Mac whose other Macs are gone, the
  // only way back into the account), its index and kept conflicts.
  "sync",
  // User projects (~/.eos/projects.json) — names, icons, source folders.
  "projects.json",
  "policy.yaml",
  "config.json",
  // Files-explorer trash fallback (used only when the macOS Finder Trash is
  // unavailable, or on non-darwin). Usually absent → skipped by backups.
  ".eos-trash",
] as const;
