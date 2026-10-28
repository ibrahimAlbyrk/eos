// The /btw side question: one question answered from a worker's live
// conversation, read-only, never added to it. Plan: docs/btw/00-BTW-PLAN.md.

import { z } from "zod";

export const SIDE_QUESTION_MAX_CHARS = 4000;

export const SideQuestionRequestSchema = z.object({
  question: z.string().trim().min(1).max(SIDE_QUESTION_MAX_CHARS),
});
export type SideQuestionRequest = z.infer<typeof SideQuestionRequestSchema>;

export interface SideQuestionAnswer {
  answer: string;
}
