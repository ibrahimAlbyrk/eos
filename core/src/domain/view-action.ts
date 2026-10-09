// A click on a visual answer's send action, as the model reads it and as the chat
// shows it. The model gets the label as the user's words, then one JSON line with
// what it needs to act on (the view, the action, the item, the view's state); the
// chat keeps only the label, rendered as a reply chip that links to the view.

import type { UserMessageAction, ViewAction } from "../../../contracts/src/genui/spec.ts";

export const VIEW_ACTION_PREFIX = "[view action]";

export interface ViewActionTurn {
  /** What the model reads. */
  text: string;
  /** What the chat shows. */
  displayText: string;
  /** What the stored user_message keeps. */
  action: UserMessageAction;
}

// `said` is the message text sent beside the action; it joins the model text only
// when it says more than the label (e.g. a send action's own templated text).
export function viewActionTurn(action: ViewAction, said?: string): ViewActionTurn {
  const label = action.label.trim() || action.actionId;
  const extra = said?.trim();
  const payload = {
    viewId: action.viewId,
    actionId: action.actionId,
    ...(action.item !== undefined ? { item: action.item } : {}),
    ...(action.state && Object.keys(action.state).length > 0 ? { state: action.state } : {}),
  };
  const lines = [`${VIEW_ACTION_PREFIX} ${label}`];
  if (extra && extra !== label) lines.push(extra);
  lines.push(JSON.stringify(payload));
  return {
    text: lines.join("\n"),
    displayText: label,
    action: { viewId: action.viewId, label, ...(action.viewTitle ? { viewTitle: action.viewTitle } : {}) },
  };
}
