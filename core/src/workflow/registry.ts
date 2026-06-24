// registry.ts — the in-memory StepExecutorRegistry (the Open/Closed seam, §3.11).
// Executors register explicitly at the composition root (one per node `type`);
// `get` throws a clear, enumerated error on an unknown type so a malformed spec
// fails loud. Clone of makeStrategyFor. Pure: no Node, no time/random.

import type { StepExecutor } from "../ports/StepExecutor.ts";
import type { StepExecutorRegistry } from "../ports/StepExecutorRegistry.ts";

export class InMemoryStepExecutorRegistry implements StepExecutorRegistry {
  private readonly executors: Map<string, StepExecutor>;

  constructor() {
    this.executors = new Map();
  }

  register(exec: StepExecutor): void {
    this.executors.set(exec.type, exec);
  }

  get(type: string): StepExecutor {
    const exec = this.executors.get(type);
    if (!exec) {
      const known = this.executors.size ? this.types().join(", ") : "none";
      throw new Error(`no step executor for node type "${type}" (registered: ${known})`);
    }
    return exec;
  }

  has(type: string): boolean {
    return this.executors.has(type);
  }

  types(): string[] {
    return [...this.executors.keys()];
  }
}
