// Standalone policy — applies hardcoded Bash safety rules locally. Used
// when the gateway runs outside the daemon (interactive claude sessions
// without daemon-aware env). Defense-in-depth only; the daemon's policy
// engine is the canonical source.

import type { PolicyResolver, Decision } from "./PolicyResolver.ts";

function decideBash(cmd: string, input: Record<string, unknown>): Decision {
  if (/(^|[\s;&|])rm\s+-[rRf]+/.test(cmd))
    return { behavior: "deny", message: "rm -rf is hard-blocked by gateway policy" };
  if (/(^|[\s;&|])git\s+push\b/.test(cmd))
    return { behavior: "deny", message: "agents may not push; orchestrator handles merges" };
  if (/^\s*sudo\b/.test(cmd))
    return { behavior: "deny", message: "sudo is blocked" };
  if (/(^|[\s;&|])curl\b/.test(cmd) && !/--max-time/.test(cmd)) {
    return {
      behavior: "allow",
      updatedInput: { ...input, command: cmd.replace(/(^|[\s;&|])curl\b/, "$1curl --max-time 10") },
    };
  }
  return { behavior: "allow", updatedInput: input };
}

export const standalonePolicy: PolicyResolver = {
  name: "standalone",
  async decide({ tool_name, input }): Promise<Decision> {
    if (tool_name === "Bash") {
      const cmd = String(input.command ?? "");
      return decideBash(cmd, input);
    }
    return { behavior: "allow", updatedInput: input };
  },
};
