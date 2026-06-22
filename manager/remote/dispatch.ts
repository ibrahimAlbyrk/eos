// Control-dispatch shim (design §2.1, protocol §8). A decrypted client
// control{method,path,body} is tier-classified, step-up-enforced, ui-token-
// gated, then dispatched into the EXISTING route handlers via an injected
// virtual-response dispatcher (the daemon wires the real router; tests inject a
// fake). The reply/challenge/error it returns is an inner server frame the
// session then seals. /stepup/challenge is a virtual route handled HERE, never
// in manager/routes/*.

import { classifyTier } from "./tiers.ts";
import { verifyStepUp, type ChallengeStore } from "./stepup.ts";
import type { DeviceKeyring } from "./keyring.ts";
import type { RemoteAuditLog } from "./audit.ts";
import type { ControlFrame, RemoteErrorCode } from "../../contracts/src/remote.ts";

// Dispatch into the real route layer. The daemon builds this over a virtual
// req/res into its Router; `uiToken` is supplied only for ✦ routes the device
// is entitled to (§4.5).
export interface RouteDispatch {
  (input: { method: string; path: string; body: unknown; uiToken?: string }): Promise<{ status: number; body: unknown }>;
}

// The post-handshake session as the dispatcher needs it.
export interface DispatchSession {
  devId: string;
  sessionTH: Buffer;
  challenges: ChallengeStore;
  hasCap(cap: string): boolean;
}

export interface DispatcherDeps {
  routeDispatch: RouteDispatch;
  keyring: DeviceKeyring;
  audit: RemoteAuditLog;
  uiToken: string; // local per-boot token supplied to entitled ✦ routes
  now: () => number;
}

export type ServerReplyFrame =
  | { t: "reply"; correlationId: string; status: number; body: unknown }
  | { t: "challenge"; challengeNonce: string; expiresAt: number; correlationId: string }
  | { t: "error"; code: RemoteErrorCode; message: string; correlationId: string };

const STEPUP_CHALLENGE_PATH = "/stepup/challenge";

export class ControlDispatcher {
  private readonly deps: DispatcherDeps;
  constructor(deps: DispatcherDeps) { this.deps = deps; }

  async handle(session: DispatchSession, frame: ControlFrame): Promise<ServerReplyFrame> {
    const { method, path, body, correlationId } = frame;

    // Virtual route: issue a single-use step-up challenge (§7.3 step 1).
    if (method === "POST" && path === STEPUP_CHALLENGE_PATH) {
      const ch = session.challenges.issue(this.deps.now());
      return { t: "challenge", challengeNonce: ch.challengeNonce, expiresAt: ch.expiresAt, correlationId };
    }

    const { tier, uiToken } = classifyTier(method, path);
    if (tier === "REFUSED") return this.deny(session, frame, "ROUTE_REFUSED", "route not exposed remotely");

    // ✦ routes need the "mutate working tree" capability (§4.5).
    if (uiToken && !session.hasCap("mutate")) {
      return this.deny(session, frame, "CAP_DENIED", "device lacks the mutate capability");
    }

    // body is an opaque JSON string on the wire (§3.4). Hash the verbatim string
    // for step-up; parse it ONLY for dispatch — never re-serialize between.
    const bodyStr = frame.body ?? "{}";

    if (tier === "HIGH") {
      // A resumed (read+lowrisk) session can never reach HIGH — gate on the cap
      // BEFORE step-up so a held Enclave key can't lift a resumed session (§2.3).
      if (!session.hasCap("highrisk")) return this.deny(session, frame, "CAP_DENIED", "session capability tier does not permit high-risk");
      if (!frame.stepUp) return this.deny(session, frame, "STEPUP_REQUIRED", "high-risk control requires step-up");
      const rec = this.deps.keyring.find(session.devId);
      if (!rec) return this.deny(session, frame, "AUTH_FAILED", "unknown device");
      const verdict = verifyStepUp({
        stepUp: frame.stepUp, sessionTH: session.sessionTH, method, path, body: bodyStr,
        iDevPubSec1: rec.iDevPubSec1, challenges: session.challenges, now: this.deps.now(),
      });
      if (!verdict.ok) return this.deny(session, frame, verdict.code, "step-up verification failed");
    }

    let parsedBody: unknown;
    try { parsedBody = JSON.parse(bodyStr); } catch { return this.deny(session, frame, "INTERNAL", "control body is not valid JSON"); }
    const suppliedToken = uiToken && session.hasCap("mutate") ? this.deps.uiToken : undefined;
    const result = await this.deps.routeDispatch({ method, path, body: parsedBody, uiToken: suppliedToken });
    this.audit(session, frame, result.status >= 400 ? (result.status === 403 ? "denied" : "error") : "ok");
    return { t: "reply", correlationId, status: result.status, body: result.body };
  }

  private deny(session: DispatchSession, frame: ControlFrame, code: RemoteErrorCode, message: string): ServerReplyFrame {
    this.audit(session, frame, "denied");
    return { t: "error", code, message, correlationId: frame.correlationId };
  }

  private audit(session: DispatchSession, frame: ControlFrame, result: "ok" | "denied" | "error"): void {
    this.deps.audit.append({
      device: session.devId,
      action: `${frame.method} ${frame.path}`,
      target: frame.path,
      ts: this.deps.now(),
      result,
    });
  }
}
