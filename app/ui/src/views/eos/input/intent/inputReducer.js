// The Home input's own state (08 §4.4), beside its text: the mode the user
// forced, the routine token picked, which choice Tab moved to, and an Enter
// pressed while the core was still deciding.

// D39: Tab cycles the alternatives while there are two or more, announced
// as "Tab for other choices"; with one, Tab moves focus as usual.
export const TAB_CYCLES_CHOICES = true;

export const initialInput = { forced: null, routineId: null, tab: 0, tabbed: false, pendingEnter: false };

export function inputReducer(state, action) {
  switch (action.type) {
    case "typed":
      return { ...state, tab: 0, tabbed: false, pendingEnter: false };
    case "force":
      return { ...state, forced: action.intent, tab: 0, tabbed: false, pendingEnter: false };
    case "tab": {
      // With one choice Tab moves focus as usual (D39): the caller does not
      // send it.
      if (action.count < 2) return state;
      const from = state.tabbed || action.sure ? state.tab : action.step > 0 ? -1 : 0;
      return { ...state, tab: (from + action.step + action.count) % action.count, tabbed: true };
    }
    case "enter":
      return { ...state, pendingEnter: true };
    case "settled":
      return { ...state, pendingEnter: false };
    case "pick":
      return { ...state, routineId: action.routineId, forced: null, tab: 0, tabbed: false, pendingEnter: false };
    case "unpick":
      return { ...state, routineId: null, tab: 0, tabbed: false, pendingEnter: false };
    case "acted":
      return initialInput;
    default:
      return state;
  }
}

// The phase the input is in, for the screen around it: idle, text, menu
// (after `/`), token (a routine picked), waiting (the core asked), choices
// (unsure).
export function phaseOf(state, text, verdict) {
  if (state.routineId) return "token";
  if (verdict.kind === "menu") return "menu";
  if (verdict.kind === "waiting") return "waiting";
  if (verdict.kind === "choices" || verdict.kind === "failed") return "choices";
  return text.trim() === "" ? "idle" : "text";
}
