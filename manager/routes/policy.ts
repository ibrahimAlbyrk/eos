import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import { PolicyDecideRequestSchema } from "../../contracts/src/http.ts";
import { PolicyBehaviorSchema, type PolicyRule } from "../../contracts/src/policy.ts";

export function registerPolicyRoutes(r: Router, c: Container): void {
  r.post("/policy/decide", async ({ req, res }) => {
    const body = validate(PolicyDecideRequestSchema, await readBody(req));
    const decision = await c.policyGateway.decide({
      workerId: body.worker_id,
      toolName: body.tool_name,
      input: body.input,
      toolUseId: body.tool_use_id ?? null,
      agentId: body.agent_id ?? null,
    });
    writeJson(res, 200, decision);
  });

  r.post("/api/policy/rule", async ({ req, res }) => {
    const body = await readBody(req) as { tool?: unknown; behavior?: unknown };
    if (typeof body.tool !== "string" || body.tool.length === 0) {
      writeJson(res, 400, { error: "tool must be a non-empty string" });
      return;
    }
    const behaviorParsed = PolicyBehaviorSchema.safeParse(body.behavior);
    if (!behaviorParsed.success) {
      writeJson(res, 400, { error: "behavior must be one of allow, deny, ask, rewrite" });
      return;
    }
    const tool = body.tool;
    const behavior = behaviorParsed.data;
    const policyPath = join(c.config.daemon.home, "policy.yaml");
    try {
      const existingRaw = existsSync(policyPath) ? readFileSync(policyPath, "utf8") : "";
      const doc = (existingRaw ? parseYaml(existingRaw) : null) ?? {};
      const root = typeof doc === "object" && doc !== null ? doc as Record<string, unknown> : {};
      const rules: PolicyRule[] = Array.isArray(root.rules) ? root.rules as PolicyRule[] : [];
      if (rules.some((rule) => rule?.match?.tool === tool)) {
        writeJson(res, 200, { ok: true, existed: true });
        return;
      }
      const next = {
        default: root.default ?? "ask",
        ...(root.ttlMs !== undefined ? { ttlMs: root.ttlMs } : {}),
        rules: [...rules, { match: { tool }, behavior }],
      };
      writeFileSync(policyPath, stringifyYaml(next));
      c.reloadPolicy();
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}
