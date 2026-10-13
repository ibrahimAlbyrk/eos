// The last good plan-usage snapshot per provider, as one JSON file under the
// daemon home. Regenerable: a missing or unreadable file just means the next
// fetch starts from nothing.

import { readFileSync } from "node:fs";
import type { UsageSnapshotStore } from "../../../core/src/ports/SubscriptionUsageProvider.ts";
import { ProviderUsageSchema } from "../../../contracts/src/usage.ts";
import { writeFileAtomic } from "../persistence/atomic-file.ts";

export function createFileUsageSnapshotStore(path: string): UsageSnapshotStore {
  return {
    load() {
      try {
        const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
        return (Array.isArray(raw) ? raw : []).flatMap((entry) => {
          const parsed = ProviderUsageSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        });
      } catch {
        return [];
      }
    },
    save(snapshots) {
      writeFileAtomic(path, JSON.stringify(snapshots));
    },
  };
}
