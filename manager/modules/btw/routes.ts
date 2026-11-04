// The /btw side question (contracts/src/side-question.ts, plan
// docs/btw/00-BTW-PLAN.md):
//   POST /workers/:id/btw   the dashboard's (ui-token) → { answer }
// The answer rides the response; a caller that goes away cancels it.

import type { Router } from "../../routes/Router.ts";
import { writeJson } from "../../middleware/errorHandler.ts";
import { readBody } from "../../middleware/bodyReader.ts";
import { validate } from "../../middleware/validate.ts";
import { uiTokenOk } from "../../routes/fs-shared.ts";
import { askSideQuestion, type AskSideQuestionDeps } from "../../../core/src/use-cases/AskSideQuestion.ts";
import { SideQuestionRequestSchema, type SideQuestionAnswer } from "../../../contracts/src/side-question.ts";

export interface SideQuestionRouteDeps extends AskSideQuestionDeps {
  readonly uiToken: string;
}

const BTW = /^\/workers\/(?<id>[^/]+)\/btw$/;

export function registerSideQuestionRoutes(r: Router, c: SideQuestionRouteDeps): void {
  r.post(BTW, async ({ req, res, params }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(SideQuestionRequestSchema, await readBody(req));
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    try {
      const answer: SideQuestionAnswer = await askSideQuestion(
        c,
        { workerId: params.id, question: body.question, signal: abort.signal },
      );
      writeJson(res, 200, answer);
    } catch (e) {
      if (abort.signal.aborted) return;
      throw e;
    }
  });
}
