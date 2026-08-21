// Canonical attachment parser — the single source of truth shared by the daemon
// (GET /workers/:id/attachments) and the web composer/message bubble. Attachments
// are persisted as a suffix inside each user-message text:
//
//   \n\nattachments:\n- [label] (image|file|folder): /abs/path
//
// The web mirror in app/ui/src/lib/attachmentTokens.js re-exports these three
// pure functions so reader (parse) and writer (build) never drift.

import { z } from "zod";

export type AttachmentKind = "image" | "file" | "folder";

// A parsed attachment line, before repo enrichment (messageId/ts). label is
// absent for the legacy bare "image:"/"file:"/"folder:" forms.
export interface ParsedAttachment {
  label?: string;
  kind: AttachmentKind;
  path: string;
}

export interface ParsedAttachmentMessage {
  display: string;
  attachments: ParsedAttachment[];
}

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

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

export function kindFromExt(path: string): AttachmentKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext) ? "image" : "file";
}

// The "(kind)" annotation lets the message bubble pick the right chip icon
// when re-parsing the sent text (a path alone can't distinguish folders).
export function buildAttachmentSuffix(
  labels: string[],
  paths: Map<string, string>,
  kinds?: Map<string, string>,
): string {
  const lines: string[] = [];
  for (const label of labels) {
    const path = paths.get(label);
    if (!path) continue;
    const kind = kinds?.get(label);
    lines.push(kind ? `- ${label} (${kind}): ${path}` : `- ${label}: ${path}`);
  }
  return lines.length ? `\n\nattachments:\n${lines.join("\n")}` : "";
}

// Inverse of buildAttachmentSuffix — kept beside it so reader and writer never
// drift. Splits the "attachments:" suffix off a sent message into the display
// text + a typed list: { display, attachments: [{ label?, kind, path }] }.
// Tolerates the legacy "{image #1}" / bare "image:" forms and infers kind from
// the extension when the "(kind)" annotation is absent. Pure → testable, and
// shared by the message bubble (render) and the composer (paste reconstruction).
export function parseAttachmentMessage(text: string): ParsedAttachmentMessage {
  const marker = "\n\nattachments:\n";
  const idx = (text ?? "").indexOf(marker);
  if (idx === -1) return { display: text ?? "", attachments: [] };
  const display = text.slice(0, idx);
  const attachments = text.slice(idx + marker.length)
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean)
    .map((raw): ParsedAttachment => {
      const bracket = raw.match(/^(\[[^\]]+\])(?:\s+\((image|file|folder)\))?:\s*(.+)$/);
      if (bracket) return { label: bracket[1], kind: (bracket[2] ?? kindFromExt(bracket[3])) as AttachmentKind, path: bracket[3] };
      const labeled = raw.match(/^(\{(image|file|folder) #\d+\}):\s*(.+)$/);
      if (labeled) return { label: labeled[1], kind: labeled[2] as AttachmentKind, path: labeled[3] };
      const bare = raw.match(/^(folder|file|image):\s*(.+)$/);
      if (bare) return { kind: bare[1] as AttachmentKind, path: bare[2] };
      return { kind: kindFromExt(raw), path: raw };
    });
  return { display, attachments };
}
