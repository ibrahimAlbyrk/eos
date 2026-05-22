import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";

export function registerMetricsRoutes(r: Router, c: Container): void {
  r.get("/metrics", ({ res }) => {
    const stateRows = c.workers.countByState();
    const pendingCount = c.pending.listUnresolved().length;
    const uptimeSec = Math.floor((c.clock.now() - c.metrics.startedAtMs) / 1000);
    const lines: string[] = [
      "# HELP claude_mgr_uptime_seconds Daemon uptime",
      "# TYPE claude_mgr_uptime_seconds gauge",
      `claude_mgr_uptime_seconds ${uptimeSec}`,
      "# HELP claude_mgr_workers Worker count by state",
      "# TYPE claude_mgr_workers gauge",
    ];
    for (const row of stateRows) lines.push(`claude_mgr_workers{state="${row.state}"} ${row.n}`);
    lines.push(
      "# HELP claude_mgr_sse_clients Active SSE subscribers",
      "# TYPE claude_mgr_sse_clients gauge",
      `claude_mgr_sse_clients ${c.sse.size()}`,
      "# HELP claude_mgr_pending Pending permission requests",
      "# TYPE claude_mgr_pending gauge",
      `claude_mgr_pending ${pendingCount}`,
      "# HELP claude_mgr_policy_decisions_total Cumulative policy decisions",
      "# TYPE claude_mgr_policy_decisions_total counter",
      `claude_mgr_policy_decisions_total{behavior="allow"} ${c.metrics.policyAllow}`,
      `claude_mgr_policy_decisions_total{behavior="deny"} ${c.metrics.policyDeny}`,
      `claude_mgr_policy_decisions_total{behavior="ask"} ${c.metrics.policyAsk}`,
      "# HELP claude_mgr_requests_total HTTP requests served",
      "# TYPE claude_mgr_requests_total counter",
      `claude_mgr_requests_total ${c.metrics.requests}`,
      "# HELP claude_mgr_body_too_large_total Requests rejected for body-size limit",
      "# TYPE claude_mgr_body_too_large_total counter",
      `claude_mgr_body_too_large_total ${c.metrics.bodyTooLarge}`,
    );
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(lines.join("\n") + "\n");
  });
}
