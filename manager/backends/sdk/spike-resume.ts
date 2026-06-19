// SPIKE (manual, not a test) — the Faz 2 go/no-go: does a conversation hand off
// between the claude-cli (interactive/PTY) lane and the claude-sdk lane via a
// shared transcript? Both lanes drive the SAME bundled `claude` binary writing
// ~/.claude/projects/<cwd>/<sessionId>.jsonl, so a same-cwd resume SHOULD reload
// the other lane's conversation — this proves it on YOUR subscription. No daemon.
//
// Two modes (subscription-billed, one tiny turn each):
//
//   CREATE — seed a fact via the SDK lane, print its sessionId + cwd:
//     cd manager && npx tsx backends/sdk/spike-resume.ts create [cwd]
//
//   RESUME — resume a sessionId via the SDK lane, ask for the fact back:
//     cd manager && npx tsx backends/sdk/spike-resume.ts resume <sessionId> [cwd]
//
// The cross-lane tests (the real unknown):
//   cli → sdk:  (1) `cd <cwd> && claude`, say "remember the magic word is
//               BANANA-42", exit. (2) find the id: ls -t ~/.claude/projects/<enc>/
//               (3) RESUME <that id> <cwd>  → GREEN if it answers BANANA-42.
//   sdk → cli:  (1) CREATE <cwd> → prints sessionId. (2) `cd <cwd> &&
//               claude --resume <sessionId>`, ask "what is the magic word?".
//   sdk → sdk:  CREATE then RESUME with this script alone (resume mechanism sanity).
//
// Prereq: logged into Claude (an existing Claude Code login, or `claude setup-token`).

import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClaudeSdkBackend } from "./ClaudeSdkBackend.ts";
import { createSubscriptionAuthResolver } from "../../../infra/src/auth/SubscriptionAuthResolver.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

const MAGIC = "BANANA-42";
const MODEL = "sonnet"; // cheap; any model can recall one fact — change if unavailable

const mode = process.argv[2];
// NOT under /tmp: macOS symlinks /tmp → /private/tmp, so realpath would shift the
// transcript-dir encoding and confuse the manual `ls ~/.claude/projects/<enc>` step.
const DEFAULT_CWD = join(homedir(), "eos-spike-handoff");

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function makeBackend() {
  return createClaudeSdkBackend({
    authResolver: createSubscriptionAuthResolver(),
    policy: { decide: async () => ({ behavior: "allow" }) },
    toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
    daemonUrl: "http://127.0.0.1:7400",
    makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
  });
}

// Run one turn against the SDK lane; resolve with the captured sessionId + the
// concatenated assistant text once the turn ends.
async function oneTurn(opts: { cwd: string; prompt: string; resume?: string }): Promise<{ sessionId: string | null; answer: string }> {
  const be = makeBackend();
  let sessionId: string | null = null;
  let answer = "";
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((r) => { resolveExit = r; });

  const session = await be.start(
    {
      workerId: "spike-resume", cwd: opts.cwd, model: MODEL, prompt: opts.prompt,
      persistent: false, parentId: null, isOrchestrator: false,
      backendOptions: { auth: { kind: "subscription" }, ...(opts.resume ? { resume: opts.resume } : {}) },
    },
    {
      onEvent: (e: AgentEvent) => {
        if (e.type === "session" && e.phase === "ready" && e.sessionId) sessionId = e.sessionId;
        if (e.type === "delta" && e.channel === "text") process.stdout.write(e.text);
        if (e.type === "message" && e.role === "assistant") {
          for (const b of e.blocks) if (b.type === "text") answer += b.text;
        }
        if (e.type === "turn" && e.phase === "ended") session.stop();
        if (e.type === "turn" && e.phase === "error") { console.error(`\n[turn error] ${e.reason ?? "?"}`); session.stop(); }
      },
      onExit: () => resolveExit(),
    },
  );
  await exited;
  return { sessionId, answer };
}

if (mode === "create") {
  const target = process.argv[3] ?? DEFAULT_CWD;
  mkdirSync(target, { recursive: true });
  const cwd = realpathSync(target);
  console.log(`\n[CREATE] seeding the magic word via the SDK lane in ${cwd}\n`);
  const { sessionId } = await oneTurn({ cwd, prompt: `Remember this fact for the rest of our conversation: the magic word is ${MAGIC}. Reply with just "OK".` });
  console.log("\n\n=== CREATE DONE ===");
  console.log(`sessionId: ${sessionId ?? "(none captured!)"}`);
  console.log(`cwd:       ${cwd}`);
  console.log(`transcript: ${join(homedir(), ".claude", "projects", encodeCwd(cwd))}/${sessionId ?? "<id>"}.jsonl`);
  console.log(`\nNow hand off:`);
  console.log(`  sdk→sdk : npx tsx backends/sdk/spike-resume.ts resume ${sessionId ?? "<id>"} ${cwd}`);
  console.log(`  sdk→cli : cd ${cwd} && claude --resume ${sessionId ?? "<id>"}   then ask "what is the magic word?"`);
  process.exit(0);
} else if (mode === "resume") {
  const sessionId = process.argv[3];
  if (!sessionId) { console.error("usage: spike-resume.ts resume <sessionId> [cwd]"); process.exit(1); }
  const cwd = realpathSync(process.argv[4] ?? DEFAULT_CWD);
  console.log(`\n[RESUME] resuming ${sessionId} via the SDK lane in ${cwd}\n`);
  const { answer } = await oneTurn({ cwd, resume: sessionId, prompt: "Earlier in this conversation I told you a magic word. What was it? Reply with just the word." });
  const ok = answer.includes(MAGIC);
  console.log("\n\n=== RESUME RESULT ===");
  console.log(`answer: ${answer.trim() || "(empty)"}`);
  console.log(`handoff: ${ok ? `GREEN — the SDK lane recalled "${MAGIC}" from the resumed transcript` : `RED — the magic word was NOT recalled (transcript did not cross-load)`}`);
  process.exit(ok ? 0 : 1);
} else {
  console.error("usage: spike-resume.ts <create|resume> [...]  (see header)");
  process.exit(1);
}
