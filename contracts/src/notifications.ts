import { z } from "zod";

export const NotificationPayloadSchema = z.object({
  id: z.string(),
  trigger: z.string(),
  title: z.string(),
  body: z.string(),
  workerId: z.string().nullable(),
  ts: z.number(),
});
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

export const NotificationRuleSchema = z.object({
  enabled: z.boolean().default(true),
  cooldownMs: z.number().int().nonnegative().default(5000),
});
export type NotificationRule = z.infer<typeof NotificationRuleSchema>;

export const NotificationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  rules: z.object({
    agent_finished: NotificationRuleSchema.default({}),
    agent_exited: NotificationRuleSchema.default({}),
    permission_pending: NotificationRuleSchema.default({}),
    permission_expired: NotificationRuleSchema.default({}),
  }).default({}),
});
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;

export type NotificationTriggerName = keyof NotificationConfig["rules"];
