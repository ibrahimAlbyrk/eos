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
