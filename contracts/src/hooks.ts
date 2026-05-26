// Claude Code PermissionRequest hook contract.
// What the hook script reads on stdin and what it must write to stdout for
// Claude to accept the decision. Note `updatedInput` is a sibling of
// `decision`, NOT inside it — opposite of the MCP --permission-prompt-tool
// contract. The CLAUDE.md notes this empirically-discovered shape.

import { z } from "zod";
import { UnknownRecordSchema } from "./shared.ts";
import { AllowVariant } from "./policy.ts";

// .passthrough(): Claude may add undocumented fields to hook input
export const PermissionRequestHookInputSchema = z.object({
  hook_event_name: z.literal("PermissionRequest").optional(),
  tool_name: z.string(),
  tool_input: UnknownRecordSchema.default({}),
  tool_use_id: z.string().nullable().optional(),
  session_id: z.string().optional(),
}).passthrough();
export type PermissionRequestHookInput = z.infer<typeof PermissionRequestHookInputSchema>;

// Hook decision: updatedInput lives as sibling in hookSpecificOutput, not
// inside decision. deny.message is optional (unlike policy DenyVariant).
export const HookDecisionSchema = z.union([
  AllowVariant.omit({ updatedInput: true }),
  z.object({ behavior: z.literal("deny"), message: z.string().optional() }),
]);

export const PermissionRequestHookOutputSchema = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal("PermissionRequest"),
    decision: HookDecisionSchema,
    updatedInput: UnknownRecordSchema.optional(),
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
