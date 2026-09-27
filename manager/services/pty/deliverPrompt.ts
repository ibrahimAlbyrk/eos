import { promptSteps } from "./claudeKeys.ts";

interface ConversationSnapshot {
  rows: { id: number; type: string }[];
  running: boolean;
}

export interface DeliverDeps {
  send(steps: string[]): Promise<boolean>;
  conversation(): ConversationSnapshot | null;
  sleep?: (ms: number) => Promise<void>;
}

// How long an idle Claude gets to record a submitted prompt before Enter is retried.
const ACK_MS = 3000;
const POLL_MS = 250;

const lastPromptId = (c: ConversationSnapshot | null): number =>
  [...(c?.rows ?? [])].reverse().find((r) => r.type === "user_message")?.id ?? 0;

// Submits a prompt to a pane's Claude TUI. Right after launch the TUI can drop
// the Enter that follows the paste, leaving the prompt sitting in the composer —
// so when Claude was idle, the prompt must reach the transcript, else Enter goes
// once more. (Mid-turn, Claude queues a prompt and records it only after the
// turn, so there is nothing to check then.)
export async function deliverPrompt(deps: DeliverDeps, text: string): Promise<boolean> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const before = deps.conversation();
  if (!(await deps.send(promptSteps(text)))) return false;
  if (!before || before.running) return true;
  const last = lastPromptId(before);
  for (let waited = 0; waited < ACK_MS; waited += POLL_MS) {
    await sleep(POLL_MS);
    if (lastPromptId(deps.conversation()) !== last) return true;
  }
  return deps.send(["\r"]);
}
