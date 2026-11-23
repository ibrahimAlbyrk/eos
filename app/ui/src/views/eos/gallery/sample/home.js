// Home's sample reads, drawn around `now` so the horizon always shows a day
// in progress (Main.dc.html): five runs today, two of them waiting for the
// user, PR Review and Morning Paper scheduled later, three routines that
// finished overnight and 31 things handled.

const MIN = 60 * 1000;
const PR = "rt-4k2n8q1x7m3p";
const PAPER = "rt-7b3m1c9d0e4f";
const MAIL = "rt-2x8k5n1q6w0r";
const BUILD = "rt-9q4w2e7r1t5y";

function run(id, routineId, at, state, fields = {}) {
  const ended = state === "done" || state === "failed";
  return {
    id,
    routineId,
    kind: "standing",
    origin: "trigger",
    state,
    needsUser: state === "waiting_for_user",
    costUsd: 0.3,
    workMs: 180000,
    createdAt: at,
    startedAt: at,
    ...(ended ? { endedAt: at + 3 * MIN } : {}),
    ...fields,
  };
}

export function homeRuns(now) {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const runs = [
    run("rn-h5", PR, now - 64 * MIN, "waiting_for_user", { itemTitle: "#482 Fix pooled particle leak", headline: "Review ready for #482." }),
    run("rn-h4", PR, now - 142 * MIN, "waiting_for_user", { itemTitle: "#481 Shop carousel snaps", headline: "Review ready for #481." }),
    run("rn-h3", BUILD, now - 190 * MIN, "done", { headline: "The nightly build passed on main." }),
    run("rn-h2", PAPER, midnight + 300 * MIN, "done", { headline: "Issue 41 is ready. Nine stories, two from sources you starred." }),
    run("rn-h1", PR, midnight + 221 * MIN, "done", { headline: "Approved #479 and posted it." }),
    run("rn-h0", MAIL, midnight + 130 * MIN, "done", { headline: "Sorted 23 mails. Two from the publisher are summarised." }),
  ];
  return runs.filter((r) => r.createdAt <= now).sort((a, b) => b.createdAt - a.createdAt);
}

export function homeNext(now) {
  return [
    { routineId: PR, nextAt: now + 120 * MIN, sourcesOk: true },
    { routineId: PAPER, nextAt: now + 330 * MIN, sourcesOk: true },
  ];
}

export const HOME_PROFILE = { identity: { callName: "Ada" } };
export const HOME_SUMMARY = {
  since: 0,
  counts: { handled: 31, waiting: 2, ignored: 4, heldBack: 0, failed: 0, missed: 0, late: 0 },
  byRoutine: {},
};
