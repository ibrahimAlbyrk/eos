// Daemon-proxy policy — forwards every decision request to the daemon's
// /policy/decide endpoint. Daemon owns the rule set (rules.yaml + the
// pending-permissions long-poll for human-in-the-loop). On any transport
// failure the gateway denies — fail-closed, since silent allow on a
// dropped daemon would be a security regression.

import type { PolicyResolver, Decision } from "./PolicyResolver.ts";

export interface DaemonProxyOptions {
  daemonUrl: string;
  workerId: string;
}

export function createDaemonProxyPolicy(opts: DaemonProxyOptions): PolicyResolver {
  return {
    name: "daemon",
    async decide({ tool_name, input, tool_use_id }): Promise<Decision> {
      try {
        const r = await fetch(`${opts.daemonUrl}/policy/decide`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ worker_id: opts.workerId, tool_name, input, tool_use_id }),
        });
        return (await r.json()) as Decision;
      } catch (e) {
        return { behavior: "deny", message: `daemon unreachable: ${(e as Error).message}` };
      }
    },
  };
}
