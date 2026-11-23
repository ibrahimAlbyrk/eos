import { useEffect, useMemo, useRef, useState } from "react";
import { ensureAccountsLoaded, useAccounts } from "../../../state/accountsStore.js";
import { setHomeDraft, setHomePick, useHomeDraft, useHomePick } from "../../../state/eos/homeDraftStore.js";
import { loadCandidates, useRoutines } from "../../../state/eos/routinesStore.js";
import { comboKey, withChosen } from "../runform/CandidateCombobox.jsx";
import { billsByRun, takesItems } from "../runform/runFormModel.js";
import { itemRows, menuRows } from "./CandidateList.jsx";
import { useIntent } from "./intent/useIntent.js";
import { homeForm, tokenLine, withText } from "./runInput.js";
import { useHomeActs } from "./useHomeActs.js";
import { useThingIntake } from "./useThingIntake.js";

const CLOSED = { open: true, active: -1 };

// Everything the Home input holds and does (08 §4.4): the text, the things
// handed in, the routine token with its form (the text is its item slot),
// the `/` menu and the token's candidates, the intent, and Enter. An act
// that took the text clears it, unless the user typed on meanwhile.
export function useHomeInput(cardRef) {
  const text = useHomeDraft();
  const picked = useHomePick();
  const routines = useRoutines().list;
  const { accounts } = useAccounts();
  const byId = useMemo(() => new Map((routines ?? []).map((r) => [r.id, r])), [routines]);
  const routine = picked ? byId.get(picked) ?? null : null;
  const intake = useThingIntake(cardRef);
  const acts = useHomeActs(byId);
  const [base, setBase] = useState(null);
  const [list, setList] = useState(CLOSED);
  const [items, setItems] = useState([]);
  const [focused, setFocused] = useState(false);
  const typedAt = useRef(text);
  typedAt.current = text;

  useEffect(() => { void ensureAccountsLoaded(); }, []);
  const takes = routine && takesItems(routine.takes);
  useEffect(() => {
    if (!takes || !focused) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      void loadCandidates(routine.id, text).then((found) => { if (live) setItems(found); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [takes, focused, routine?.id, text]);

  // The token's form, fresh for each routine picked.
  const form = routine ? withText(routine, base?.routineId === routine.id ? base.form : homeForm(routine), text) : null;
  const setForm = (next) => setBase({ routineId: routine.id, form: next });
  const cleared = (took, actedOn) => {
    if (!took) return;
    if (typedAt.current === actedOn) setHomeDraft("");
    intake.clear();
  };
  const intent = useIntent({
    text,
    things: intake.things,
    routines,
    routineId: picked,
    onAct: (choice, given) => {
      if (choice.intent === "menu") return setHomeDraft("/");
      void acts.act(choice, given).then((took) => cleared(took, text));
    },
  });

  const menu = !routine && text.trimStart().startsWith("/");
  const rows = menu ? menuRows(routines ?? [], text) : takes && focused && list.open ? itemRows(items) : [];
  const changing = routine && intent.chosen?.intent === "change";
  const plan = !billsByRun(accounts);
  const line = routine && form && !changing ? tokenLine(routine, form, { plan }) : null;
  const ready = intake.things.every((t) => t.status === "ready");

  const pick = (routineId) => {
    setHomePick(routineId);
    if (text.trimStart().startsWith("/")) setHomeDraft("");
  };
  const choose = (i) => {
    const row = rows[i];
    setList({ open: false, active: -1 });
    if (menu) return pick(row.routine.id);
    setForm(withChosen({ ...form, text: "" }, row.item, Boolean(routine.takes.many)));
    setHomeDraft("");
  };
  const runToken = () => {
    if (!line?.enter || !ready) return;
    const actedOn = text;
    void acts.run(routine, form).then((took) => {
      if (!took) return;
      setHomePick(null);
      cleared(true, actedOn);
    });
  };
  const enter = () => {
    if (!ready) return;
    if (acts.outcome?.repeat) return void acts.again().then((took) => took && routine && setHomePick(null));
    if (routine && !changing) return runToken();
    intent.enter();
  };

  function onKeyDown(e) {
    if (e.nativeEvent?.isComposing) return;
    if (rows.length > 0 && (e.key !== "Enter" || list.active >= 0)) {
      const next = comboKey({ open: list.open && rows.length > 0, active: list.active }, e.key, rows.length);
      if (next) {
        e.preventDefault();
        if (next.chosen !== undefined) choose(next.chosen);
        else setList(next);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (menu && rows.length > 0) choose(0);
      else enter();
    } else if (e.key === "Tab" && !e.altKey && !e.metaKey && !routine && intent.tab(e.shiftKey ? -1 : 1)) {
      e.preventDefault();
    } else if (e.key === "Backspace" && routine && text === "" && e.target.selectionStart === 0) {
      setHomePick(null);
    }
  }

  return {
    text,
    routine,
    form,
    setForm,
    byId,
    intake,
    intent,
    acts,
    rows,
    list,
    line,
    plan,
    canSend: ready && (routine ? Boolean(line?.enter) || Boolean(changing) : intent.chosen !== null || intent.verdict.kind === "waiting"),
    pick,
    choose,
    enter,
    onKeyDown,
    onChange(value) {
      setHomeDraft(value);
      intent.dispatch({ type: "typed" });
      setList(CLOSED);
      if (acts.outcome) acts.dismiss();
    },
    setFocused,
  };
}
