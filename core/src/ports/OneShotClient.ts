// OneShotClient — a single predetermined-prompt LLM completion that returns raw
// text. ONE method (ISP), mirroring JudgeClient: a micro-task depends on THIS,
// never on AgentBackend, so it can't reach a worker's protocol/tools. The
// adapter is a thin neutral wrapper over the judge one-shot path, wired later.

export interface OneShotClient {
  complete(prompt: string, opts?: { model?: string }): Promise<string>;
}
