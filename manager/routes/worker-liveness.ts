// Is this worker's session live, across backends? Out-of-process (claude-cli)
// workers are supervised PTY children (the supervisor map); in-process
// (claude-sdk/…) workers have no child — their liveness is the backend
// session's own aliveness. Single source for the message / report / peer /
// resume paths so none re-derives it and forgets the in-process branch (the
// old `!port || !supervisor.has` checks dropped every in-process target).

import type { Container } from "../container.ts";

export function isWorkerLive(c: Container, id: string): boolean {
  if (c.supervisor.has(id)) return true;
  const kind = c.workers.findById(id)?.backend_kind;
  if (kind && c.backends.has(kind) && c.backends.get(kind).descriptor.processModel === "in-process") {
    return c.backends.get(kind).attach(id, { kind: "inproc", ref: id }).isAlive();
  }
  return false;
}
