// What runs when a worker settles at IDLE with nothing left in its queue —
// compaction, the goal loop, the report and context nudges, a feature's own —
// in `order`. A hook that returns true has taken the worker (it's working again),
// so the hooks after it wait for its next IDLE.

export interface IdleHook {
  readonly id: string;
  readonly order: number;
  run(workerId: string): boolean | void;
}

export class IdleHooks {
  private hooks: IdleHook[] = [];

  add(hook: IdleHook): () => void {
    this.hooks = [...this.hooks.filter((h) => h.id !== hook.id), hook].sort((a, b) => a.order - b.order);
    return () => { this.hooks = this.hooks.filter((h) => h !== hook); };
  }

  run(workerId: string): void {
    for (const hook of this.hooks) {
      if (hook.run(workerId) === true) return;
    }
  }
}
