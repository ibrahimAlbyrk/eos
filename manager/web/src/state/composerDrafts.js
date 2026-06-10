// Per-agent composer drafts. The composer is a single instance shared by
// every agent, so unsent input must be stashed per agent id and restored on
// switch — the same isolation principle as gitStatusStore: the input you see
// always belongs to the selected agent, never another's. In-memory by design:
// attachment label→path resolution (useAttachments pathsRef) doesn't survive
// a reload, so persisted drafts would restore half-broken.

const drafts = new Map();

// Key for the no-selection ("+" new agent) composer — `~` is outside the
// generated id alphabet, so it can't collide with a real agent id.
export const NEW_AGENT_KEY = "~new";

export const draftKey = (selectedId) => selectedId ?? NEW_AGENT_KEY;

// A draft with no text and no attachments is empty even if cursor/paths
// linger; an active git/term mode alone is worth restoring (the mode changes
// what Enter does).
export function isEmptyDraft(d) {
  return !d || (!d.text && (d.attachments?.length ?? 0) === 0 && !d.gitMode && !d.termMode);
}

export function getDraft(key) {
  return drafts.get(key) ?? null;
}

export function saveDraft(key, draft) {
  if (isEmptyDraft(draft)) drafts.delete(key);
  else drafts.set(key, draft);
}

export function deleteDraft(key) {
  drafts.delete(key);
}
