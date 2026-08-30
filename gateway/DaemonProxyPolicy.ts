// Daemon-proxy policy — forwards every decision request to the daemon's
// /policy/decide endpoint. Daemon owns the rule set (rules.yaml + the
// pending-permissions long-poll for human-in-the-loop). On any transport
// failure the gateway denies — fail-closed, since silent allow on a
// dropped daemon would be a security regression.

import { request as httpRequest } from "node:http";
import type { PolicyResolver, Decision } from "./PolicyResolver.ts";
import { ExternalDecisionSchema } from "../contracts/src/policy.ts";

export interface DaemonProxyOptions {
  daemonUrl: string;
  workerId: string;
}

// POST JSON to the daemon over its unix socket when EOS_DAEMON_SOCK is set, else
// over loopback TCP. Uses node:http (works on both Bun — the dev gateway — and
// Electron's Node — the packaged gateway); the previous `fetch(url,{unix})` was
// a Bun-only option. Prefer the socket: a decision is requested per tool call,
// and over TCP each spends an ephemeral port — once the local range saturates
// every call fails and this resolver fail-closes (denies). Rejects on timeout.
function postDecision(daemonUrl: string, body: string, timeoutMs: number): Promise<unknown> {
  const socketPath = process.env.EOS_DAEMON_SOCK;
  const u = new URL(`${daemonUrl}/policy/decide`);
  const common = {
    method: "POST",
    path: `${u.pathname}${u.search}`,
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
  };
  const options = socketPath
    ? { socketPath, ...common }
    : { hostname: u.hostname, port: u.port, ...common };
  return new Promise((resolve, reject) => {
    const req = httpRequest(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    // Explicit timer + destroy: portable across runtimes (no reliance on the
    // `signal` request option, which Bun/Node support unevenly).
    const timer = setTimeout(() => req.destroy(new Error("policy timeout")), timeoutMs);
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.on("close", () => clearTimeout(timer));
    req.write(body);
    req.end();
  });
}

export function createDaemonProxyPolicy(opts: DaemonProxyOptions): PolicyResolver {
  return {
    name: "daemon",
    async decide({ tool_name, input, tool_use_id }): Promise<Decision> {
      const timeoutMs = parseInt(process.env.EOS_POLICY_TIMEOUT_MS ?? "", 10) || 3_600_000;
      const body = JSON.stringify({ worker_id: opts.workerId, tool_name, input, tool_use_id });
      try {
        const parsed = ExternalDecisionSchema.safeParse(await postDecision(opts.daemonUrl, body, timeoutMs));
        if (!parsed.success)
          return { behavior: "deny", message: `invalid decision: ${parsed.error.message}` };
        const d = parsed.data;
        if (d.behavior === "allow")
          return { behavior: "allow", updatedInput: d.updatedInput ?? input };
        return d;
      } catch (e) {
        return { behavior: "deny", message: "permission service unavailable" };
      }
    },
  };
}
