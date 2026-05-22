// IPC contracts — the loopback HTTP surfaces between processes.
// Worker.ts exposes /message and /event?event=<name> on 127.0.0.1:<port>.
// orchestrator-mcp.ts calls daemon HTTP via shared/http.ts.

import { z } from "zod";

export const WorkerMessageBodySchema = z.object({
  text: z.string().min(1),
});
export type WorkerMessageBody = z.infer<typeof WorkerMessageBodySchema>;

export const WorkerMessageReplySchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
}).passthrough();

export const WorkerHookReplySchema = z.object({
  continue: z.boolean(),
}).passthrough();

// Bag of env vars the daemon sets on every worker child process.
// Three of them are critical for the hook to delegate properly.
export const DaemonAwareEnvSchema = z.object({
  CLAUDE_MGR_SPAWNED: z.literal("1"),
  CLAUDE_MGR_WORKER_ID: z.string(),
  CLAUDE_MGR_DAEMON_URL: z.string().url(),
});
export type DaemonAwareEnv = z.infer<typeof DaemonAwareEnvSchema>;
