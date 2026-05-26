import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import { PolicyDecideRequestSchema } from "../../contracts/src/http.ts";

export function registerPolicyRoutes(r: Router, c: Container): void {
  r.post("/policy/decide", async ({ req, res }) => {
    const body = validate(PolicyDecideRequestSchema, await readBody(req));
    const decision = await c.policyGateway.decide({
      workerId: body.worker_id,
      toolName: body.tool_name,
      input: body.input,
      toolUseId: body.tool_use_id ?? null,
    });
    writeJson(res, 200, decision);
  });

  r.post("/api/policy/rule", async ({ req, res }) => {
    const body = await readBody(req) as { tool?: string; behavior?: string };
    if (!body.tool || !body.behavior) { writeJson(res, 400, { error: "tool and behavior required" }); return; }
    const policyPath = join(c.config.daemon.home, "policy.yaml");
    try {
      let yaml = existsSync(policyPath) ? readFileSync(policyPath, "utf8") : "default: ask\nrules:\n";
      const ruleLine = `  - match:\n      tool: ${body.tool}\n    behavior: ${body.behavior}\n`;
      if (yaml.includes(`tool: ${body.tool}`)) {
        writeJson(res, 200, { ok: true, existed: true });
        return;
      }
      yaml = yaml.trimEnd() + "\n" + ruleLine;
      writeFileSync(policyPath, yaml);
      c.reloadPolicy();
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}
