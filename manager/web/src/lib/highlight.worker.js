// Web Worker host for highlightTokens — keeps Lezer parses of diff hunks off
// the main thread. Protocol: {id, code, filePath} in, {id, lines} out.

import { highlightToTokenLines } from "./highlightTokens.js";

self.onmessage = (e) => {
  const { id, code, filePath } = e.data;
  let lines = null;
  try {
    lines = highlightToTokenLines(code, filePath);
  } catch {
    lines = null;
  }
  self.postMessage({ id, lines });
};
