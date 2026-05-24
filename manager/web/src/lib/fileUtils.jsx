const EXT_LANG = {
  js: "javascript", jsx: "javascript", mjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript",
  json: "json", json5: "json",
  md: "markdown", mdx: "markdown",
  css: "css", scss: "scss", less: "less",
  html: "xml", htm: "xml", xml: "xml", svg: "xml",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  cs: "csharp",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  swift: "swift",
  sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql",
  yaml: "yaml", yml: "yaml",
  toml: "ini",
  ini: "ini",
  lua: "lua",
  r: "r",
  php: "php",
  pl: "perl",
  diff: "diff", patch: "diff",
  makefile: "makefile",
  dockerfile: "bash",
  graphql: "graphql", gql: "graphql",
};

export function extToLang(filePath) {
  if (!filePath) return null;
  const name = filePath.split("/").pop().toLowerCase();
  if (name === "makefile" || name === "dockerfile") return EXT_LANG[name.toLowerCase()] ?? null;
  const ext = name.split(".").pop();
  return EXT_LANG[ext] ?? null;
}

export function findAll(text, query) {
  if (!query) return [];
  const lc = text.toLowerCase();
  const qLc = query.toLowerCase();
  const results = [];
  let idx = lc.indexOf(qLc);
  while (idx !== -1) {
    results.push(idx);
    idx = lc.indexOf(qLc, idx + 1);
  }
  return results;
}

export function highlightMatches(line, query, lineIdx, currentMatch, matches, fullText) {
  if (!query || !matches.length) return line;
  const qLen = query.length;
  const lines = fullText.split("\n");
  let lineStart = 0;
  for (let i = 0; i < lineIdx; i++) lineStart += lines[i].length + 1;
  const lineEnd = lineStart + line.length;

  const hits = [];
  for (let mi = 0; mi < matches.length; mi++) {
    const pos = matches[mi];
    if (pos + qLen <= lineStart) continue;
    if (pos >= lineEnd) break;
    const from = Math.max(0, pos - lineStart);
    const to = Math.min(line.length, pos + qLen - lineStart);
    hits.push({ from, to, isCurrent: mi === currentMatch });
  }
  if (!hits.length) return line;

  const parts = [];
  let prev = 0;
  for (const h of hits) {
    if (h.from > prev) parts.push(line.slice(prev, h.from));
    parts.push(<mark key={h.from} className={"fv-match" + (h.isCurrent ? " current" : "")}>{line.slice(h.from, h.to)}</mark>);
    prev = h.to;
  }
  if (prev < line.length) parts.push(line.slice(prev));
  return parts;
}

export function shortenHome(p) {
  if (!p) return "";
  const home = "/Users/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf("/");
    return slash === -1 ? "~" : "~" + rest.slice(slash);
  }
  return p;
}
