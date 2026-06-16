import { fileKind } from "./fileKind.js";

// Path → composer attachment kind ("folder" | "image" | "file").
export function attachmentKind(path, isDir = false) {
  if (isDir) return "folder";
  return fileKind(path) === "image" ? "image" : "file";
}
