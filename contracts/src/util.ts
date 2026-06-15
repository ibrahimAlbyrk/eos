export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const WORKER_EXIT = {
  SUCCESS: 0,
  GRACEFUL_SHUTDOWN: 129,
  KILLED: 143,
  INTERRUPTED: 130,
} as const;

export function isWorkerSuccessExit(code: number): boolean {
  return code === WORKER_EXIT.SUCCESS || code === WORKER_EXIT.GRACEFUL_SHUTDOWN;
}

// Cross-process boot handshake: an Eos tool MCP server (orchestrator/worker)
// writes this file (under os.tmpdir()) the moment it connects, and the spawner
// polls for it before releasing the boot prompt — closing the window where
// claude auto-submits the first turn before the MCP tools are registered.
// Both sides derive the name from the worker id alone, so no port/daemon hop.
export function mcpReadyFlagName(workerId: string): string {
  return `eos-mcp-ready-${workerId}`;
}
