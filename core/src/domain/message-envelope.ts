// The kind + routing metadata of an agent-plane message (worker report,
// orchestrator directive, peer request). Absent → a plain user_message.
//
// Lives in the domain because two layers speak it: DispatchMessage (delivery —
// derives the PTY record and the in-process daemon-side chat event from it) and
// MessageQueueRepo (persistence — a report queued behind a busy parent must
// replay as a worker_report, not a plain user_message). A port importing it
// from the use-case would invert the dependency direction.
//
// The sender-tag formatter (sender-tag.ts) also reads it: the routing fields
// double as the attributes rendered into the outer <agent_message>/<system_message>
// wrapper delivered to the model. The old inline body prefixes ("[worker x]
// reported…", "[Peer request from…]") are gone — that identity now rides here.
export type DispatchEnvelope =
  | { kind: "orchestrator_message"; fromParent: string; parentName?: string }
  | {
      kind: "worker_report";
      // Who authored the body. "agent" = the worker's own report (or a held
      // report the loop released verbatim). "system" = a message the daemon
      // synthesized on the worker's behalf (a loop that just stopped, a workflow
      // run completion). Absent → treated as "agent" (back-compat for envelopes
      // persisted in the queue before this field existed). Drives whether the
      // wrapper is <agent_message> or <system_message>.
      provenance?: "agent" | "system";
      fromWorker: string;
      workerName?: string;
      // The worktree merge handle — surfaced as branch/worktree tag attributes so
      // the parent still gets it even when the worker omitted its Handover line.
      branch?: string;
      worktreeDir?: string;
      // A workflow-run completion rides this variant (fromWorker = runId): the
      // run's terminal status surfaces as a status attribute.
      status?: string;
    }
  | { kind: "peer_request"; fromWorker: string; fromName?: string }
  // A dynamic-loop automated re-trigger delivered to the looped worker. Rendered
  // as a <system_message kind="dynamic_loop"> so the worker (and the human
  // watching) can tell it apart from an operator turn; attempt rides as an attr.
  | { kind: "loop"; attempt?: number }
  // A daemon-injected safety-net nudge to a worker that went IDLE having never
  // reported this life. Rendered as a <system_message kind="report_reminder">;
  // no payload — the body is the rendered reminder template.
  | { kind: "report_reminder" };
