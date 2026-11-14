// Attachments persisted as a suffix inside each user-message text. The parser and
// writer live with the dashboard (app/ui/src/shared/attachments.ts), one text for
// the daemon (GET /workers/:id/attachments) and the composer/message bubble; the
// wire schema of the "Files in Chat" list stays here.

import { z } from "zod";

export * from "../../app/ui/src/shared/attachments.ts";

// One attachment in the whole-conversation "Files in Chat" list: a parsed
// attachment plus the user_message row it first appeared in (id + ts).
export const ChatAttachmentSchema = z.object({
  label: z.string().optional(),
  kind: z.enum(["image", "file", "folder"]),
  path: z.string(),
  messageId: z.number(),
  ts: z.number(),
});
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;
