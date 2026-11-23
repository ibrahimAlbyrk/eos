// Asking the core what a sentence means, when the dashboard's own rules are
// not sure (08 §4.4): 250 ms after the last keystroke, through 01's intent
// route, each request with a rising `seq`. An answer applies only while its
// `seq` is the latest and the text it was asked for is still the text;
// a newer keystroke makes any answer on its way stale. Repeats answer at once
// from the last 50 readings. Past 400 ms the line says "Reading…"; with no
// answer in 4.5 s (the core's 4 s model timeout plus transport) the input
// gives up and offers choices.

export const ASK_AFTER_MS = 250;
export const READING_AFTER_MS = 400;
export const GIVE_UP_MS = 4500;
export const KEPT_READINGS = 50;

// What the reading depends on: the text, normalised, and what came with it.
export function intentKey({ text, attachments = [], forced = null, routineId = null }) {
  return JSON.stringify([text.trim().toLowerCase().replace(/\s+/g, " "), attachments.map((a) => a.value), forced, routineId]);
}

const written = (item) => item?.url ?? item?.path ?? item?.text ?? item?.key ?? null;

// The core's IntentAnswer as the input reads it: the same shape as
// `readIntent`'s, each choice keeping the core's line.
export function readingOf(answer) {
  const alternatives = (answer.alternatives ?? []).map((a) => ({ intent: a.intent, routineId: a.routineId ?? null, item: null, line: a.line }));
  const certain = answer.certain === true && answer.intent !== "unsure";
  if (!certain && answer.intent !== "unsure" && !alternatives.some((a) => a.intent === answer.intent && a.routineId === (answer.routineId ?? null))) {
    alternatives.unshift({ intent: answer.intent, routineId: answer.routineId ?? null, item: written(answer.item), line: answer.line });
  }
  return {
    intent: certain ? answer.intent : "unsure",
    certain,
    routineId: answer.routineId ?? null,
    item: written(answer.item),
    line: answer.line,
    alternatives,
  };
}

// `send(body)` posts the intent request and answers the client's envelope;
// `onChange()` is called whenever `state()` changes.
export function createIntentAsker(send, onChange) {
  const kept = new Map();
  let seq = 0;
  let current = null;
  let timers = [];
  let state = { key: null, status: "idle", reading: null };

  const set = (next) => {
    state = next;
    onChange();
  };
  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
  };
  const answered = (key, reading) => {
    kept.delete(key);
    kept.set(key, reading);
    if (kept.size > KEPT_READINGS) kept.delete(kept.keys().next().value);
    clearTimers();
    set({ key, status: "answered", reading });
  };
  const failed = (key) => {
    if (current !== key || state.status === "answered") return;
    clearTimers();
    set({ key, status: "failed", reading: null });
  };

  function ask(asked) {
    const key = intentKey(asked);
    if (key === current) return;
    clearTimers();
    seq += 1;
    current = key;
    if (kept.has(key)) return answered(key, kept.get(key));
    set({ key, status: "waiting", reading: null });
    timers.push(setTimeout(() => {
      const mine = ++seq;
      const body = { text: asked.text, attachments: asked.attachments ?? [], seq: mine };
      if (asked.forced) body.forced = asked.forced;
      if (asked.routineId) body.routineId = asked.routineId;
      Promise.resolve(send(body)).catch(() => null).then((r) => {
        if (mine !== seq || current !== key) return;
        if (r?.ok && r.body?.seq === mine) answered(key, readingOf(r.body));
        else failed(key);
      });
    }, ASK_AFTER_MS));
    timers.push(setTimeout(() => {
      if (current === key && state.status === "waiting") set({ ...state, status: "slow" });
    }, READING_AFTER_MS));
    timers.push(setTimeout(() => failed(key), GIVE_UP_MS));
  }

  // The rules are sure again, or the text is gone: nothing waits.
  function stop() {
    if (current === null) return;
    clearTimers();
    seq += 1;
    current = null;
    set({ key: null, status: "idle", reading: null });
  }

  return { ask, stop, state: () => state };
}
