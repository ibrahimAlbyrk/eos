// Centralized daemon route table — the single place URLs live in the
// frontend. Every fetch in the codebase resolves its path through here so a
// daemon endpoint rename is one edit, not a hunt.
//
// Mirrors contracts/src/http.ts ROUTES. Kept duplicated rather than imported
// because Vite/esbuild doesn't ergonomically pull from ../../../contracts
// without workspace config; the cost of one shadow constants file is small
// compared to the cost of misaligned URLs.

export const ROUTES = {
  health: "/health",
  stream: "/stream",
  workers: "/workers",
  worker: (id) => `/workers/${id}`,
  workerEvents: (id) => `/workers/${id}/events`,
  workerMessage: (id) => `/workers/${id}/message`,
  orchestrators: "/orchestrators",
  orchestratorMessage: (id) => `/orchestrators/${id}/message`,
  policyDecide: "/policy/decide",
  pending: "/pending",
  pendingDecision: (id) => `/pending/${id}/decision`,
  session: "/session",
  metrics: "/metrics",
  uiConfig: "/api/ui-config",
  pickDirectory: "/pick-directory",
  pickFile: "/pick-file",
  fsImage: "/fs/image",
  fsDefaultApp: "/fs/default-app",
  fsOpen: "/fs/open",
  fsIcon: "/fs/icon",
  fsBranches: "/fs/branches",
  fsCheckout: "/fs/checkout",
  fsRecents: "/fs/recents",
  fsRead: "/fs/read",
  fsWrite: "/fs/write",
  fsReveal: "/fs/reveal",
  workerName: (id) => `/workers/${id}/name`,
  workerPermission: (id) => `/workers/${id}/permission`,
  workerModel: (id) => `/workers/${id}/model`,
  workerDiff: (id) => `/workers/${id}/diff`,
  workerInterrupt: (id) => `/workers/${id}/interrupt`,
  commands: "/commands",
  fsList: "/fs/list",
  policyRule: "/api/policy/rule",
};
