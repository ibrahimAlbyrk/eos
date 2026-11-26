// Morning Paper's issues as the core hands them in when they did not fit the
// kept layout: an issue of kind "fallback" whose body is the plain View
// crates/eos-surface's render/fallback.rs builds: one Section per field of
// the contract holding a List, a row per item of a list (its first two texts
// as title and meta), per text of an object (its field's name as the meta)
// or for the one value. The gallery's page-redesign state reads these.
import paper from "./samplePaper.js";

const TEXT_CHARS = 2000;
const LIST_ITEMS = 30;

const text = (value) => {
  let t = null;
  if (typeof value === "string") t = value;
  else if (typeof value === "number") t = String(value);
  else if (value && typeof value === "object" && !Array.isArray(value) && typeof value.alt === "string") t = value.alt;
  t = t?.trim();
  return t ? t.slice(0, TEXT_CHARS) : null;
};

const label = (name) => {
  const words = name.replace(/[^\p{L}\p{N}]/gu, " ").trim().split(/\s+/).join(" ");
  return words ? words[0].toUpperCase() + words.slice(1) : "";
};

const list = (said, key) => `<Section title="${said}"><List of="${key}" title="{title}" meta="{meta}"/></Section>\n`;

const row = (item, i) => {
  const texts = item && typeof item === "object" ? Object.values(item).map(text).filter(Boolean) : [text(item)].filter(Boolean);
  return { id: i, title: texts[0] ?? "", meta: texts[1] ?? "" };
};

export function fallbackView(title, names, data) {
  let ui = "";
  const viewData = {};
  let summary = null;
  for (const name of names) {
    const value = data[name];
    if (value == null) continue;
    const key = `f${Object.keys(viewData).length}`;
    const said = label(name);
    if (Array.isArray(value)) {
      const rows = value.slice(0, LIST_ITEMS).map(row);
      if (!rows.length) continue;
      ui += list(said, key);
      viewData[key] = rows;
    } else if (typeof value === "object") {
      const rows = Object.entries(value).map(([k, v]) => [label(k), text(v)]).filter(([, t]) => t).map(([meta, t], i) => ({ id: i, title: t, meta }));
      if (!rows.length) continue;
      summary ??= rows[0].title;
      ui += list(said, key);
      viewData[key] = rows;
    } else {
      const t = text(value);
      if (!t) continue;
      summary ??= t;
      ui += list(said, key);
      viewData[key] = [{ id: 0, title: t, meta: "" }];
    }
  }
  return { title, summary: summary ? summary.slice(0, 200) : "Shown plainly.", ui: ui || "<Text>This issue holds nothing to show.</Text>", data: viewData };
}

const CONTRACT = Object.keys(paper.versionBodies["2"].body.contract.fields);

// Issue 3 as its frame prints it (the lead, the desk, the starred links and
// the three sections), with the lead's long body the layout could not hold.
const ISSUE_3 = {
  title: "The Morning Build",
  summary: "Nine stories from 31 sources · about 14 minutes",
  lead: {
    section: "engineering",
    title: "Deterministic replays are back in fashion for puzzle games",
    dek: "Recording inputs instead of state turns a bug report into something you can run. Three teams describe what it cost them and what they stopped doing afterwards.",
    body: "The idea is old, the reason it returned is new: with input logs small enough to attach to every crash, the question changes from \"can you reproduce it\" to \"which frame\". Two of the three teams now refuse a bug report without one.",
    url: "https://example.com/replays",
  },
  desk: "One review waits for your signature. It blocks the login fix.",
  starred: [
    { title: "A long post on shader variant stripping, with numbers.", url: "https://example.com/shaders" },
    { title: "A talk on pacing procedural levels, now with slides.", url: "https://example.com/pacing" },
  ],
  left_out: "Fourteen funding and hiring stories. You have skipped that section for three weeks.",
  stories: [
    { section: "engine", title: "What changed in batching this week", dek: "Two changes you may feel in draw calls, and the settings to check in your own project.", url: "https://example.com/batching" },
    { section: "tools", title: "A level editor pattern worth copying", dek: "Undo as a list of commands. It is the step your Level Editor routine is building right now.", url: "https://example.com/undo" },
    { section: "live-ops", title: "Shorter events, more of them", dek: "Why some teams moved from two-week events to four-day ones, and what it did to their calendar.", url: "https://example.com/events" },
  ],
};

const PLAIN = { "si-7b3m1c000003": ISSUE_3, "si-7b3m1c000002": paper.issueBodies["si-7b3m1c000002"].body.data };

const asFallback = (issue) => (PLAIN[issue.id] ? { ...issue, kind: "fallback" } : issue);

// The reads of a page whose last two issues came as plain cards.
export function withPlainIssues(s, routes, surfaceId) {
  const list = `${routes.surfaceIssues(surfaceId)}?limit=20`;
  const bodies = Object.fromEntries(Object.entries(PLAIN).map(([id, data]) => {
    const issue = asFallback(paper.issueBodies[id].issue);
    return [routes.surfaceIssue(surfaceId, id), { issue, body: { view: fallbackView(paper.surface.title, CONTRACT, data), problems: ["lead.body"] } }];
  }));
  return { ...s, [list]: { ...s[list], issues: s[list].issues.map(asFallback) }, ...bodies };
}
