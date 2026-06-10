import { z } from "zod";

export const UnknownRecordSchema = z.record(z.string(), z.unknown());

// Spawn-time effort levels — exactly what `claude --effort` accepts. Runtime
// `/effort` additionally knows TUI-only values (ultracode, auto), so the
// SetModel endpoint stays a free string; only spawn surfaces use this enum.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const EffortSchema = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof EffortSchema>;

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
