// Constant-time string comparison for security tokens. A plain `===` on a
// secret leaks its length and a prefix-match position through timing; the
// ui-token guards are remote-reachable once the /ws edge is armed (design §4.5,
// §4.7), so both compares must be constant-time.

import { timingSafeEqual } from "node:crypto";

// True iff `value` equals `expected` in constant time. A missing/array header
// value, or any length mismatch, returns false WITHOUT a timing-variable
// compare — length is not itself secret here (the token is fixed-length), and
// timingSafeEqual requires equal-length buffers.
export function constantTimeEqual(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== "string") return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
