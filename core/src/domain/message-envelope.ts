// The kind + routing metadata of an agent-plane message (worker report,
// orchestrator directive, peer request). Absent → a plain user_message.
//
// Lives in the domain because two layers speak it: DispatchMessage (delivery —
// derives the PTY record and the in-process daemon-side chat event from it) and
// MessageQueueRepo (persistence — a report queued behind a busy parent must
// replay as a worker_report, not a plain user_message). A port importing it
// from the use-case would invert the dependency direction.
export type DispatchEnvelope =
  | { kind: "orchestrator_message"; fromParent: string; parentName?: string }
  | { kind: "worker_report"; fromWorker: string; workerName?: string }
  | { kind: "peer_request"; fromWorker: string; fromName?: string }
  // A dynamic-loop automated re-trigger delivered to the looped worker. Marks the
  // chat event as a "Dynamic loop" system message (not a user bubble) so the human
  // watching can tell it apart from their own input.
  | { kind: "loop" };
