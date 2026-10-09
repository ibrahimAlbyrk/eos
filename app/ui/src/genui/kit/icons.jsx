// Icons for the kit. The catalog's icon= names come from the runtime's set
// (runtime/icons.jsx, shared with the view header); the glyphs only the kit
// draws itself (chevrons, copy, external, the rating star…) live here. Lucide
// geometry (ISC), 24×24 stroke art in currentColor.

import { GvIcon, hasIcon as hasCatalogIcon } from "../runtime/icons.jsx";

const P = (d) => <path d={d} />;

const GLYPHS = {
  "chevron-right": P("m9 18 6-6-6-6"),
  "chevron-left": P("m15 18-6-6 6-6"),
  "chevron-down": P("m6 9 6 6 6-6"),
  external: <>{P("M15 3h6v6")}{P("M10 14 21 3")}{P("M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6")}</>,
  navigation: <polygon points="3 11 22 2 13 21 11 13 3 11" />,
  copy: <><rect width="14" height="14" x="8" y="8" rx="2" ry="2" />{P("M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2")}</>,
  "x-circle": <><circle cx="12" cy="12" r="10" />{P("m15 9-6 6")}{P("m9 9 6 6")}</>,
  "check-circle": <><circle cx="12" cy="12" r="10" />{P("m9 12 2 2 4-4")}</>,
  "alert-octagon": <>{P("M12 16h.01")}{P("M12 8v4")}{P("M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z")}</>,
  play: <polygon points="6 3 20 12 6 21 6 3" />,
  "star-solid": <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />,
  package: <>{P("M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z")}{P("M12 22V12")}{P("m3.3 7 8.7 5 8.7-5")}</>,
  newspaper: <>{P("M15 18h-5")}{P("M18 14h-8")}{P("M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2")}<rect width="8" height="4" x="10" y="6" rx="1" /></>,
};

// Always painted, never stroked.
const FILLED = new Set(["play", "star-solid"]);

export function hasIcon(name) {
  return hasCatalogIcon(name) || (typeof name === "string" && Object.prototype.hasOwnProperty.call(GLYPHS, name));
}

export function Icon({ name, size = 16, stroke = 1.8, className }) {
  const cn = className ? `gv-icon ${className}` : "gv-icon";
  if (!Object.prototype.hasOwnProperty.call(GLYPHS, name ?? "")) {
    return hasCatalogIcon(name) ? <GvIcon name={name} size={size} strokeWidth={stroke} className={cn} /> : null;
  }
  const fill = FILLED.has(name);
  return (
    <svg
      className={cn}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
}
