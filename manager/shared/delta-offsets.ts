// Where each live `agent:delta` starts in its block's text (`at`). A client that
// also holds the text so far — a resume snapshot, a pane that just came into
// view — merges it with the deltas exactly, instead of guessing whether it
// already has one.

// Blocks that never see their stop (a crashed turn) must not pile up.
const MAX_OPEN_BLOCKS = 512;

export class DeltaOffsets {
  private readonly lengths = new Map<string, number>();

  next(workerId: string, blockId: string, phase: "start" | "append" | "stop", textLength: number): number {
    const key = `${workerId}\0${blockId}`;
    const at = phase === "start" ? 0 : this.lengths.get(key) ?? 0;
    this.lengths.delete(key);
    if (phase === "stop") return at;
    this.lengths.set(key, at + textLength);
    while (this.lengths.size > MAX_OPEN_BLOCKS) this.lengths.delete(this.lengths.keys().next().value as string);
    return at;
  }
}
