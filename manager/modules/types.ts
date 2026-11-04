// A daemon feature module: one feature's services, the reactions that keep them
// in step with the rest of the daemon, and its HTTP routes, built in one place
// from the kernel services it needs (passed in, never reached for). The
// container builds every module; the daemon registers their routes, starts
// them and stops them on shutdown. Modules never import each other — what one needs from
// another comes in through its deps.

import type { Router } from "../routes/Router.ts";
import type { AgentEvent } from "../../contracts/src/canonical.ts";

export interface DaemonModule {
  readonly id: string;
  // The built-in plugin (contracts/src/builtin-plugins.ts) that switches this
  // feature on and off. While off, its routes answer "turned off" and it hears
  // no agent events.
  readonly plugin?: string;
  registerRoutes?(router: Router): void;
  // Prompt variables this feature fills, read at each spawn (e.g. GENUI_LEVEL).
  promptVariables?(): Record<string, string | boolean>;
  // settings.json keys only this feature's own (ui-token) route may write; the
  // flat PUT /api/settings refuses them.
  readonly protectedSettings?: { readonly keys: readonly string[]; readonly via: string };
  // Every event an agent's session emits, before it is processed and logged.
  onAgentEvent?(workerId: string, event: AgentEvent): void;
  // The daemon is up (its routes are registered): start timers and watchers.
  start?(): void;
  // A session (a root worker and its subtree) was killed, archived or purged.
  onSessionEnded?(sessionKey: string): void;
  // The daemon is shutting down.
  stop?(): void;
}
