// Where each routine's disc sits on the field (08 §4.5). Pure: coordinates
// are relative to the window's centre, angles in degrees clockwise from
// three o'clock (screen y grows downward).
//
// A ring's slots are found with the smallest disc of its tier, so a ring
// holds the same number of discs whatever their sizes.

const HOUR_MS = 60 * 60 * 1000;
/// A result newer than this, not yet opened, keeps a routine on ring 2.
const FRESH_MS = 12 * HOUR_MS;

const BASE_W = 1440;
const BASE_H = 900;
const RADII = [235, 390, 560];
const PREFERRED = [245, 325, 12];
/// Size bands by tier: [smallest, largest] for runs in the last 7 days.
const BANDS = [
  [104, 124],
  [104, 144],
  [76, 84],
];
const PROJECT_SIZE = 144;
const RUNS_FULL = 50;
const PITCH = 180;
const LABEL_HALF_W = 84;
const LABEL_H = 52;
const COMPACT = { d: 60, pitch: 84, halfW: 36, halfH: 30 };
/// The box discs keep to: away from the edges, the header and the legend.
const EDGE = 24;
const TOP = 70;
const BOTTOM = 64;
/// The input's zone, from its caption to its intent line.
const INPUT_PAD = 16;
const INPUT_TOP = -87;
const INPUT_BOTTOM = 111;
const RING_LABELS = [
  { ring: 1, text: "Needs you" },
  { ring: 2, text: "Working" },
  { ring: 3, text: "Quiet" },
];
/// Where a ring's name may sit, nearest its crest first: every ring is named
/// at its top where it can be, so the names read down one line as a scale;
/// a ring that runs out of the window is named where it comes back in.
const LABEL_ANGLES = [270, 260, 280, 250, 290, 240, 300, 230, 310, 220, 320, 210, 330, 200, 340, 190, 350, 180, 0];
/// The room a ring's name keeps from the window's edge and from a disc.
const LABEL_EDGE = { x: 60, y: 28 };
const LABEL_CLEAR = 16;
/// Paused for these reasons a routine is a problem the user must look at.
const PROBLEMS = new Set(["failures", "capability", "sign_in", "spend", "target_refused"]);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rad = (deg) => (deg * Math.PI) / 180;
const norm = (deg) => ((deg % 360) + 360) % 360;
const gap = (a, b) => {
  const d = Math.abs(norm(a) - norm(b));
  return Math.min(d, 360 - d);
};

/// What the field needs of a routine, from its row and what the dashboard
/// knows beside it: its open Needs-you items, whether its newest result is
/// fresh and unopened, and when it runs next.
export function discOf(row, { needs = 0, opened = false, nextAt = null, now = Date.now() } = {}) {
  const last = row.lastRun;
  const endedAt = last?.endedAt ?? null;
  const fresh = Boolean(endedAt) && now - endedAt < FRESH_MS && !opened;
  const problem = row.state === "paused" && PROBLEMS.has(row.pausedReason);
  const running = (row.activeRuns ?? 0) > 0;
  const tier = needs > 0 || problem ? 1 : running || fresh ? 2 : 3;
  return {
    id: row.id,
    name: row.name,
    tier,
    needs,
    running,
    fresh,
    nextAt,
    runs7d: row.runs7d ?? 0,
    project: row.kind === "project",
  };
}

/// Ring 1 first, then within a tier: Needs-you count, running before fresh,
/// next run time, name.
function byPlace(a, b) {
  return (
    b.needs - a.needs ||
    Number(b.running) - Number(a.running) ||
    Number(b.fresh) - Number(a.fresh) ||
    (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) ||
    a.name.localeCompare(b.name)
  );
}

/// The three rings' radii at this window size.
export const ringRadii = (W, H) => RADII.map((r) => r * scaleOf(W, H));

export function scaleOf(W, H) {
  return clamp(Math.min(W / BASE_W, H / BASE_H), 0.8, 1.25);
}

/// A disc's diameter: how much it does, in its tier's band.
export function sizeOf(disc, s) {
  if (disc.project) return PROJECT_SIZE * s;
  const [min, max] = BANDS[disc.tier - 1];
  const share = Math.min(1, Math.log2(1 + disc.runs7d) / Math.log2(1 + RUNS_FULL));
  return (min + (max - min) * share) * s;
}

/// A disc's footprint with its label, around centre (x, y).
function footprint(x, y, d, compact) {
  if (compact) return { x0: x - COMPACT.halfW, x1: x + COMPACT.halfW, y0: y - COMPACT.halfH, y1: y + COMPACT.halfH };
  return { x0: x - LABEL_HALF_W, x1: x + LABEL_HALF_W, y0: y - d / 2, y1: y + d / 2 + LABEL_H };
}

