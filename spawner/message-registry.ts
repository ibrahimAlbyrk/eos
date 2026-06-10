// PendingMessageRegistry — pairs daemon-dispatched messages with the moment
// they land in the transcript JSONL, so the worker can emit the durable
// user_message/orchestrator_message chat event in true conversation order.
// (A daemon append at dispatch time races the previous turn's trailing
// transcript output and gets durably ordered above the agent's final text.)
//
// Lifecycle of an entry:
//   register   — at /message receipt, when the daemon asked for a record.
//   consume    — a transcript user entry matched (same tolerance as the
//                delivery turn-ACK) → emit at the user entry's position.
//   resolve    — the delivery settled without a transcript sighting:
//                "unverified" → emit anyway (almost certainly delivered),
//                "failed"     → drop (the delivery_failed line is the signal).
//   flush      — interrupt/exit: emit whatever is still pending so a message
//                Claude may never consume still shows in the chat (parity
//                with the old at-dispatch recording).

import { normalizeForMatch, ackMatches, ACK_MATCH_PREFIX } from "./delivery.ts";
import type { MessageRecord } from "../contracts/src/http.ts";

export type { MessageRecord };

export interface PendingMessage {
  text: string;
  record: MessageRecord;
}

interface Entry extends PendingMessage {
  norm: string;
}

// Bounds memory if transcript sightings never come (e.g. a long mid-turn
// steer queue); oldest entries are emitted on overflow rather than dropped —
// a silently vanishing chat message is worse than an early-ordered one.
const REGISTRY_CAP = 50;

export class PendingMessageRegistry {
  private entries: Entry[] = [];

  /** Returns entries evicted by the cap — the caller must emit them. */
  register(text: string, record: MessageRecord): PendingMessage[] {
    this.entries.push({ text, record, norm: normalizeForMatch(text).slice(0, ACK_MATCH_PREFIX) });
    const evicted: PendingMessage[] = [];
    while (this.entries.length > REGISTRY_CAP) evicted.push(this.entries.shift()!);
    return evicted;
  }

  /** All entries matching a transcript user entry, in registration order.
   *  Consumes more than one when the TUI merged messages into a single
   *  submission (e.g. after an Esc returned a queued steer to the composer). */
  consumeMatching(observedText: string): PendingMessage[] {
    const observedNorm = normalizeForMatch(observedText).slice(0, ACK_MATCH_PREFIX);
    if (observedNorm.length === 0) return [];
    const hits: PendingMessage[] = [];
    this.entries = this.entries.filter((e) => {
      if (e.norm.length > 0 && ackMatches(e.norm, observedNorm)) { hits.push(e); return false; }
      return true;
    });
    return hits;
  }

  /** The entry for an exact delivery text (unverified/failed resolution). */
  consumeByText(text: string): PendingMessage | null {
    const i = this.entries.findIndex((e) => e.text === text);
    if (i < 0) return null;
    return this.entries.splice(i, 1)[0];
  }

  drainAll(): PendingMessage[] {
    const all = this.entries;
    this.entries = [];
    return all;
  }
}
