// RecentsRepo — persistence port for the "recent folders" list shown in the
// composer folder dropdown. Most-recent-first, deduped, capped at maxEntries
// (implementation decides cap; callers don't).

export interface RecentsRepo {
  list(): string[];
  push(path: string): void;
}
