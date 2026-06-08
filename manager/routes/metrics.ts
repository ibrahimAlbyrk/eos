import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";

export function registerMetricsRoutes(r: Router, c: Container): void {
  r.get("/metrics", ({ res }) => {
    const stateRows = c.workers.countByState();
    const pendingCount = c.pending.listUnresolved().length;
    const uptimeSec = Math.floor((c.clock.now() - c.metrics.startedAtMs) / 1000);
    const lines: string[] = [
      "# HELP eos_uptime_seconds Daemon uptime",
      "# TYPE eos_uptime_seconds gauge",
      `eos_uptime_seconds ${uptimeSec}`,
      "# HELP eos_workers Worker count by state",
      "# TYPE eos_workers gauge",
    ];
    for (const row of stateRows) lines.push(`eos_workers{state="${row.state}"} ${row.n}`);
    lines.push(
      "# HELP eos_sse_clients Active SSE subscribers",
      "# TYPE eos_sse_clients gauge",
      `eos_sse_clients ${c.sse.size()}`,
      "# HELP eos_pending Pending permission requests",
      "# TYPE eos_pending gauge",
      `eos_pending ${pendingCount}`,
      "# HELP eos_policy_decisions_total Cumulative policy decisions",
      "# TYPE eos_policy_decisions_total counter",
      `eos_policy_decisions_total{behavior="allow"} ${c.metrics.policyAllow}`,
      `eos_policy_decisions_total{behavior="deny"} ${c.metrics.policyDeny}`,
      `eos_policy_decisions_total{behavior="ask"} ${c.metrics.policyAsk}`,
      "# HELP eos_requests_total HTTP requests served",
      "# TYPE eos_requests_total counter",
      `eos_requests_total ${c.metrics.requests}`,
      "# HELP eos_body_too_large_total Requests rejected for body-size limit",
      "# TYPE eos_body_too_large_total counter",
      `eos_body_too_large_total ${c.metrics.bodyTooLarge}`,
    );
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(lines.join("\n") + "\n");
  });
}
