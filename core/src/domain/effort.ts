// Effort resolution against a model's capability list (from the live model
// catalog). Fail-open by design: unknown capability (null) and non-API level
// values (TUI-only "ultracode"/"auto") pass through untouched — the claude
// CLI stays the final authority. Only a known mismatch is corrected: clamp to
// the nearest supported level, or drop effort for models without any.

import { EFFORT_LEVELS } from "../../../contracts/src/shared.ts";

export function resolveEffort(
  requested: string | undefined,
  supported: readonly string[] | null,
): string | undefined {
  if (!requested) return undefined;
  const order = EFFORT_LEVELS as readonly string[];
  if (!order.includes(requested)) return requested;
  if (!supported) return requested;
  if (supported.includes(requested)) return requested;
  if (supported.length === 0) return undefined;
  const idx = order.indexOf(requested);
  for (let i = idx - 1; i >= 0; i--) {
    if (supported.includes(order[i])) return order[i];
  }
  for (let i = idx + 1; i < order.length; i++) {
    if (supported.includes(order[i])) return order[i];
  }
  return undefined;
}
