import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";

import { SettingsPatchRequestSchema } from "../../contracts/src/http.ts";

export function registerSettingsRoutes(r: Router, c: Container): void {
  r.get("/api/settings", ({ res }) => {
    writeJson(res, 200, { settings: c.userSettings.read() });
  });

  r.put("/api/settings", async ({ req, res }) => {
    const body = validate(SettingsPatchRequestSchema, await readBody(req));
    writeJson(res, 200, { settings: c.userSettings.patch(body.settings) });
  });
}
