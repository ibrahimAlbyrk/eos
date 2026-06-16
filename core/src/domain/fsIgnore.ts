// Directory entries hidden from project listings, search, and watching (VCS
// internals, dependency caches, build output). Single source shared by the
// infra filesystem adapters and the manager fs routes — never duplicate this
// list; import it.

export const IGNORED_ENTRIES = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  "__pycache__",
  ".next",
  ".nuxt",
  "dist",
  "build",
  ".cache",
]);
