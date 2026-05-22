// Claude Code PermissionRequest hook contract.
// What the hook script reads on stdin and what it must write to stdout for
// Claude to accept the decision. Note `updatedInput` is a sibling of
// `decision`, NOT inside it — opposite of the MCP --permission-prompt-tool
// contract. The CLAUDE.md notes this empirically-discovered shape.

import { z } from "zod";

export const PermissionRequestHookInputSchema = z.object({
  hook_event_name: z.literal("PermissionRequest").optional(),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()).default({}),
  tool_use_id: z.string().nullable().optional(),
  session_id: z.string().optional(),
}).passthrough();
export type PermissionRequestHookInput = z.infer<typeof PermissionRequestHookInputSchema>;

const HookDecisionSchema = z.union([
  z.object({ behavior: z.literal("allow"), message: z.string().optional() }),
  z.object({ behavior: z.literal("deny"), message: z.string().optional() }),
]);

export const PermissionRequestHookOutputSchema = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal("PermissionRequest"),
    decision: HookDecisionSchema,
    updatedInput: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type PermissionRequestHookOutput = z.infer<typeof PermissionRequestHookOutputSchema>;

// The HTTP-type hook payload posted to worker.ts's /event?event=<name>
// endpoint. Used by SessionStart/Stop/Notification/PostToolUse/SessionEnd.
// The body is whatever Claude posts — we don't constrain its shape, just
// preserve session_id extraction.
export const HttpHookEventQuerySchema = z.object({
  event: z.string(),
});

export const HttpHookEventBodySchema = z
  .object({
    session_id: z.string().optional(),
    tool_name: z.string().optional(),
  })
  .passthrough();
export type HttpHookEventBody = z.infer<typeof HttpHookEventBodySchema>;
