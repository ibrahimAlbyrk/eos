// Morning Paper's sample moved so its newest issue was printed this morning
// at 08:00, the two before on the days before: the paper, its pinned tile and
// Home read one day. Every time named `…At` moves, and the datelines the
// frames print ("Tuesday 18 November 2025") move with them.
import recorded from "./sample/paper.json";

const DAY_MS = 24 * 60 * 60 * 1000;

const newest = recorded.issues.issues[0].createdAt;
const morning = new Date();
morning.setHours(8, 0, 0, 0);
// Whole days, so each issue keeps its hour.
export const PAPER_SHIFT_MS = Math.round((morning.getTime() - newest) / DAY_MS) * DAY_MS;

const moved = (value) => {
  if (Array.isArray(value)) return value.map(moved);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k.endsWith("At") && typeof v === "number" ? v + PAPER_SHIFT_MS : moved(v)]));
};

const paper = moved(recorded);
export default paper;

const dateline = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const DATELINE = /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) (\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})/g;

// A frame's text with its datelines on the days the issues moved to.
export function movedDatelines(html) {
  return html.replace(DATELINE, (whole, _day, d, month, year) => {
    const at = Date.parse(`${d} ${month} ${year} 12:00`);
    return Number.isNaN(at) ? whole : dateline.format(new Date(at + PAPER_SHIFT_MS)).replace(",", "");
  });
}

// The issue as it goes out by mail, moved the same way and numbered as the
// paper's newest issue (the recorded mail came from another run, No. 41).
export const movedMail = (html) => movedDatelines(html).replace(/No\. 41\b/g, `No. ${recorded.issues.issues[0].seq}`);
