// PageStore — persistence port for pages (markdown notes shared by the user and
// agents). put() writes the whole page; remove() is recoverable where the
// adapter supports it.

import type { Page } from "../../../contracts/src/http.ts";

export interface PageStore {
  list(): Page[];
  get(id: string): Page | null;
  put(page: Page): void;
  remove(id: string): boolean;
}
