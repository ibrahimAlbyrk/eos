// AgentBackendJudgeClient — a JudgeClient over an INJECTED appendless AgentBackend.
// Each judge() spins a throwaway ephemeral session whose ONLY prompt is the
// rubric (the backend carries no Eos protocol/memory/tools), accumulates the
// assistant text, and stops the session at turn end. Host is gated by CAPABILITY
// (in-process + enabled + a resolvable subscription credential), never by kind.

import type { JudgeClient } from "../../core/src/ports/JudgeClient.ts";
import type { AgentBackend, AgentSession, AgentLaunchSpec } from "../../core/src/ports/AgentBackend.ts";
import type { AuthResolver } from "../../core/src/ports/AuthResolver.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";

// A judge turn is a single text completion; cap it so a stuck session can't pin
// the loop. On timeout we return whatever text accumulated (likely unparseable →
// fail-closed to unmet upstream).
const JUDGE_TURN_TIMEOUT_MS = 120_000;

export interface AgentBackendJudgeClientDeps {
  backend: AgentBackend;
  auth: Pick<AuthResolver, "resolve">;
  newId(): string;
  cwd: string;
  defaultModel: string;
  log?: Logger;
}

export class AgentBackendJudgeClient implements JudgeClient {
  private readonly deps: AgentBackendJudgeClientDeps;

  constructor(deps: AgentBackendJudgeClientDeps) {
    this.deps = deps;
  }

  async judge(prompt: string, opts?: { model?: string; temperature?: number }): Promise<string> {
    const d = this.deps.backend.descriptor;
    if (d.processModel !== "in-process" || !d.enabled) {
      throw new Error(`judge backend unavailable: ${d.kind} is not an enabled in-process lane`);
    }
    const resolved = await this.deps.auth.resolve({ kind: "subscription" });
    if (resolved.scheme === "none") {
      throw new Error("judge backend unavailable: no subscription credential");
    }

    const spec: AgentLaunchSpec = {
      workerId: this.deps.newId(),
      cwd: this.deps.cwd,
      model: opts?.model ?? this.deps.defaultModel,
      prompt,
      persistent: false,
      parentId: null,
      isOrchestrator: false,
      backendOptions: {
        auth: { kind: "subscription" },
        ...(opts?.temperature != null ? { params: { temperature: opts.temperature } } : {}),
      },
    };

    return new Promise<string>((resolve) => {
      let buf = "";
      let session: AgentSession | null = null;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { session?.stop(); } catch { /* idempotent best-effort */ }
        resolve(buf);
      };
      const timer = setTimeout(finish, JUDGE_TURN_TIMEOUT_MS);

      void this.deps.backend
        .start(spec, {
          onEvent: (e) => {
            if (e.type === "message" && e.role === "assistant") {
              for (const b of e.blocks) if (b.type === "text") buf += b.text;
            } else if (e.type === "turn" && (e.phase === "ended" || e.phase === "aborted" || e.phase === "error")) {
              finish();
            }
          },
          onExit: () => finish(),
        })
        .then((s) => { session = s; })
        .catch((err) => {
          this.deps.log?.warn("judge session failed to start", { error: err instanceof Error ? err.message : String(err) });
          finish();
        });
    });
  }
}
