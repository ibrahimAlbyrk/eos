import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ROUTES } from "../../../../api/routes.js";
import { transport } from "../../../../state/eos/transport.js";
import { createIntentAsker } from "./intentAsk.js";
import { initialInput, inputReducer, TAB_CYCLES_CHOICES } from "./inputReducer.js";
import { readIntent } from "./localIntent.js";
import { actionable, needsCore, optionsOf, verdictOf } from "./verdict.js";

const askCore = (body) => transport.send("POST", ROUTES.routinesIntentModel, body);

// The intent of what the Home input holds (08 §4.4): the rules' reading in
// the same render as the keystroke, the core's when the rules are not sure,
// and Enter, which acts only on a certain reading or a choice the user moved
// to. An Enter pressed while the core decides acts when a clear answer comes,
// and shows the choices when it does not. `onAct(choice)` does the act.
export function useIntent({ text, things, routines, routineId = null, onAct }) {
  const [input, dispatch] = useReducer(inputReducer, initialInput);
  const [, rerender] = useState(0);
  const askerRef = useRef(null);
  askerRef.current ??= createIntentAsker(askCore, () => rerender((n) => n + 1));
  const asker = askerRef.current;

  const attachments = useMemo(() => things.filter((t) => t.status === "ready").map((t) => ({ kind: t.kind, value: t.value })), [things]);
  const local = useMemo(
    () => readIntent({ text, attachments: attachments.map((a) => a.value), forced: input.forced, routineId }, routines ?? []),
    [text, attachments, input.forced, routineId, routines],
  );
  const asking = text.trim() !== "" && !text.trim().startsWith("/") && needsCore(local);

  useEffect(() => {
    if (asking) asker.ask({ text, attachments, forced: input.forced, routineId });
    else asker.stop();
  }, [asker, asking, text, attachments, input.forced, routineId]);
  useEffect(() => () => asker.stop(), [asker]);

  const verdict = verdictOf({ text, things, routineId, local, asked: asking ? asker.state() : { status: "idle" } });
  const options = optionsOf(verdict);
  const chosen = actionable(verdict, input);

  const act = (choice) => {
    dispatch({ type: "acted" });
    onAct?.(choice, { text: text.trim(), attachments });
  };

  // An Enter that waited for the core.
  useEffect(() => {
    if (!input.pendingEnter || verdict.kind === "waiting") return;
    if (chosen) act(chosen);
    else dispatch({ type: "settled" });
  });

  return {
    input,
    dispatch,
    verdict,
    options,
    chosen,
    enter() {
      if (chosen) act(chosen);
      else if (verdict.kind === "waiting") dispatch({ type: "enter" });
    },
    tab(step) {
      if (!TAB_CYCLES_CHOICES || options.length < 2) return false;
      dispatch({ type: "tab", step, count: options.length, sure: verdict.kind === "sure" });
      return true;
    },
    choose: act,
  };
}
