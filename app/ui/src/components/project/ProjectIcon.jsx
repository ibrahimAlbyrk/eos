import { IconGlyph } from "../../lib/projectIcons.jsx";

// A project's chosen icon (emoji, or a library glyph in its swatch color); no
// icon → the plain folder glyph in the surrounding text color.
export function ProjectIcon({ icon, size = 14 }) {
  if (icon?.kind === "emoji") {
    return <span className="proj-icon proj-icon--emoji" style={{ fontSize: size, width: size + 2, height: size + 2 }}>{icon.value}</span>;
  }
  return (
    <span className="proj-icon" style={icon?.color ? { color: icon.color } : undefined}>
      <IconGlyph id={icon?.kind === "icon" ? icon.value : "folder"} size={size} />
    </span>
  );
}
