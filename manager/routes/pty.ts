import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import {
  PtyAnswerRequestSchema,
  PtyCreateRequestSchema,
  PtyInputRequestSchema,
  PtyMessageRequestSchema,
  PtyResizeRequestSchema,
  type PtyConversationResponse,
} from "../../contracts/src/http.ts";
import { PtyCapError } from "../services/PtySessionService.ts";
import {
  AnswerShapeError, answerSteps, approvePlanSteps, isShellProcess, type AskQuestionShape,
} from "../services/pty/claudeKeys.ts";
import { deliverPrompt } from "../services/pty/deliverPrompt.ts";

// Interactive multi-tab PTY routes. EVERY handler copies the UI-token gate the
// POST /terminal handler uses: a raw interactive shell is arbitrary exec, so an
// agent holding EOS_DAEMON_URL must never reach these. The daemon loopback-locks
// the port; the per-boot ui-token is the second lock. A paired phone reaches them
// through the remote dispatcher, which supplies the token (manager/remote/tiers.ts).

export function registerPtyRoutes(r: Router, c: Container): void {
  r.post("/pty", async ({ req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(PtyCreateRequestSchema, await readBody(req));
    try {
      writeJson(res, 200, c.ptySessions.create(body));
    } catch (e) {
      if (e instanceof PtyCapError) { writeJson(res, 429, { error: e.message }); return; }
      throw e;
    }
  });

  r.get("/pty", ({ req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    writeJson(res, 200, { sessions: c.ptySessions.list() });
  });

  r.post(/^\/pty\/(?<id>[^/]+)\/input$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(PtyInputRequestSchema, await readBody(req));
    if (!c.ptySessions.input(params.id, body.data)) { writeJson(res, 404, { error: "session not found" }); return; }
    writeJson(res, 200, { ok: true });
  });

  r.post(/^\/pty\/(?<id>[^/]+)\/resize$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(PtyResizeRequestSchema, await readBody(req));
    if (!c.ptySessions.resize(params.id, body.cols, body.rows)) { writeJson(res, 404, { error: "session not found" }); return; }
    writeJson(res, 200, { ok: true });
  });

  r.get(/^\/pty\/(?<id>[^/]+)\/buffer$/, ({ params, req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const buf = c.ptySessions.buffer(params.id);
    if (!buf) { writeJson(res, 404, { error: "session not found" }); return; }
    writeJson(res, 200, buf);
  });

  r.get(/^\/pty\/(?<id>[^/]+)\/conversation$/, ({ params, url, req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const conv = c.ptyConversations.get(params.id);
    if (!conv) { writeJson(res, 404, { error: "no claude session" }); return; }
    const afterId = Number(url.searchParams.get("afterId")) || 0;
    const body: PtyConversationResponse = {
      claudeSessionId: conv.claudeSessionId,
      rows: conv.rows.filter((row) => row.id > afterId),
      running: conv.running,
      pending: conv.pending,
    };
    writeJson(res, 200, body);
  });

  r.post(/^\/pty\/(?<id>[^/]+)\/message$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(PtyMessageRequestSchema, await readBody(req));
    const conv = claudeReady(params.id, res);
    if (!conv) return;
    // Typed into an open dialog, the prompt would answer it with garbage.
    if (conv.pending) { writeJson(res, 409, { error: "Claude is waiting for an answer", pending: conv.pending.name }); return; }
    const delivered = await deliverPrompt({
      send: (steps) => c.ptySessions.sendSteps(params.id, steps),
      conversation: () => c.ptyConversations.get(params.id),
    }, body.text);
    if (!delivered) { writeJson(res, 404, { error: "session not found" }); return; }
    writeJson(res, 200, { ok: true });
  });

  // Tool calls already answered from here: a second device (or a double tap)
  // answering the same dialog would type its keys into the composer instead.
  const answered = new Set<string>();

  r.post(/^\/pty\/(?<id>[^/]+)\/answer$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(PtyAnswerRequestSchema, await readBody(req));
    const conv = claudeReady(params.id, res);
    if (!conv) return;
    const pending = conv.pending;
    if (!pending || pending.toolUseId !== body.toolUseId || answered.has(body.toolUseId)) {
      writeJson(res, 409, { error: "that question is no longer open" });
      return;
    }
    let steps: string[];
    try {
      if (pending.name === "ExitPlanMode") {
        if (!body.approve) throw new AnswerShapeError("expected approve: true");
        steps = approvePlanSteps();
      } else {
        steps = answerSteps(askShapes(pending.input), body.answers ?? []);
      }
    } catch (e) {
      if (e instanceof AnswerShapeError) { writeJson(res, 400, { error: e.message }); return; }
      throw e;
    }
    answered.add(body.toolUseId);
    if (!(await c.ptySessions.sendSteps(params.id, steps))) { writeJson(res, 404, { error: "session not found" }); return; }
    writeJson(res, 200, { ok: true });
  });

  // The pane's conversation, when Claude (not the shell it drops back to) is
  // in the foreground to receive keys; otherwise answers 404/409 itself.
  function claudeReady(id: string, res: Parameters<typeof writeJson>[0]) {
    const conv = c.ptyConversations.get(id);
    if (!conv) { writeJson(res, 404, { error: "no claude session" }); return null; }
    const fg = c.ptySessions.foreground(id);
    if (fg === null || isShellProcess(fg)) { writeJson(res, 409, { error: "Claude is not running in this terminal" }); return null; }
    return conv;
  }

  r.del(/^\/pty\/(?<id>[^/]+)$/, ({ params, req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    if (!c.ptySessions.kill(params.id)) { writeJson(res, 404, { error: "session not found" }); return; }
    writeJson(res, 200, { ok: true });
  });
}

// Question shapes from an AskUserQuestion call's input — what the keys address.
function askShapes(input: Record<string, unknown>): AskQuestionShape[] {
  const qs = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown> | null>) : [];
  return qs.map((q) => ({
    multiSelect: q?.multiSelect === true,
    optionCount: Array.isArray(q?.options) ? q.options.length : 0,
  }));
}
