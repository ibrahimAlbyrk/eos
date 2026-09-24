// The project icon library (Icons tab of the project icon picker). Each glyph is
// 16×16 stroke art drawn with currentColor, so the chosen swatch tints it.

export const ICON_COLORS = ["#e8e8e8", "#ff6b6b", "#ff9f43", "#ffd43b", "#40c057", "#4dabf7", "#b197fc", "#f783ac"];
export const DEFAULT_ICON_COLOR = "#4dabf7";

const p = (d) => <path d={d} />;

export const PROJECT_ICONS = [
  { id: "folder", tags: "folder directory", el: p("M2 4.5A1.5 1.5 0 0 1 3.5 3h2.3l1.2 1.5h5.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z") },
  { id: "dollar", tags: "money finance dollar", el: <><circle cx="8" cy="8" r="6" />{p("M10 5.8c-.4-.5-1.1-.8-2-.8-1.1 0-2 .6-2 1.5S6.9 7.8 8 8s2 .6 2 1.5-.9 1.5-2 1.5c-.9 0-1.6-.3-2-.8M8 4v1M8 11v1")}</> },
  { id: "book", tags: "book read docs", el: p("M3 13.5v-10A1.5 1.5 0 0 1 4.5 2H13v10H4.5A1.5 1.5 0 0 0 3 13.5 1.5 1.5 0 0 0 4.5 15H13v-3") },
  { id: "school", tags: "school graduation learn", el: p("M1.5 6 8 3l6.5 3L8 9zM4 7.3V11c0 .8 1.8 2 4 2s4-1.2 4-2V7.3M14.5 6v4") },
  { id: "pencil", tags: "pencil edit write", el: p("M11.2 2.6 13.4 4.8 5.6 12.6 2.6 13.4l.8-3z") },
  { id: "pen", tags: "pen design vector", el: <>{p("M8 14 4.5 9.5 8 2l3.5 7.5zM8 2v5.5")}<circle cx="8" cy="8.7" r="1" /></> },
  { id: "code", tags: "code braces dev", el: p("M5.5 2.5c-1.5 0-2 .7-2 2v1.5c0 1-.5 1.5-1.5 2 1 .5 1.5 1 1.5 2v1.5c0 1.3.5 2 2 2M10.5 2.5c1.5 0 2 .7 2 2v1.5c0 1 .5 1.5 1.5 2-1 .5-1.5 1-1.5 2v1.5c0 1.3-.5 2-2 2") },
  { id: "terminal", tags: "terminal shell cli", el: <><rect x="2" y="3" width="12" height="10" rx="1.5" />{p("M5 6.5 7 8l-2 1.5M8.5 10h3")}</> },
  { id: "music", tags: "music audio sound", el: <>{p("M6 12V3.5l7-1.5v8.5")}<circle cx="4.5" cy="12" r="1.5" /><circle cx="11.5" cy="10.5" r="1.5" /></> },
  { id: "coffee", tags: "coffee cup drink", el: p("M3 6h8v4a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM11 7h1a1.5 1.5 0 0 1 0 3h-1M5 2.5V4M7.5 2.5V4") },
  { id: "brush", tags: "brush paint art", el: p("M13.5 2.5 7 9M7 9l-1.5-.5C4 8.5 3 9.5 3 11c0 1.2-.5 2-1 2.5 3 .5 5.5-.5 5.5-3z") },
  { id: "palette", tags: "palette color design", el: <>{p("M8 2a6 6 0 0 0 0 12c1 0 1.5-.6 1.5-1.3 0-.9-.8-1.2-.8-2s.6-1.2 1.3-1.2h1.5A2.5 2.5 0 0 0 14 7c0-2.8-2.7-5-6-5z")}<circle cx="5" cy="7" r=".8" /><circle cx="7.5" cy="4.5" r=".8" /><circle cx="10.5" cy="5.5" r=".8" /></> },
  { id: "health", tags: "health medical stethoscope", el: <>{p("M4 2.5H3v4a3 3 0 0 0 6 0v-4H8M6 9.5v1a3 3 0 0 0 6 0V9")}<circle cx="12" cy="7.5" r="1.5" /></> },
  { id: "game", tags: "game gamepad play", el: <><rect x="1.5" y="5" width="13" height="7" rx="3.5" />{p("M5 7.5v2M4 8.5h2")}<circle cx="10.5" cy="8" r=".6" /><circle cx="12" cy="9.5" r=".6" /></> },
  { id: "leaf", tags: "leaf nature plant eco", el: p("M3 13C3 6 7 3 13 3c0 6-3 10-10 10zM3 13l6-6") },
  { id: "briefcase", tags: "work briefcase business", el: <><rect x="2" y="5" width="12" height="8" rx="1.5" />{p("M5.5 5V3.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V5M2 9h12")}</> },
  { id: "chart", tags: "chart stats analytics", el: p("M2.5 13.5h11M4.5 11V8M8 11V4M11.5 11V6.5") },
  { id: "fitness", tags: "fitness gym dumbbell", el: p("M4 5v6M12 5v6M2 6.5v3M14 6.5v3M4 8h8") },
  { id: "doc", tags: "document file notes", el: p("M4 2h5l3 3v9H4zM9 2v3h3M6 8.5h4M6 11h4") },
  { id: "scale", tags: "law legal balance", el: p("M8 2.5v11M4.5 13.5h7M3 4.5h10M3 4.5 1.5 8.5a1.5 1.5 0 0 0 3 0zM13 4.5l-1.5 4a1.5 1.5 0 0 0 3 0z") },
  { id: "idea", tags: "idea lightbulb brain", el: p("M6 12.5h4M6.5 14.5h3M8 2a4 4 0 0 0-2.5 7.1c.4.4.5.8.5 1.4h3c0-.6.1-1 .5-1.4A4 4 0 0 0 8 2z") },
  { id: "plane", tags: "travel plane trip", el: p("M14 2 7 9M14 2l-4.5 12-2.5-5-5-2.5z") },
  { id: "globe", tags: "globe web world", el: <><circle cx="8" cy="8" r="6" />{p("M2 8h12M8 2c1.7 1.8 2.5 3.8 2.5 6S9.7 12.2 8 14c-1.7-1.8-2.5-3.8-2.5-6S6.3 3.8 8 2")}</> },
  { id: "wrench", tags: "tool wrench settings", el: p("M10.5 2.5a3 3 0 0 0-3.2 4L2.5 11.3a1.5 1.5 0 0 0 2.2 2.2L9.5 8.7a3 3 0 0 0 4-3.2l-1.8 1.8-1.9-.5-.5-1.9z") },
  { id: "paw", tags: "pet animal paw", el: <><circle cx="5" cy="6" r="1.2" /><circle cx="8" cy="4.5" r="1.2" /><circle cx="11" cy="6" r="1.2" />{p("M8 8.5c-2 0-3.5 2-3.5 3.5 0 1 .8 1.5 1.7 1.5.7 0 1.2-.3 1.8-.3s1.1.3 1.8.3c.9 0 1.7-.5 1.7-1.5 0-1.5-1.5-3.5-3.5-3.5z")}</> },
  { id: "flask", tags: "science lab flask", el: p("M6 2h4M6.5 2v4L3 12.5a1 1 0 0 0 .9 1.5h8.2a1 1 0 0 0 .9-1.5L9.5 6V2M4.5 10h7") },
  { id: "heart", tags: "heart love favorite", el: p("M8 13.5S2 10 2 6a3 3 0 0 1 6-1 3 3 0 0 1 6 1c0 4-6 7.5-6 7.5z") },
  { id: "plant", tags: "plant pot garden", el: p("M4 9h8l-1 5H5zM8 9V5M8 5c0-1.7-1.3-3-3-3 0 1.7 1.3 3 3 3zM8 6.5c0-1.7 1.3-3 3-3 0 1.7-1.3 3-3 3z") },
  { id: "star", tags: "star favorite", el: p("M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z") },
  { id: "rocket", tags: "rocket launch startup", el: p("M9.5 2.5h4v4L9 11 5 7zM5 7l-2 .5-1 2 3 .5M9 11l-.5 2-2 1-.5-3M4.5 11.5l-2 2") },
  { id: "camera", tags: "camera photo", el: <><rect x="1.5" y="4.5" width="13" height="9" rx="1.5" />{p("M5.5 4.5l1-2h3l1 2")}<circle cx="8" cy="9" r="2.5" /></> },
  { id: "home", tags: "home house", el: p("M2.5 7.5 8 3l5.5 4.5V13a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM6.5 14v-4h3v4") },
  { id: "package", tags: "package box cube", el: p("M8 1.8 13.5 5v6L8 14.2 2.5 11V5zM2.5 5 8 8.2 13.5 5M8 8.2v6") },
  { id: "database", tags: "database data storage", el: <><ellipse cx="8" cy="4" rx="5" ry="2" />{p("M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2")}</> },
  { id: "mobile", tags: "mobile phone app", el: <><rect x="4.5" y="1.5" width="7" height="13" rx="1.5" />{p("M7 12.5h2")}</> },
  { id: "bug", tags: "bug debug", el: p("M5.5 6.5a2.5 2.5 0 0 1 5 0V10a2.5 2.5 0 0 1-5 0zM8 6.5v6M3 8h2.5M10.5 8H13M3.5 5l2 1.5M12.5 5l-2 1.5M3.5 12l2-1.5M12.5 12l-2-1.5") },
];

const BY_ID = new Map(PROJECT_ICONS.map((i) => [i.id, i]));

export function IconGlyph({ id, size = 14 }) {
  const icon = BY_ID.get(id) ?? BY_ID.get("folder");
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      {icon.el}
    </svg>
  );
}
