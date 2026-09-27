import type { PtyQuestionAnswer } from "../../../contracts/src/http.ts";

// Keystrokes that drive Claude Code's terminal UI, as ordered steps. Each step
// is written on its own with a pause after it (see stepGapMs): the TUI reads a
// burst of keys arriving together as one paste. Verified against Claude Code
// 2.1.x:
//   - A bracketed paste lands in the composer without submitting (multi-line
//     safe); Enter on its own then submits.
//   - AskUserQuestion: a single-select question's option digit picks it and
//     moves on; a multi-select's digits toggle and → moves on. "Type something"
//     is the digit after the last option: it focuses a text field, typed text +
//     Enter confirms. With several questions, or any multi-select, a review
//     step follows whose focused "Submit answers" takes Enter.
//   - ExitPlanMode: option 1 is always an approving "Yes".

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ENTER = "\r";
const RIGHT = "\x1b[C";

// Keys are only meant for Claude's TUI: once Claude exits, the pane is a shell
// again, where a pasted prompt + Enter would run as a command.
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "login"]);
export const isShellProcess = (name: string): boolean => SHELLS.has((name.split("/").pop() ?? "").replace(/^-/, ""));

export function stepGapMs(step: string): number {
  return step.startsWith(PASTE_START) ? 300 : 150;
}

export function promptSteps(text: string): string[] {
  return [PASTE_START + text + PASTE_END, ENTER];
}

export const approvePlanSteps = (): string[] => ["1"];

export interface AskQuestionShape {
  multiSelect: boolean;
  optionCount: number;
}

export class AnswerShapeError extends Error {}

const digit = (index: number): string => String(index + 1);

export function answerSteps(questions: AskQuestionShape[], answers: PtyQuestionAnswer[]): string[] {
  if (answers.length !== questions.length) throw new AnswerShapeError(`expected ${questions.length} answers, got ${answers.length}`);
  const steps: string[] = [];
  questions.forEach((q, i) => {
    // Digits address options, and one more digit is "Type something".
    if (q.optionCount > 8) throw new AnswerShapeError(`question ${i + 1} has too many options to select by key`);
    const a = answers[i];
    if ("text" in a) {
      if (q.multiSelect) throw new AnswerShapeError(`question ${i + 1} is multi-select: free text is not supported`);
      // A newline would confirm early; the field is single-line anyway.
      const text = a.text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
      if (!text) throw new AnswerShapeError(`question ${i + 1}: empty answer`);
      steps.push(digit(q.optionCount), text, ENTER);
      return;
    }
    const picks = [...new Set(a.options)];
    if (picks.some((o) => o >= q.optionCount)) throw new AnswerShapeError(`question ${i + 1}: no such option`);
    if (!q.multiSelect && picks.length !== 1) throw new AnswerShapeError(`question ${i + 1} takes exactly one option`);
    steps.push(...picks.map(digit));
    if (q.multiSelect) steps.push(RIGHT);
  });
  if (questions.length > 1 || questions.some((q) => q.multiSelect)) steps.push(ENTER);
  return steps;
}
