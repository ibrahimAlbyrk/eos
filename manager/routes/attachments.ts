import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { parseAttachmentMessage, type ChatAttachment } from "../../contracts/src/attachments.ts";
import { WorkerAttachmentsResponseSchema } from "../../contracts/src/http.ts";

// The attachment suffix lives inside the user_message payload's `text`; a
// malformed/legacy row degrades to "" (no attachments) rather than throwing.
function textOf(payload: string | null): string {
  if (!payload) return "";
  try {
    const obj = JSON.parse(payload) as { text?: unknown };
    return typeof obj.text === "string" ? obj.text : "";
  } catch {
    return "";
  }
}

export function registerAttachmentRoutes(r: Router, c: Container): void {
  // Full-history "Files in Chat": every attachment referenced across the whole
  // conversation, derived from the user_message events via the shared parser and
  // unioned by path. listByType returns rows id-ASC, so the first sighting of a
  // path wins — earliest messageId/ts kept.
  r.get(/^\/workers\/(?<id>[^/]+)\/attachments$/, ({ params, res }) => {
    const byPath = new Map<string, ChatAttachment>();
    for (const row of c.events.listByType(params.id, "user_message")) {
      for (const a of parseAttachmentMessage(textOf(row.payload)).attachments) {
        if (byPath.has(a.path)) continue;
        byPath.set(a.path, { ...a, messageId: row.id, ts: row.ts });
      }
    }
    const body = WorkerAttachmentsResponseSchema.parse({ attachments: [...byPath.values()] });
    writeJson(res, 200, body);
  });
}
