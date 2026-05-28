// PermissionModeResolver — abstracts "what permission mode is in force for
// this worker right now?". The PolicyGatewayService consults this on every
// decide(); a worker's mode may have been changed mid-session.
//
// Default implementation walks up parent_id when the worker itself has no
// mode set (children inherit from the orchestrator at root).

import type { PermissionMode } from "../../../contracts/src/worker.ts";

export interface PermissionModeResolver {
  resolveFor(workerId: string): PermissionMode;
}
