// Sender tagging — wraps a runtime message in an outer tag that tells the model
// WHO it is talking to, so it can distinguish the human operator from another
// agent (the orchestrator, a peer) from an automated system message. The old
// inline body prefixes ("[worker x] reported…") are collapsed into tag
// attributes here: the body stays clean payload, the identity rides the wrapper.
//
//   agent    → <agent_message from="…" …>BODY</agent_message>
//   system   → <system_message kind="…" …>BODY</system_message>
//   operator → BODY  (untagged — an unadorned turn is always the human operator)
//
// Pure domain: zero Node imports. Both delivery chokepoints (DispatchMessage for
// runtime messages, SpawnWorker for the boot prompt) call applySenderTag; neither
// PTY nor SDK lane tags — they receive the already-wrapped text verbatim.

import type { DispatchEnvelope } from "./message-envelope.ts";

export type SenderClass = "system" | "agent" | "operator";

// Classification is DATA, never inference from the body: it reads the envelope
// kind (+ worker_report provenance), and an absent envelope is the operator.
export function senderClassOf(env: DispatchEnvelope | undefined): SenderClass {
  switch (env?.kind) {
    case "orchestrator_message":
    case "peer_request":
      return "agent";
    case "worker_report":
      // Absent provenance = "agent" — a real worker report predates the field.
      return env.provenance === "system" ? "system" : "agent";
    case "loop":
    case "report_reminder":
    case "permission_ask":
    case "context_threshold":
      return "system";
    default:
      return "operator";
  }
}

// The reserved wrapper tag names. A body may contain these literally — a worker
// quoting a prior tagged message, or a hostile payload trying to forge its own
// wrapper to impersonate the operator/system. One canonical rule neutralizes
// both: entity-escape the `<` of every reserved open/close tag so no literal
// wrapper survives inside a body and only the OUTER tag Eos emits is a boundary.
const RESERVED_TAG = /<(\/?(?:agent_message|system_message)\b)/g;

export function escapeTagBody(body: string): string {
  return body.replace(RESERVED_TAG, "&lt;$1");
}

// Attribute values come from names/ids/branches — escape the XML-significant
// characters so a stray quote can't break out of the attribute.
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Stable insertion order; empty/absent values are dropped so a worktree-less
// report renders no branch="" noise.
function renderAttrs(attrs: Record<string, string | undefined>): string {
  return Object.entries(attrs)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => ` ${k}="${escapeAttr(v as string)}"`)
    .join("");
}

// operator → body unchanged. agent/system → the escaped body on its own lines,
// wrapped in the tag with the given attributes.
export function applySenderTag(
  body: string,
  cls: SenderClass,
  attrs: Record<string, string | undefined> = {},
): string {
  if (cls === "operator") return body;
  const tag = cls === "system" ? "system_message" : "agent_message";
  return `<${tag}${renderAttrs(attrs)}>\n${escapeTagBody(body)}\n</${tag}>`;
}

// The inverse of applySenderTag, for DISPLAY egress. applySenderTag is the only
// producer of these wrappers, but no user-visible surface should ever render one
// — not the chat, an HTML export, an MCP tool result (get_worker's raw timeline),
// nor the live SSE stream. The model can also echo a wrapper into its own output.
// stripSenderTags removes every agent_message/system_message wrapper — at the
// start, end, or MID-text, one occurrence or many — and unwraps the inner body,
// reversing escapeTagBody's entity-escape. Untagged text passes through unchanged.
// Display-only: callers run it on a COPY, never on stored rows.
const SENDER_TAG_WRAPPER = /<(agent_message|system_message)\b[^>]*>([\s\S]*?)<\/\1>/g;
const ESCAPED_RESERVED_TAG = /&lt;(\/?(?:agent_message|system_message)\b)/g;

export function stripSenderTags(text: string): string {
  if (!text || (!text.includes("<agent_message") && !text.includes("<system_message"))) {
    return text;
  }
  return text.replace(SENDER_TAG_WRAPPER, (_m, _tag, body: string) => {
    // applySenderTag renders the body as `>\n${escapeTagBody(body)}\n</` — drop the
    // one leading and one trailing newline it added, then reverse the escape so the
    // body's own quoted tags come back as literal text.
    let inner = body;
    if (inner.startsWith("\n")) inner = inner.slice(1);
    if (inner.endsWith("\n")) inner = inner.slice(0, -1);
    return inner.replace(ESCAPED_RESERVED_TAG, "<$1");
  });
}

// The single place envelope routing metadata becomes tag attributes. Returns the
// class + attribute map for an agent/system envelope, or null for the operator
// (an absent envelope, delivered untagged). `from` is the primary attribute for
// an agent tag, `kind` for a system tag.
export function senderTagForEnvelope(
  env: DispatchEnvelope | undefined,
): { cls: "agent" | "system"; attrs: Record<string, string | undefined> } | null {
  const cls = senderClassOf(env);
  if (cls === "operator" || !env) return null;
  switch (env.kind) {
    case "orchestrator_message":
      return { cls, attrs: { from: env.parentName ?? env.fromParent, "from-id": env.fromParent } };
    case "peer_request":
      return { cls, attrs: { from: env.fromName ?? env.fromWorker, "from-id": env.fromWorker } };
    case "worker_report":
      return cls === "system"
        ? { cls, attrs: { kind: "worker_report", from: env.workerName ?? env.fromWorker, "worker-id": env.fromWorker, branch: env.branch, worktree: env.worktreeDir, status: env.status } }
        : { cls, attrs: { from: env.workerName ?? env.fromWorker, "worker-id": env.fromWorker, branch: env.branch, worktree: env.worktreeDir } };
    case "loop":
      return { cls, attrs: { kind: "dynamic_loop", attempt: env.attempt != null ? String(env.attempt) : undefined } };
    case "report_reminder":
      return { cls, attrs: { kind: "report_reminder" } };
    case "permission_ask":
      return {
        cls,
        attrs: {
          kind: "permission_ask",
          from: env.workerName ?? env.fromWorker,
          "worker-id": env.fromWorker,
          tool: env.toolName,
          summary: env.inputSummary,
          "pending-id": env.pendingId,
          "expires-at": env.expiresAt != null ? String(env.expiresAt) : undefined,
        },
      };
    case "context_threshold":
      return {
        cls,
        attrs: {
          kind: "context_threshold",
          stage: env.stage,
          from: env.workerName ?? env.fromWorker,
          "worker-id": env.fromWorker,
          pct: env.pct != null ? String(env.pct) : undefined,
        },
      };
  }
}
