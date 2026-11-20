import type { ApnsSender, PushKind } from "./apns.ts";
import type { PushRate } from "./rate.ts";
import type { PushTokens } from "./tokens.ts";

// One push from a room's owner to every phone of the room, over the socket or over HTTP alike.
export type PushAnswer = { sent: number; failed: number; gone: number; reason?: "throttled" | "not-configured" };

export class Pusher {
  private readonly tokens: PushTokens;
  private readonly sender: ApnsSender;
  private readonly rate: PushRate;

  constructor(tokens: PushTokens, sender: ApnsSender, rate: PushRate) {
    this.tokens = tokens;
    this.sender = sender;
    this.rate = rate;
  }

  // The caller has checked the owner, the kind and the count.
  async push(room: string, kind: PushKind, count: number): Promise<PushAnswer> {
    if (!this.rate.take(room)) return { sent: 0, failed: 0, gone: 0, reason: "throttled" };
    const targets = this.tokens.targets(room);
    const results = await this.sender.send(room, kind, count, targets);
    if (results === "not-configured") return { sent: 0, failed: targets.length, gone: 0, reason: "not-configured" };
    const answer = { sent: 0, failed: 0, gone: 0 };
    results.forEach((r, i) => {
      answer[r.result] += 1;
      if (r.result === "gone") this.tokens.removeToken(room, targets[i].deviceHash, targets[i].token);
    });
    return answer;
  }
}
