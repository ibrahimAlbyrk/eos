// A daemon feature module: one feature's services, the reactions that keep them
// in step with the rest of the daemon, and its HTTP routes, built in one place
// from the kernel services it needs (passed in, never reached for). The
// container builds every module; the daemon registers their routes, starts
// them and stops them on shutdown. Modules never import each other — what one needs from
// another comes in through its deps.

import type { Router } from "../routes/Router.ts";
import type { AgentEvent } from "../../contracts/src/canonical.ts";
import type { EventBusMessage, EventBusTopic } from "../../core/src/ports/EventBus.ts";
import type { SyncDomain } from "../../core/src/ports/SyncDomain.ts";
import type { SlashCommand } from "../../core/src/domain/slash-command.ts";
import type { IdleHook } from "../services/IdleHooks.ts";
import type { RouteAccess } from "../routes/route-access.ts";

// Data a feature lets follow the user to their other Macs (Settings › Sync):
// its sync domain, and the bus topic its local edits announce (so sync pushes
// them); isLocal tells an edit apart from one sync itself applied.
export interface SyncContribution {
  readonly domain: SyncDomain;
  readonly changeTopic?: EventBusTopic;
  isLocal?(msg: EventBusMessage): boolean;
}

export interface DaemonModule {
  readonly id: string;
  // The built-in plugin (contracts/src/builtin-plugins.ts) that switches this
  // feature on and off. While off, its routes answer "turned off" and it hears
  // no agent events.
  readonly plugin?: string;
  registerRoutes?(router: Router): void;
  // Which of its routes never cross to another computer, and the phone's tier
  // for those the phone may call (unlisted ones are refused).
  readonly routeAccess?: RouteAccess;
  // Prompt variables this feature fills, read at each spawn (e.g. GENUI_LEVEL).
  promptVariables?(): Record<string, string | boolean>;
  // settings.json keys only this feature's own (ui-token) route may write; the
  // flat PUT /api/settings refuses them.
  readonly protectedSettings?: { readonly keys: readonly string[]; readonly via: string };
  // Every event an agent's session emits, before it is processed and logged.
  onAgentEvent?(workerId: string, event: AgentEvent): void;
  // The daemon is up (its routes are registered): start timers and watchers.
  start?(): void;
  // The daemon won its endpoint (the unix socket is listening): start what must
  // run in one daemon only.
  afterListen?(): void;
  readonly sync?: readonly SyncContribution[];
  // What runs when a worker settles at IDLE with an empty queue, in order among
  // the daemon's own (goal loop 20, report nudge 30, context watcher 40).
  readonly idleHooks?: readonly IdleHook[];
  // Eos-owned slash commands this feature adds to the composer.
  readonly slashCommands?: readonly SlashCommand[];
  // True while this feature holds the worker: every message to it queues.
  holdsWorker?(workerId: string): boolean;
  // A session (a root worker and its subtree) was killed, archived or purged.
  onSessionEnded?(sessionKey: string): void;
  // The daemon is shutting down.
  stop?(): void;
}
