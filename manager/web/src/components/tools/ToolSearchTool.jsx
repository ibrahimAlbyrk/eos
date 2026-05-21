import { memo, useMemo } from "react";
import { stripMcpPrefix, toolFamily } from "../../lib/format.js";
import { Icon } from "../primitives.jsx";
import { ToolShell } from "./ToolShell.jsx";
import { resultStatus } from "./shared.js";

// Parse the ToolSearch query string into a structured intent so we can
// render the user's request as labeled chips instead of a raw blob.
function parseQuery(q) {
  const raw = String(q || "").trim();
  if (!raw) return { mode: "empty", terms: [], required: [] };
  if (raw.toLowerCase().startsWith("select:")) {
    const names = raw.slice(7).split(/[,\s]+/).filter(Boolean);
    return { mode: "select", names, terms: [], required: [] };
  }
  // "+slack send" → required: ["slack"], terms: ["send"]
  const tokens = raw.split(/\s+/).filter(Boolean);
  const required = [];
  const terms = [];
  for (const t of tokens) {
    if (t.startsWith("+") && t.length > 1) required.push(t.slice(1));
    else terms.push(t);
  }
  return { mode: required.length > 0 ? "required" : "keyword", terms, required };
}

// Pull tool definitions out of the result body. The schema-loading tool
// returns each loaded tool as `<function>{...}</function>`; we extract the
// JSON and surface name + description for the card.
function parseTools(body) {
  if (!body) return [];
  const out = [];
  const re = /<function>(\{[\s\S]*?\})<\/function>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      out.push({
        name: String(obj.name || ""),
        description: String(obj.description || "").trim(),
      });
    } catch {}
  }
  // Fallback: bare lines that mention `name: "X"` JSON keys when wrapper
  // markup is absent (rare, but keep the renderer useful even then).
  if (out.length === 0) {
    const nameRe = /"name"\s*:\s*"([^"]+)"/g;
    let nm;
    while ((nm = nameRe.exec(body)) !== null) {
      out.push({ name: nm[1], description: "" });
    }
  }
  return out;
}

// Map a tool name to an icon by reusing the existing per-family lookup —
// so list_workers gets the orchestrator icon, Read gets the read icon, etc.
function iconForLoaded(name) {
  const fam = toolFamily(name);
  const map = {
    read: "read", write: "filePlus", edit: "edit",
    bash: "terminal", search: "grep", web: "globe",
    task: "agentSpawn", orch: "spawn",
    todo: "checkSquare", plan: "scroll",
    toolsearch: "search", generic: "tool",
  };
  return map[fam] || "tool";
}

export const ToolSearchTool = memo(function ToolSearchTool({ tool, result, family }) {
  const status = resultStatus(result);
  const rawQuery = tool.input?.query || "";
  const maxResults = tool.input?.max_results;
  const parsed = useMemo(() => parseQuery(rawQuery), [rawQuery]);
  const loaded = useMemo(() => parseTools(result?.body || ""), [result]);

  const modeLabel = parsed.mode === "select" ? "select"
                  : parsed.mode === "required" ? "required"
                  : parsed.mode === "keyword" ? "keyword"
                  : "—";

  const subtitle = (
    <span className="vb-tool__sub-grp">
      <span className="vb-toolsearch__mode">{modeLabel}</span>
      {parsed.mode === "select" && (
        <><span className="vb-tool__sub-sep">·</span><span>{parsed.names.length} {parsed.names.length === 1 ? "name" : "names"}</span></>
      )}
      {(parsed.mode === "keyword" || parsed.mode === "required") && parsed.terms.length + parsed.required.length > 0 && (
        <><span className="vb-tool__sub-sep">·</span><span>{parsed.terms.length + parsed.required.length} {parsed.terms.length + parsed.required.length === 1 ? "term" : "terms"}</span></>
      )}
      {maxResults != null && (
        <><span className="vb-tool__sub-sep">·</span><span>max {maxResults}</span></>
      )}
      {loaded.length > 0 && (
        <><span className="vb-tool__sub-sep">·</span><span className="vb-tool__sub-add">{loaded.length} loaded</span></>
      )}
    </span>
  );

  const querySection = (
    <div className="vb-toolsearch__sect">
      <div className="vb-toolsearch__sect-h">query</div>
      <div className="vb-toolsearch__query">
        {parsed.mode === "select" && parsed.names.map((n, i) => (
          <span key={i} className="vb-toolsearch__qchip vb-toolsearch__qchip--name">
            <Icon name={iconForLoaded(n)} size={11} />
            <code>{stripMcpPrefix(n)}</code>
          </span>
        ))}
        {parsed.required.map((t, i) => (
          <span key={`r${i}`} className="vb-toolsearch__qchip vb-toolsearch__qchip--req">
            <span className="vb-toolsearch__qchip-mark">+</span>
            <span>{t}</span>
          </span>
        ))}
        {parsed.terms.map((t, i) => (
          <span key={`t${i}`} className="vb-toolsearch__qchip vb-toolsearch__qchip--term">
            <span>{t}</span>
          </span>
        ))}
        {parsed.mode === "empty" && (
          <span className="vb-toolsearch__empty">no query</span>
        )}
      </div>
    </div>
  );

  const loadedSection = loaded.length > 0 ? (
    <div className="vb-toolsearch__sect">
      <div className="vb-toolsearch__sect-h">loaded</div>
      <div className="vb-toolsearch__list">
        {loaded.map((t, i) => {
          const display = stripMcpPrefix(t.name);
          return (
            <div key={i} className="vb-toolsearch__row">
              <span className="vb-toolsearch__row-icon"><Icon name={iconForLoaded(t.name)} size={12} /></span>
              <div className="vb-toolsearch__row-main">
                <code className="vb-toolsearch__row-name">{display}</code>
                {t.description && (
                  <div className="vb-toolsearch__row-desc">
                    {t.description.length > 220 ? t.description.slice(0, 220) + "…" : t.description}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  ) : null;

  const body = (
    <div className="vb-toolbody vb-toolbody--toolsearch">
      {querySection}
      {loadedSection}
    </div>
  );

  return (
    <ToolShell
      family={family}
      icon="search"
      title={
        <span className="vb-tool__name">
          <span className="vb-tool__verb">ToolSearch</span>
          <span className="vb-tool__arr">›</span>
          <span className="vb-toolsearch__qstr">{rawQuery}</span>
        </span>
      }
      subtitle={subtitle}
      status={status}
      defaultOpen={loaded.length > 0 && loaded.length <= 8}
      body={body}
    />
  );
});
