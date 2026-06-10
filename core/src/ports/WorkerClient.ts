// WorkerClient — daemon → worker IPC port. Today the only operation is "send
// a message to the worker's PTY"; future operations (PTY resize, status
// probe) live here.

import type { MessageRecord } from "../../../contracts/src/http.ts";
export type { MessageRecord };

export interface RewindResult {
  ok: boolean;
  uuid?: string;
  text?: string;
  display?: string;
  index?: number;
  error?: string;
}

export interface WorkerClient {
  sendMessage(port: number, text: string, record?: MessageRecord): Promise<{ ok: boolean; status: number; body: unknown }>;
  sendKeystroke(port: number, keys: string): Promise<{ ok: boolean }>;
  /** Drive Claude's native AskUserQuestion menu with verified keystrokes. */
  answerQuestion(port: number, selections: unknown[]): Promise<{ ok: boolean; outcome?: string }>;
  sendInterrupt(port: number): Promise<{ ok: boolean; reason?: string }>;
  getRewindTargets(port: number): Promise<{ targets: unknown[] }>;
  sendRewind(port: number, body: { uuid: string; mode: string }): Promise<RewindResult>;
}
