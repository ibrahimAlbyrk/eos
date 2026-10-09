// What a daemon refusal means for present / present_app. ctx.api rejects with
// "daemon <status>: <raw body>"; the model should read the daemon's own reason
// or the exact problem list, never that HTTP wrapper.

import { formatProblems, type ViewProblem } from "../../../contracts/src/genui/catalog.ts";
import { GENUI_OFF_TEXT } from "../../../contracts/src/genui/spec.ts";
import { GENUI_APPS_OFF_TEXT } from "../../../core/src/use-cases/PresentView.ts";

export interface DaemonRefusal {
  status: number | null;
  reason: string;
  problems: ViewProblem[] | null;
}

export function refusalOf(e: unknown): DaemonRefusal {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^daemon (\d+): (.*)$/s.exec(msg);
  if (!m) return { status: null, reason: msg, problems: null };
  let body: { error?: unknown; problems?: unknown } | null = null;
  try {
    body = JSON.parse(m[2]) as { error?: unknown; problems?: unknown };
  } catch {
    // not the daemon's JSON — keep the raw text
  }
  const list = Array.isArray(body?.problems) && body.problems.length > 0 && body.problems.every(isProblem) ? (body.problems as ViewProblem[]) : null;
  const err = typeof body?.error === "string" ? body.error.replace(/^invalid request: /, "") : null;
  return { status: Number(m[1]), reason: err ?? m[2], problems: list };
}

function isProblem(p: unknown): boolean {
  return p !== null && typeof p === "object" && typeof (p as ViewProblem).path === "string" && typeof (p as ViewProblem).message === "string";
}

// The user switched the feature off: the model should take the daemon's sentence
// as the answer rather than retry, so it goes back as a normal result.
export function isSwitchedOff(r: DaemonRefusal): boolean {
  return r.reason === GENUI_OFF_TEXT || r.reason === GENUI_APPS_OFF_TEXT;
}

// "<tool>: N problems — nothing rendered\n· path: message…\nfix and call <tool> again".
export function problemsText(tool: string, problems: readonly ViewProblem[]): string {
  return `${tool}: ${formatProblems(problems).replace(/call present again$/, `call ${tool} again`)}`;
}
