// LlmJudgeStrategy — grades the goal with an LLM judge over collected ARTIFACTS.
// Fail-closed at every step: a failed evidence collection, a failed judge call,
// or unparseable output → unmet (NEVER met-by-default, NEVER a crash). Malformed
// output gets ONE reparse retry. The verdict is normalized so `met` can only be
// true when the judge's flag AND every criterion agree (consistency tightens
// toward unmet, never loosens).

import { JUDGE_RUBRIC_TEMPLATE, buildJudgeVars } from "../domain/judge-rubric.ts";
import { GoalVerdictSchema } from "../../../contracts/src/loop.ts";
import type { GoalSpec, GoalVerdict } from "../../../contracts/src/loop.ts";
import type { GoalCheckStrategy, GoalContext } from "../ports/GoalCheckStrategy.ts";
import type { JudgeClient } from "../ports/JudgeClient.ts";
import type { EvidenceCollector } from "../ports/EvidenceCollector.ts";
import type { PromptRenderer } from "../ports/PromptRenderer.ts";
import type { Logger } from "../ports/Logger.ts";

export interface LlmJudgeStrategyDeps {
  judge: JudgeClient;
  evidence: EvidenceCollector;
  renderer: PromptRenderer;
  // From config.loop.judge.temperature (default 0.1). NOTE: the claude-sdk lane
  // the judge runs on does not expose a per-call temperature (the agent SDK
  // surfaces only model/effort/thinking), so this is passed through but ignored
  // there — see AgentBackendJudgeClient.
  temperature: number;
  log: Logger;
}

export class LlmJudgeStrategy implements GoalCheckStrategy {
  private readonly deps: LlmJudgeStrategyDeps;

  constructor(deps: LlmJudgeStrategyDeps) {
    this.deps = deps;
  }

  async evaluate(goal: GoalSpec, ctx: GoalContext): Promise<GoalVerdict> {
    let bundle;
    try {
      bundle = await this.deps.evidence.collect(goal, ctx);
    } catch (e) {
      return failClosed(goal, `evidence collection failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const vars = buildJudgeVars(goal, bundle);
    const opts = { temperature: this.deps.temperature };

    let parsed = await this.tryJudge(this.deps.renderer.render(JUDGE_RUBRIC_TEMPLATE, vars).trim(), opts);
    if (!parsed) parsed = await this.tryJudge(this.deps.renderer.render(JUDGE_RUBRIC_TEMPLATE, { ...vars, RETRY: "1" }).trim(), opts);
    if (!parsed) {
      this.deps.log.warn("judge output unparseable", { workerId: ctx.workerId });
      return failClosed(goal, "judge output unparseable");
    }
    return normalize(parsed);
  }

  private async tryJudge(prompt: string, opts: { temperature: number }): Promise<GoalVerdict | null> {
    try {
      return parseVerdict(await this.deps.judge.judge(prompt, opts));
    } catch (e) {
      this.deps.log.warn("judge call failed", { error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }
}

function parseVerdict(raw: string): GoalVerdict | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const r = GoalVerdictSchema.safeParse(JSON.parse(stripped.slice(start, end + 1)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

// met only when the judge's overall flag AND every criterion agree — tightens
// toward unmet, never loosens. unmet is the union of the judge's list and every
// met:false criterion.
function normalize(v: GoalVerdict): GoalVerdict {
  const met = v.met && v.criteria.length > 0 && v.criteria.every((c) => c.met);
  const unmet = new Set(v.unmet);
  for (const c of v.criteria) if (!c.met) unmet.add(c.id);
  return { ...v, met, unmet: [...unmet] };
}

function failClosed(goal: GoalSpec, reason: string): GoalVerdict {
  return {
    met: false,
    criteria: goal.criteria.map((c) => ({ id: c.id, met: false, evidence: reason })),
    unmet: goal.criteria.map((c) => c.id),
    confidence: 0,
    reason,
  };
}
