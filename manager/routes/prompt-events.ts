import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import type { WorkerEventRow, WorkerEventType } from "../../contracts/src/events.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { sanitizeEventRowForDisplay } from "../shared/display-sanitize.ts";

// Every row the web needs to rebuild the full conversation-turn index: the
// prompts themselves plus the markers that hide some of them (clear, rewind,
// recall). The transcript window pages lazily; the turn rail must not.
const PROMPT_EVENT_TYPES: WorkerEventType[] = [
  "user_message", "orchestrator_message",
  "conversation_cleared", "conversation_rewound", "message_recalled",
];

export function registerPromptEventRoutes(r: Router, c: Container): void {
  r.get(/^\/workers\/(?<id>[^/]+)\/prompt-events$/, ({ params, res }) => {
    const rows: WorkerEventRow[] = PROMPT_EVENT_TYPES.flatMap((t) => c.events.listByType(params.id, t));
    rows.sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
    writeJson(res, 200, rows.map(sanitizeEventRowForDisplay));
  });
}