/// The angles of a ring where a disc of diameter `d` fits: inside the box
/// and clear of the input.
function slotsOf(ring, { W, H, inputWidth, s, d, compact }) {
  const R = RADII[ring - 1] * s;
  const pitch = compact ? COMPACT.pitch : PITCH;
  if (pitch >= 2 * R) return [];
  const step = (2 * Math.asin(pitch / (2 * R)) * 180) / Math.PI;
  const count = Math.floor(360 / step + 1e-9);
  const box = { x0: EDGE - W / 2, x1: W / 2 - EDGE, y0: TOP - H / 2, y1: H / 2 - BOTTOM };
  const input = { x0: -(inputWidth / 2 + INPUT_PAD), x1: inputWidth / 2 + INPUT_PAD, y0: INPUT_TOP, y1: INPUT_BOTTOM };
  const slots = [];
  for (let j = 0; j < count; j += 1) {
    const angle = norm(PREFERRED[ring - 1] + j * step);
    const x = R * Math.cos(rad(angle));
    const y = R * Math.sin(rad(angle));
    const f = footprint(x, y, compact ? COMPACT.d * s : d, compact);
    const inBox = f.x0 >= box.x0 && f.x1 <= box.x1 && f.y0 >= box.y0 && f.y1 <= box.y1;
    const overInput = f.x0 < input.x1 && f.x1 > input.x0 && f.y0 < input.y1 && f.y1 > input.y0;
    if (inBox && !overInput) slots.push({ angle, x, y });
  }
  return slots;
}

/// The preferred angle first, then the slot nearest its opposite, then
/// outward from both by turns: nearest first, the preferred side before the
/// opposite on a tie.
function fillOrder(slots, preferred) {
  if (slots.length === 0) return [];
  const rest = [...slots];
  const take = (target) => {
    let best = 0;
    rest.forEach((slot, i) => {
      if (gap(slot.angle, target) < gap(rest[best].angle, target)) best = i;
    });
    return rest.splice(best, 1)[0];
  };
  const order = [take(preferred)];
  if (rest.length) order.push(take(preferred + 180));
  const reach = (slot) => Math.min(gap(slot.angle, preferred), gap(slot.angle, preferred + 180));
  const side = (slot) => (gap(slot.angle, preferred) <= gap(slot.angle, preferred + 180) ? 0 : 1);
  rest.sort((a, b) => reach(a) - reach(b) || side(a) - side(b) || a.angle - b.angle);
  return order.concat(rest);
}

/// Places every routine's disc: `{ discs, plusDiscs, ringLabels, overflow,
/// fits }`. `fits` is false as soon as one routine has no disc of its own:
/// the field then opens as the List.
export function placeDiscs(routines, { W, H, inputWidth }) {
  const s = scaleOf(W, H);
  const discs = [];
  const plusDiscs = [];
  const overflow = { 1: 0, 2: 0, 3: 0 };
  for (const ring of [1, 2, 3]) {
    const members = routines.filter((r) => r.tier === ring).sort(byPlace);
    if (members.length === 0) continue;
    const smallest = BANDS[ring - 1][0] * s;
    let compact = false;
    let slots = fillOrder(slotsOf(ring, { W, H, inputWidth, s, d: smallest, compact }), PREFERRED[ring - 1]);
    if (ring === 3 && members.length > slots.length) {
      compact = true;
      slots = fillOrder(slotsOf(ring, { W, H, inputWidth, s, d: smallest, compact }), PREFERRED[ring - 1]);
    }
    const over = members.length > slots.length;
    const placed = over ? Math.max(0, slots.length - 1) : members.length;
    members.slice(0, placed).forEach((routine, i) => {
      const slot = slots[i];
      discs.push({
        id: routine.id,
        tier: ring,
        ring,
        angle: Math.round(slot.angle * 10) / 10,
        x: slot.x,
        y: slot.y,
        d: compact ? COMPACT.d * s : sizeOf(routine, s),
        compact,
      });
    });
    overflow[ring] = members.length - placed;
    if (over && slots.length > 0) {
      const slot = slots[slots.length - 1];
      plusDiscs.push({ tier: ring, ring, count: overflow[ring], angle: Math.round(slot.angle * 10) / 10, x: slot.x, y: slot.y });
    }
  }
  const covered = (x, y, m = 0) =>
    [...discs, ...plusDiscs.map((p) => ({ ...p, d: COMPACT.d * s, compact: true }))].some((disc) => {
      const f = footprint(disc.x, disc.y, disc.d, disc.compact);
      return x >= f.x0 - m && x <= f.x1 + m && y >= f.y0 - m && y <= f.y1 + m;
    });
  const inWindow = (x, y) => Math.abs(x) <= W / 2 - LABEL_EDGE.x && Math.abs(y) <= H / 2 - LABEL_EDGE.y;
  const ringLabels = RING_LABELS.map(({ ring, text }) => {
    const R = RADII[ring - 1] * s;
    const at = (angle) => ({ x: R * Math.cos(rad(angle)), y: R * Math.sin(rad(angle)) });
    const angle = LABEL_ANGLES.find((a) => {
      const p = at(a);
      return inWindow(p.x, p.y) && !covered(p.x, p.y, LABEL_CLEAR);
    });
    if (angle === undefined) return { ring, text, x: 0, y: 0, hidden: true };
    return { ring, text, ...at(angle), hidden: false };
  });
  const fits = overflow[1] + overflow[2] + overflow[3] === 0;
  return { discs, plusDiscs, ringLabels, overflow, fits };
}
