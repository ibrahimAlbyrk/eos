// PresentView — the one write path for visual answers (present + present_app):
// the user's switches, the full check (an injected validator — contracts'
// validateView / validateApp in production), a fresh view id, the stored record.
// A rejection carries every problem with its path, so the model fixes them all
// in one more call. Plan: docs/genui/00-GENUI-PLAN.md.

import type { Clock } from "../ports/Clock.ts";
import type { GenuiViewRepo } from "../ports/GenuiViewRepo.ts";
import { PermissionDeniedError, ValidationError } from "../errors/index.ts";
import { PRESENT_KEYS, formatProblems, type ViewProblem, type ViewStats, type ViewValidation } from "../../../contracts/src/genui/catalog.ts";
import {
  GENUI_OFF_TEXT,
  type AppValidation,
  type GenuiLevel,
  type PresentAppInput,
  type PresentInput,
  type ViewRecord,
} from "../../../contracts/src/genui/spec.ts";

export const GENUI_APPS_OFF_TEXT = "Apps are turned off in Settings — use present or plain text";

const APP_KEYS = ["title", "html", "summary", "height"] as const;
// A collision in 62^12 is a bug elsewhere, not bad luck — give up instead of spinning.
const MAX_ID_TRIES = 4;

export interface GenuiSwitches {
  readonly level: GenuiLevel;
  readonly apps: boolean;
}

export interface PresentViewDeps {
  readonly views: Pick<GenuiViewRepo, "save" | "get">;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly validateView: (input: unknown) => ViewValidation;
  readonly validateApp: (input: unknown) => AppValidation;
  // Read per call: Settings changes apply to the next present.
  readonly settings: () => GenuiSwitches;
}

export interface PresentViewResult {
  viewId: string;
  warnings: ViewProblem[];
  stats: ViewStats;
}

export interface PresentAppResult {
  viewId: string;
  warnings: ViewProblem[];
}

// A spec that failed the check. message = formatProblems(problems), the text the
// tool hands the model.
export class GenuiRejectedError extends ValidationError {
  readonly problems: ViewProblem[];
  readonly warnings: ViewProblem[];

  constructor(problems: ViewProblem[], warnings: ViewProblem[]) {
    super(formatProblems(problems));
    this.problems = problems;
    this.warnings = warnings;
  }
}

export function presentView(deps: PresentViewDeps, workerId: string, input: unknown): PresentViewResult {
  if (deps.settings().level === "text") throw new PermissionDeniedError(GENUI_OFF_TEXT);
  const checked = deps.validateView(input);
  if (!checked.ok) throw new GenuiRejectedError(checked.problems, checked.warnings);

  const spec = pick(input as Record<string, unknown>, PRESENT_KEYS) as PresentInput;
  const warnings = [...checked.warnings];
  if (spec.replaces) {
    const earlier = deps.views.get(spec.replaces);
    if (!earlier || earlier.workerId !== workerId) {
      warnings.push({ path: "replaces", message: `${spec.replaces} is not one of your views — shown as a new view` });
    }
  }
  const viewId = mintId(deps);
  deps.views.save({ id: viewId, workerId, title: spec.title, createdAt: deps.clock.now(), kind: "view", spec });
  return { viewId, warnings, stats: checked.stats };
}

export function presentApp(deps: PresentViewDeps, workerId: string, input: unknown): PresentAppResult {
  const switches = deps.settings();
  if (switches.level === "text") throw new PermissionDeniedError(GENUI_OFF_TEXT);
  if (!switches.apps) throw new PermissionDeniedError(GENUI_APPS_OFF_TEXT);
  const checked = deps.validateApp(input);
  if (!checked.ok) throw new GenuiRejectedError(checked.problems, checked.warnings);

  const spec = pick(input as Record<string, unknown>, APP_KEYS) as PresentAppInput;
  const viewId = mintId(deps);
  const record: ViewRecord = { id: viewId, workerId, title: spec.title, createdAt: deps.clock.now(), kind: "app", spec };
  deps.views.save(record);
  return { viewId, warnings: [...checked.warnings] };
}

function mintId(deps: Pick<PresentViewDeps, "newId" | "views">): string {
  for (let i = 0; i < MAX_ID_TRIES; i++) {
    const id = deps.newId();
    if (!deps.views.get(id)) return id;
  }
  throw new Error("could not mint a fresh view id");
}

// Only the tool's own fields are stored — the check already warned about the rest.
function pick(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (input[k] !== undefined) out[k] = input[k];
  return out;
}
