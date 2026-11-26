// Home's sample reads, drawn around `now` so the horizon always shows a day
// in progress (Main.dc.html): five runs today, two of them waiting for the
// user, Build Watch next within the half hour, three routines that
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
    run("rn-h2", PAPER, midnight + 300 * MIN, "done", { headline: "Issue 3 is ready. Nine stories, two from sources you starred." }),
    run("rn-h1", PR, midnight + 221 * MIN, "done", { headline: "Approved #479 and posted it." }),
    run("rn-h0", MAIL, midnight + 130 * MIN, "done", { headline: "Sorted 23 mails. Two from the publisher are summarised." }),
  ];
  return runs.filter((r) => r.createdAt <= now).sort((a, b) => b.createdAt - a.createdAt);
}

// The 05:00 after (step 1) or before (step -1) `from`; on weekdays only
// when asked, as PR Review's schedule runs.
export function at5(from, step, weekdays = false) {
  const d = new Date(from);
  d.setHours(5, 0, 0, 0);
  if (step > 0 ? d.getTime() <= from : d.getTime() > from) d.setDate(d.getDate() + step);
  while (weekdays && (d.getDay() === 0 || d.getDay() === 6)) d.setDate(d.getDate() + step);
  return d.getTime();
}

// Each routine's next run as its schedule says: PR Review on weekdays at
// 05:00, Morning Paper every day at 05:00, Build Watch every 30 minutes.
export function homeNext(now) {
  const halfHour = 30 * MIN;
  return [
    { routineId: PR, nextAt: at5(now, 1, true), sourcesOk: true },
    { routineId: PAPER, nextAt: at5(now, 1), sourcesOk: true },
    { routineId: BUILD, nextAt: Math.floor(now / halfHour) * halfHour + halfHour, sourcesOk: true },
  ];
}

export const HOME_PROFILE = { identity: { callName: "Ibrahim" } };
export const HOME_SUMMARY = {
  since: 0,
  counts: { handled: 31, waiting: 2, ignored: 4, heldBack: 0, failed: 0, missed: 0, late: 0 },
  byRoutine: {},
};
