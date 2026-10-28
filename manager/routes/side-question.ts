// The /btw side question (contracts/src/side-question.ts, plan
// docs/btw/00-BTW-PLAN.md):
//   POST /workers/:id/btw   the dashboard's (ui-token) → { answer }
// The answer rides the response; a caller that goes away cancels it.

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { resumeIfDead } from "./resume-helpers.ts";
import { askSideQuestion } from "../../core/src/use-cases/AskSideQuestion.ts";
import { SideQuestionRequestSchema, type SideQuestionAnswer } from "../../contracts/src/side-question.ts";

const BTW = /^\/workers\/(?<id>[^/]+)\/btw$/;

export function registerSideQuestionRoutes(r: Router, c: Container): void {
  r.post(BTW, async ({ req, res, params }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(SideQuestionRequestSchema, await readBody(req));
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    try {
      const answer: SideQuestionAnswer = await askSideQuestion(
        { workers: c.workers, revive: (w) => resumeIfDead(c, w), session: c.inProcessSession },
        { workerId: params.id, question: body.question, signal: abort.signal },
      );
      writeJson(res, 200, answer);
    } catch (e) {
      if (abort.signal.aborted) return;
      throw e;
    }
  });
}
