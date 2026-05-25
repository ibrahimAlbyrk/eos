import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { NotificationConfigSchema } from "../../contracts/src/notifications.ts";

export function registerNotificationRoutes(r: Router, c: Container): void {
  r.get("/api/notifications/config", ({ res }) => {
    writeJson(res, 200, c.config.notifications);
  });

  r.put("/api/notifications/config", async ({ req, res }) => {
    const raw = await readBody(req);
    const parsed = NotificationConfigSchema.partial().safeParse(raw);
    if (!parsed.success) {
      writeJson(res, 400, { error: parsed.error.message });
      return;
    }

    const configPath = join(c.config.daemon.home, "config.json");
    let file: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try { file = JSON.parse(readFileSync(configPath, "utf8")); } catch {}
    }

    const current = c.config.notifications;
    const updated = {
      ...current,
      ...parsed.data,
      rules: { ...current.rules, ...(parsed.data.rules ?? {}) },
    };

    file.notifications = updated;
    writeFileSync(configPath, JSON.stringify(file, null, 2));
    Object.assign(c.config.notifications, updated);

    writeJson(res, 200, updated);
  });
}
