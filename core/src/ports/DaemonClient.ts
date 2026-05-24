// DaemonClient — worker / gateway / orchestrator-mcp → daemon outbound port.
// Adapter is HttpDaemonClient in infra/ipc/.
// Composed from focused sub-interfaces (ISP).

import type { WorkerEventClient } from "./WorkerEventClient.ts";
import type { PolicyClient } from "./PolicyClient.ts";
import type { WorkerManagementClient } from "./WorkerManagementClient.ts";

export type { WorkerEventClient } from "./WorkerEventClient.ts";
export type { PolicyClient } from "./PolicyClient.ts";
export type { WorkerManagementClient } from "./WorkerManagementClient.ts";

export type DaemonClient = WorkerEventClient & PolicyClient & WorkerManagementClient;
