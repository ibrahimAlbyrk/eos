// JudgeClient — a single-shot LLM call that returns raw text. ONE method (ISP):
// LlmJudgeStrategy depends on THIS, never on AgentBackend, so the judge can't
// accidentally reach the worker's protocol/tools. The adapter
// (AgentBackendJudgeClient) drives an appendless ephemeral backend session.

export interface JudgeClient {
  judge(prompt: string, opts?: { model?: string; temperature?: number }): Promise<string>;
}
