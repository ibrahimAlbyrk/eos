// Warm-up on typing: a chat at rest (its agent process closed) gets its process
// booted when the user types in it, so it is ready by the time the message is
// sent. Only an edit counts — a draft left sitting in a chat that went to rest
// doesn't wake it. One request per rest period; the daemon ignores live chats.

const RESTING = new Set(["SUSPENDED", "DONE"]);

export function createWarmer(warm) {
  let warmedId = null;
  let lastText = "";
  return function onDraft(workerId, state, text) {
    const edited = text !== lastText;
    lastText = text;
    if (!workerId || !RESTING.has(state)) { warmedId = null; return; }
    if (!edited || !text.trim() || warmedId === workerId) return;
    warmedId = workerId;
    Promise.resolve(warm(workerId)).catch(() => {});
  };
}
