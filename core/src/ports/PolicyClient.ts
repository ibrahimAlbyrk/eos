import type { ExternalDecision } from "../../../contracts/src/policy.ts";

export interface PolicyClient {
  decidePolicy(input: {
    workerId: string;
    toolName: string;
    input: Record<string, unknown>;
    toolUseId?: string | null;
  }): Promise<ExternalDecision>;
}
