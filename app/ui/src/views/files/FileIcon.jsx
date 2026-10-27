import { glyphInner } from "../../lib/fileGlyphs.js";

// Inline-SVG file-type glyphs (lib/fileGlyphs.js). Folders get open/closed
// variants; files are bucketed by extension. Color comes from the parent row's
// `color` so it follows the theme.
export function FileIcon({ type, name, expanded }) {
  return (
    <svg
      className={type === "directory" ? "fx-icon fx-icon--dir" : "fx-icon"}
      width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: glyphInner({ type, name, open: expanded }) }}
    />
  );
}
