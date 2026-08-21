import { fileKind } from "./fileKind.js";

// Path → composer attachment kind ("folder" | "image" | "file"). The browser
// element-picker adds a fourth kind, "element", but that one is structural —
// assigned at hand-off from a BrowserElement, never derived from a path — so it
// is not produced here.
export function attachmentKind(path, isDir = false) {
  if (isDir) return "folder";
  return fileKind(path) === "image" ? "image" : "file";
}
