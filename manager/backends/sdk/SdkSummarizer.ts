// SdkSummarizer — the context-compaction summarizer on the claude lane: ONE
// query() with its own system prompt, no tools, no MCP, no settings/memory, no
// persisted session, a single turn. Runs on the compacted agent's model so the
// transcript fits that model's window. Rejects on failure or timeout — the
// caller then keeps the old session.

import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ConversationSummarizer, SummarizeInput } from "../../../core/src/ports/ConversationSummarizer.ts";
import type { AuthResolver } from "../../../core/src/ports/AuthResolver.ts";
import type { SdkQueryFn, SdkQueryHandle } from "./ClaudeSdkBackend.ts";
import { buildBillingGuardEnv } from "./billing-env.ts";

export interface SdkSummarizerDeps {
  authResolver: Pick<AuthResolver, "resolve">;
  daemonUrl: string;
  getAnthropicConfig?(): { apiKey?: string; authToken?: string };
  /** Used when the compacted agent's row has no model. */
  defaultModel: string;
  cwd: string;
  queryFn?: SdkQueryFn;
}

type SdkOutput = {
  type?: string;
  subtype?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
};

async function* single(text: string): AsyncIterable<unknown> {
  yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" };
}

export function createSdkSummarizer(deps: SdkSummarizerDeps): ConversationSummarizer {
  const queryFn: SdkQueryFn = deps.queryFn ?? ((p) => realQuery(p as never) as unknown as SdkQueryHandle);
  return {
    async summarize(input: SummarizeInput): Promise<string> {
      const auth = await deps.authResolver.resolve({ kind: "subscription" });
      if (auth.scheme === "none") throw new Error("no subscription credential for the summarizer");
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), input.timeoutMs);
      const options = {
        model: input.model ?? deps.defaultModel,
        cwd: deps.cwd,
        env: buildBillingGuardEnv({
          auth, anthropic: deps.getAnthropicConfig?.() ?? {}, workerId: "compaction-summarizer",
          daemonUrl: deps.daemonUrl, disableAutoCompact: true,
        }),
        systemPrompt: input.system,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        persistSession: false,
        maxTurns: 1,
        abortController: abort,
      } as Options;
      let text = "";
      try {
        for await (const raw of queryFn({ prompt: single(input.prompt), options })) {
          const msg = raw as SdkOutput;
          if (msg.type === "assistant") {
            for (const b of msg.message?.content ?? []) if (b.type === "text" && b.text) text += b.text;
          } else if (msg.type === "result") {
            if (msg.subtype !== "success") throw new Error(`summarizer ended with ${msg.subtype ?? "an error"}`);
            break;
          }
        }
      } catch (e) {
        if (abort.signal.aborted) throw new Error(`summarizer timed out after ${Math.round(input.timeoutMs / 1000)}s`, { cause: e });
        throw e;
      } finally {
        clearTimeout(timer);
      }
      return text;
    },
  };
}
