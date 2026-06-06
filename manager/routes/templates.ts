import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import {
  TemplateCreateRequestSchema,
  TemplateUpdateRequestSchema,
  TemplateNameSchema,
} from "../../contracts/src/http.ts";

export function registerTemplateRoutes(r: Router, c: Container): void {
  r.get("/api/templates", ({ res }) => {
    writeJson(res, 200, { templates: c.userTemplates.list() });
  });

  r.post("/api/templates", async ({ req, res }) => {
    const body = validate(TemplateCreateRequestSchema, await readBody(req));
    if (c.userTemplates.exists(body.name)) {
      writeJson(res, 409, { error: `template "${body.name}" already exists` });
      return;
    }
    c.userTemplates.write(body);
    writeJson(res, 200, { ok: true });
  });

  r.put(/^\/api\/templates\/(?<name>[^/]+)$/, async ({ params, req, res }) => {
    const name = validate(TemplateNameSchema, params.name);
    const body = validate(TemplateUpdateRequestSchema, await readBody(req));
    if (!c.userTemplates.exists(name)) {
      writeJson(res, 404, { error: `template "${name}" not found` });
      return;
    }
    c.userTemplates.write({ name, ...body });
    writeJson(res, 200, { ok: true });
  });

  r.del(/^\/api\/templates\/(?<name>[^/]+)$/, ({ params, res }) => {
    const name = validate(TemplateNameSchema, params.name);
    const deleted = c.userTemplates.delete(name);
    if (!deleted) {
      writeJson(res, 404, { error: `template "${name}" not found` });
      return;
    }
    writeJson(res, 200, { ok: true });
  });
}
