// JsonlConversationStore — file-backed ConversationStore. One conversation per
// session under <root>/<sessionId>.jsonl, one neutral ModelMessage per line.
// Rewrite-on-save (the whole conversation each settled turn): simplest correct
// rehydrate-by-replay, atomic via tmp + rename so a crash mid-write never leaves a
// truncated transcript. Non-regenerable user data (~/.eos/conversations) — `delete`
// removes a single session file, never the directory.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ConversationStore } from "../../../core/src/ports/ConversationStore.ts";
import type { ModelMessage } from "../../../core/src/ports/ModelClient.ts";
import { safeStringify } from "../util/json.ts";

export class JsonlConversationStore implements ConversationStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private fileFor(sessionId: string): string {
    return join(this.root, `${sessionId}.jsonl`);
  }

  save(_workerId: string, sessionId: string, messages: ModelMessage[]): void {
    if (!sessionId) return;
    const file = this.fileFor(sessionId);
    mkdirSync(this.root, { recursive: true });
    const body = messages.map((m) => safeStringify(m)).join("\n");
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
  }

  load(sessionId: string): ModelMessage[] | null {
    if (!sessionId) return null;
    const file = this.fileFor(sessionId);
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf8");
    const messages: ModelMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      messages.push(JSON.parse(line) as ModelMessage);
    }
    return messages;
  }

  delete(sessionId: string): void {
    if (!sessionId) return;
    const file = this.fileFor(sessionId);
    if (existsSync(file)) rmSync(file);
  }
}
