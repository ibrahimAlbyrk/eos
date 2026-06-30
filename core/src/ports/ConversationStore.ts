// ConversationStore — durable persistence for an in-process lane's conversation
// so a metered/API worker (incl. a persistent orchestrator) survives a daemon
// restart instead of being closed DONE. Keyed by the durable sessionId
// (IdGenerator.newSessionId) the daemon persists on the worker row via the
// `session ready` event, so boot reconcile keeps the row SUSPENDED and ResumeWorker
// can revive it.
//
// The stored ModelMessages are dialect-NEUTRAL — the in-process loop accumulates
// neutral user/assistant-tool-call/tool-result messages (ToolRuntime), and each
// model client converts to its own wire shape at request time. So any in-process
// kind sharing the "eos-conversation" store can rehydrate the same transcript.
//
// Non-regenerable user data (JSONL under ~/.eos/conversations) — never delete the
// store directory by hand.

import type { ModelMessage } from "./ModelClient.ts";

export interface ConversationStore {
  // Persist the full conversation for a session (rewrite-on-save). Called after
  // each settled turn, at the one place the in-process loop mutates its messages.
  save(workerId: string, sessionId: string, messages: ModelMessage[]): void;
  // Rehydrate a prior conversation on resume; null when none is stored.
  load(sessionId: string): ModelMessage[] | null;
  // Drop a conversation (the /clear path) so the next turn starts from empty.
  delete(sessionId: string): void;
}
