// Keeps the computer out of system sleep while the remote edge or peer hosting
// is armed, so a phone or another computer can still reach the daemon with the
// screen locked or off. How (and whether) is the host platform's call.

import { hostPlatform } from "../../infra/src/platform/index.ts";

/** Holds sleep off until the returned release function is called. */
export function startKeepAwake(deps: { log?: (msg: string, extra?: Record<string, unknown>) => void } = {}): () => void {
  return hostPlatform.keepAwake({ pid: process.pid, log: deps.log }) ?? (() => {});
}
