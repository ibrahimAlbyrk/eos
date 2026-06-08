// Daemon-proxy policy — forwards every decision request to the daemon's
// /policy/decide endpoint. Daemon owns the rule set (rules.yaml + the
// pending-permissions long-poll for human-in-the-loop). On any transport
// failure the gateway denies — fail-closed, since silent allow on a
// dropped daemon would be a security regression.

import type { PolicyResolver, Decision } from "./PolicyResolver.ts";
import { ExternalDecisionSchema } from "../contracts/src/policy.ts";

export interface DaemonProxyOptions {
  daemonUrl: string;
  workerId: string;
}

export function createDaemonProxyPolicy(opts: DaemonProxyOptions): PolicyResolver {
  return {
    name: "daemon",
    async decide({ tool_name, input, tool_use_id }): Promise<Decision> {
      const ac = new AbortController();
      const timeoutMs = parseInt(process.env.EOS_POLICY_TIMEOUT_MS ?? "", 10) || 3_600_000;
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const r = await fetch(`${opts.daemonUrl}/policy/decide`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ worker_id: opts.workerId, tool_name, input, tool_use_id }),
          signal: ac.signal,
        });
        const parsed = ExternalDecisionSchema.safeParse(await r.json());
        if (!parsed.success)
          return { behavior: "deny", message: `invalid decision: ${parsed.error.message}` };
        const d = parsed.data;
        if (d.behavior === "allow")
          return { behavior: "allow", updatedInput: d.updatedInput ?? input };
        return d;
      } catch (e) {
        return { behavior: "deny", message: "permission service unavailable" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
