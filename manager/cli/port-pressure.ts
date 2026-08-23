// Ephemeral-port pressure — the local resource whose exhaustion looks like
// "everything is broken": with every port in the range stuck in TIME_WAIT, each
// connect() fails instantly with EADDRNOTAVAIL, so the daemon looks dead, health
// probes fail, and a restart appears to fail even when the daemon came up fine.
// Parsing lives here (pure, testable); `eos doctor` runs the commands.

export interface PortPressure {
  /** Ports in the ephemeral range. */
  capacity: number;
  /** Ephemeral ports currently held by a TIME_WAIT socket. */
  timeWait: number;
  /** Percentage of the range held. */
  pct: number;
  /** Where those sockets point, busiest first — this names the culprit. */
  topDestinations: Array<{ dest: string; count: number }>;
}

/** Splits a `netstat -an` address (`127.0.0.1.7400`, `::1.7400`) into host + port. */
function splitAddr(addr: string): { host: string; port: number } | null {
  const dot = addr.lastIndexOf(".");
  if (dot < 0) return null;
  const port = Number(addr.slice(dot + 1));
  if (!Number.isFinite(port)) return null;
  return { host: addr.slice(0, dot), port };
}

export function parsePortPressure(netstatOutput: string, first: number, last: number): PortPressure {
  const byDest = new Map<string, number>();
  let timeWait = 0;

  for (const line of netstatOutput.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6 || cols[5] !== "TIME_WAIT") continue;
    const local = splitAddr(cols[3]);
    if (!local || local.port < first || local.port > last) continue;
    timeWait++;
    const remote = splitAddr(cols[4]);
    const dest = remote ? `${remote.host}:${remote.port}` : cols[4];
    byDest.set(dest, (byDest.get(dest) ?? 0) + 1);
  }

  const capacity = Math.max(0, last - first + 1);
  return {
    capacity,
    timeWait,
    pct: capacity ? Math.round((timeWait / capacity) * 100) : 0,
    topDestinations: [...byDest.entries()]
      .map(([dest, count]) => ({ dest, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3),
  };
}
