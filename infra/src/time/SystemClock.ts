import type { Clock } from "../../../core/src/ports/Clock.ts";

export const systemClock: Clock = {
  now: (): number => Date.now(),
};
