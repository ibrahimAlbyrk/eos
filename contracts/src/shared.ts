import { z } from "zod";

export const UnknownRecordSchema = z.record(z.string(), z.unknown());

// Shape of one entry inside an mcp.json `mcpServers` map. Passthrough so
// transport-specific fields (timeout, alwaysLoad, oauth, headers, …) survive
// untouched — we only ever copy these definitions around, never interpret them.
export const McpServerDefSchema = z
  .object({
    type: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
export type McpServerDef = z.infer<typeof McpServerDefSchema>;
