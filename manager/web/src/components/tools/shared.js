// Helpers shared across tool renderers.

export function resultStatus(result) {
  if (!result) return { tone: "run", label: "running" };
  if (result.type === "error") return { tone: "err", label: "err" };
  return { tone: "ok", label: "ok" };
}

export function tryParseJson(s) {
  if (typeof s !== "string") return null;
  try { return JSON.parse(s); } catch { return null; }
}

// Extract a basename + parent dir display from an absolute path.
export function splitPath(p) {
  if (!p) return { dir: "", file: "" };
  const slash = p.lastIndexOf("/");
  return { dir: slash >= 0 ? p.slice(0, slash) : "", file: slash >= 0 ? p.slice(slash + 1) : p };
}

// Guess a fenced-code language label from a filename so the diff/code panes
// can colorize. Falls back to "" which highlight.js auto-detects.
export function langFromPath(path) {
  if (!path) return "";
  const m = /\.([a-zA-Z0-9]+)(?:$|\?)/.exec(path);
  if (!m) return "";
  const ext = m[1].toLowerCase();
  const map = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    sh: "bash", zsh: "bash", bash: "bash",
    json: "json", yml: "yaml", yaml: "yaml", toml: "toml",
    md: "markdown", html: "xml", xml: "xml", svg: "xml",
    css: "css", scss: "scss",
    sql: "sql",
  };
  return map[ext] || ext;
}

export function formatBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kb`;
  return `${(n / (1024 * 1024)).toFixed(1)} mb`;
}

export function lineCount(s) {
  if (!s) return 0;
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  if (trimmed.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < trimmed.length; i++) if (trimmed.charCodeAt(i) === 10) n++;
  return n;
}
